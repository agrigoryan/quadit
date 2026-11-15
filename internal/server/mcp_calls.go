package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
)

// How a tool reaches the API, and the tools that do more than read one
// path: each takes the tool's arguments and answers with text and whether
// the call succeeded.

// callAPI calls the API from inside the server, as the bearer of token.
// It returns the answer's text and whether the call succeeded; a refusal
// comes back as its message, with the allowed values when there are any.
func (s *Server) callAPI(token, method, path string, q url.Values, body []byte) (string, bool) {
	who := bearerOf(token)
	if strings.HasPrefix(path, "/api/") {
		who.base = "" // a path outside the workspace is given whole
	}
	contentType := ""
	if body != nil {
		contentType = "application/json"
	}
	return answerText(s.selfCall(who, method, path, q, body, contentType))
}

// callAPIWithBytes is callAPI for a body that is a file's bytes.
func (s *Server) callAPIWithBytes(token, method, path string, q url.Values, body []byte) (string, bool) {
	return answerText(s.selfCall(bearerOf(token), method, path, q, body, "application/octet-stream"))
}

// answerText is what a tool makes of an in-process call's answer.
func answerText(ans *recordedAnswer, err error) (string, bool) {
	if err != nil {
		return err.Error(), false
	}
	if refused := ans.refusal(); refused != nil {
		return refused.Error(), false
	}
	return ans.body.String(), ans.status < 300
}

func toolAck(s *Server, token string, a map[string]any) (string, bool) {
	name := argText(a, "cursor")
	if name == "" {
		name = "main"
	}
	body, _ := json.Marshal(map[string]any{"seq": a["seq"]})
	return s.callAPI(token, "PUT", "/cursors/"+url.PathEscape(name), nil, body)
}

func toolRemember(s *Server, token string, a map[string]any) (string, bool) {
	body, _ := json.Marshal(map[string]any{"title": a["title"], "markdown": a["markdown"], "mode": argText(a, "mode")})
	return s.callAPI(token, "POST", "/memory", nil, body)
}

// toolChange makes one change, or several together when changes lists them.
func toolChange(s *Server, token string, a map[string]any) (string, bool) {
	if list, ok := a["changes"].([]any); ok && len(list) > 0 {
		return toolChangeBatch(s, token, a, list)
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
	if b, _ := a["dry_run"].(bool); b {
		req["dry_run"] = true
	}
	if text, ok := a["args"].(string); ok { // some clients send the object as text
		var obj map[string]any
		if json.Unmarshal([]byte(text), &obj) == nil {
			req["args"] = obj
		}
	}
	body, _ := json.Marshal(req)
	out, ok := s.callAPI(token, "POST", "/changes", nil, body)
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
func toolChangeBatch(s *Server, token string, a map[string]any, list []any) (string, bool) {
	for i, c := range list {
		if m, ok := c.(map[string]any); ok {
			if _, has := m["id"]; !has {
				m["id"] = id.New()
			}
			list[i] = m
		}
	}
	req := map[string]any{"changes": list}
	if b, _ := a["dry_run"].(bool); b {
		req["dry_run"] = true
	}
	body, _ := json.Marshal(req)
	out, ok := s.callAPI(token, "POST", "/changes", nil, body)
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

func toolRender(s *Server, token string, a map[string]any) (string, bool) {
	q := url.Values{}
	for _, k := range []string{"task", "doc", "width", "theme"} {
		if v := argText(a, k); v != "" {
			q.Set(k, v)
		}
	}
	out, ok := s.callAPI(token, "GET", "/render", q, nil)
	if !ok {
		return out, false
	}
	return pictureMark + base64.StdEncoding.EncodeToString([]byte(out)), true
}

func toolSecretRequest(s *Server, token string, a map[string]any) (string, bool) {
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
	raw, _ := json.Marshal(req)
	return s.callAPI(token, "POST", "/secrets/"+url.PathEscape(argText(a, "name"))+"/request", url.Values{"format": {"text"}}, raw)
}

// toolUpload stores a file sent whole, or one part of a file sent in several calls.
func toolUpload(s *Server, token string, a map[string]any) (string, bool) {
	if argText(a, "size") != "" || argText(a, "id") != "" {
		return s.uploadPart(token, a)
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
	out, ok := s.callAPIWithBytes(token, "POST", "/files", url.Values{"name": {argText(a, "name")}}, data)
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
func (s *Server) uploadPart(token string, a map[string]any) (string, bool) {
	raw, err := base64.StdEncoding.DecodeString(argText(a, "base64"))
	if err != nil {
		return "base64 does not decode: " + err.Error(), false
	}
	var out string
	var ok bool
	if fid := argText(a, "id"); fid != "" {
		out, ok = s.callAPIWithBytes(token, "PATCH", "/files/"+url.PathEscape(fid), url.Values{"offset": {argText(a, "offset")}}, raw)
	} else {
		out, ok = s.callAPIWithBytes(token, "POST", "/files", url.Values{"name": {argText(a, "name")}, "size": {argText(a, "size")}}, raw)
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
	if f.State == "ready" {
		return fmt.Sprintf("file id=%s ready %s", f.ID, f.URL), true
	}
	return fmt.Sprintf("file id=%s received %d of %d; send the next part with id and offset=%d", f.ID, f.Received, f.Size, f.Received), true
}
