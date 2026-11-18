package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
)

// How a tool reaches the API, and the tools that do more than read one
// path: each takes the tool's arguments and answers with text and whether
// the call succeeded.

// caller is one tool call: the client's token, the request it came in
// (the call ends when that does), and how the API is reached.
type caller struct {
	ctx   context.Context
	token string
	api   API
}

// callAPI calls the API as the client, with a JSON body when there is one.
// It returns the answer's text and whether the call succeeded.
func (c caller) callAPI(method, path string, q url.Values, body []byte) (string, bool) {
	contentType := ""
	if body != nil {
		contentType = "application/json"
	}
	return c.api(c.ctx, c.token, method, path, q, body, contentType)
}

// callAPIWithBytes is callAPI for a body that is a file's bytes.
func (c caller) callAPIWithBytes(method, path string, q url.Values, body []byte) (string, bool) {
	return c.api(c.ctx, c.token, method, path, q, body, "application/octet-stream")
}

func toolAck(c caller, a map[string]any) (string, bool) {
	name := argText(a, "cursor")
	if name == "" {
		name = "main"
	}
	body := plainjson.Marshal(map[string]any{"seq": a["seq"]})
	return dryRunSaid(a, func(q url.Values) (string, bool) {
		return c.callAPI("PUT", "/cursors/"+url.PathEscape(name), q, body)
	})
}

func toolRemember(c caller, a map[string]any) (string, bool) {
	body := plainjson.Marshal(map[string]any{"title": a["title"], "markdown": a["markdown"], "mode": argText(a, "mode")})
	return dryRunSaid(a, func(q url.Values) (string, bool) {
		return c.callAPI("POST", "/memory", q, body)
	})
}

// dryRunSaid makes a write that is not a change, with dry_run=1 when the
// call asks for a dry run, and says so in front of the answer.
func dryRunSaid(a map[string]any, write func(q url.Values) (string, bool)) (string, bool) {
	if a["dry_run"] != true {
		return write(nil)
	}
	out, ok := write(url.Values{"dry_run": {"1"}})
	if ok {
		out = "would be accepted: " + out
	}
	return out, ok
}

// toolChange makes one change, or several together when changes lists them.
func toolChange(c caller, a map[string]any) (string, bool) {
	if list, ok := a["changes"].([]any); ok && len(list) > 0 {
		return toolChangeBatch(c, a, list)
	}
	if argText(a, "type") == "" {
		return "give type and args, or changes", false
	}
	cid := argText(a, "id")
	if cid == "" {
		cid = id.New()
	}
	req := map[string]any{"id": cid, "type": a["type"], "args": a["args"]}
	if v := argText(a, "for"); v != "" {
		req["for"] = v
	}
	if v := argText(a, "approval"); v != "" {
		req["approval"] = v
	}
	if a["dry_run"] == true {
		req["dry_run"] = true
	}
	if text, ok := a["args"].(string); ok { // some clients send the object as text
		var obj map[string]any
		if json.Unmarshal([]byte(text), &obj) == nil {
			req["args"] = obj
		}
	}
	body := plainjson.Marshal(req)
	out, ok := c.callAPI("POST", "/changes", nil, body)
	if !ok {
		return out, false
	}
	var res struct {
		Results []engine.Result `json:"results"`
		DryRun  bool            `json:"dry_run"`
	}
	if json.Unmarshal([]byte(out), &res) != nil || len(res.Results) == 0 {
		return out, true
	}
	r := res.Results[0]
	line := "ok " + r.Type
	if res.DryRun {
		line = "would be accepted: " + r.Type
	}
	if r.Key != "" {
		line += " " + r.Key
	}
	if r.Ref != "" {
		line += " id=" + r.Ref
	}
	return fmt.Sprintf("%s seq=%d", line, r.Seq), true
}

// toolChangeBatch makes the listed changes together. A batch: every change
// gets an id, and the answer is one line each.
func toolChangeBatch(c caller, a map[string]any, list []any) (string, bool) {
	for i, c := range list {
		if m, ok := c.(map[string]any); ok {
			if _, has := m["id"]; !has {
				m["id"] = id.New()
			}
			list[i] = m
		}
	}
	req := map[string]any{"changes": list}
	if a["dry_run"] == true {
		req["dry_run"] = true
	}
	body := plainjson.Marshal(req)
	out, ok := c.callAPI("POST", "/changes", nil, body)
	if !ok {
		return out, false
	}
	var res struct {
		Results []engine.Result `json:"results"`
	}
	if json.Unmarshal([]byte(out), &res) != nil {
		return out, true
	}
	var b strings.Builder
	for _, r := range res.Results {
		fmt.Fprintf(&b, "ok %s %s id=%s seq=%d\n", r.Type, r.Key, r.Ref, r.Seq)
	}
	return b.String(), true
}

func toolRender(c caller, a map[string]any) (string, bool) {
	q := url.Values{}
	for _, k := range []string{"task", "doc", "width", "theme"} {
		if v := argText(a, k); v != "" {
			q.Set(k, v)
		}
	}
	out, ok := c.callAPI("GET", "/render", q, nil)
	if !ok {
		return out, false
	}
	return pictureMark + base64.StdEncoding.EncodeToString([]byte(out)), true
}

func toolSecretRequest(c caller, a map[string]any) (string, bool) {
	req := map[string]any{"method": argText(a, "method"), "url": argText(a, "url"), "body": argText(a, "body")}
	switch h := a["headers"].(type) {
	case map[string]any:
		req["headers"] = h
	case string:
		if h != "" {
			var m map[string]string
			if json.Unmarshal([]byte(h), &m) != nil {
				return "headers must be a JSON object of strings", false
			}
			req["headers"] = m
		}
	}
	raw := plainjson.Marshal(req)
	return c.callAPI("POST", "/secrets/"+url.PathEscape(argText(a, "name"))+"/request", url.Values{"format": {"text"}}, raw)
}

// toolUpload stores a file sent whole, or one part of a file sent in several calls.
func toolUpload(c caller, a map[string]any) (string, bool) {
	if argText(a, "size") != "" || argText(a, "id") != "" {
		return uploadPart(c, a)
	}
	if argText(a, "name") == "" {
		return "give the file a name", false
	}
	data := []byte(argText(a, "text"))
	if b := argText(a, "base64"); b != "" {
		raw, err := base64.StdEncoding.DecodeString(b)
		if err != nil {
			return "base64 does not decode: " + err.Error(), false
		}
		data = raw
	}
	out, ok := c.callAPIWithBytes("POST", "/files", url.Values{"name": {argText(a, "name")}}, data)
	if !ok {
		return out, false
	}
	var f struct{ ID, URL string }
	if json.Unmarshal([]byte(out), &f) != nil {
		return out, true // stored; the answer is passed on as it came
	}
	return fmt.Sprintf("file id=%s %s", f.ID, f.URL), true
}

// uploadPart takes one part of a file that comes in several calls.
func uploadPart(c caller, a map[string]any) (string, bool) {
	raw, err := base64.StdEncoding.DecodeString(argText(a, "base64"))
	if err != nil {
		return "base64 does not decode: " + err.Error(), false
	}
	var out string
	var ok bool
	if fid := argText(a, "id"); fid != "" {
		out, ok = c.callAPIWithBytes("PATCH", "/files/"+url.PathEscape(fid), url.Values{"offset": {argText(a, "offset")}}, raw)
	} else {
		out, ok = c.callAPIWithBytes("POST", "/files", url.Values{"name": {argText(a, "name")}, "size": {argText(a, "size")}}, raw)
	}
	if !ok {
		return out, false
	}
	var f struct {
		ID, State, URL string
		Received, Size int64
	}
	if json.Unmarshal([]byte(out), &f) != nil {
		return out, true // taken; the answer is passed on as it came
	}
	if f.State == core.FileReady {
		return fmt.Sprintf("file id=%s ready %s", f.ID, f.URL), true
	}
	return fmt.Sprintf("file id=%s received %d of %d; send the next part with id and offset=%d", f.ID, f.Received, f.Size, f.Received), true
}
