package server

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
)

// The ask tool: a question to a person in one call, as quadit ask and
// quadit approval are on the command line: a choice when it has options,
// a yes or no when it has none. Files are ids of
// files already stored with the upload tool; they go on the question or on
// an option, and the decision opens with them in one batch, so it is never
// seen without its pictures.

// askOption is one option as a client gives it.
type askOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
	Files       any    `json:"files"`
}

func toolAsk(s *Server, token string, a map[string]any) (string, bool) {
	open := map[string]any{"task": argText(a, "task"), "question": argText(a, "question")}
	for _, k := range []string{"details", "ask"} {
		if v := argText(a, k); v != "" {
			open[k] = v
		}
	}
	var opts []askOption
	if err := objectArg(a, "options", &opts); err != nil {
		return err.Error(), false
	}
	var onOptions [][]string
	var err error
	if len(opts) > 0 {
		onOptions = choiceArgs(a, open, opts)
	} else if err = approvalArgs(a, open); err != nil {
		return err.Error(), false
	}
	return s.askWithFiles(token, a, open, onOptions)
}

// choiceArgs adds a choice's options and recommendation to open, and gives
// each option's file ids in order.
func choiceArgs(a, open map[string]any, opts []askOption) [][]string {
	var onOptions [][]string
	var list []map[string]any
	for _, o := range opts {
		opt := map[string]any{"label": o.Label}
		if o.Description != "" {
			opt["description"] = o.Description
		}
		list = append(list, opt)
		onOptions = append(onOptions, idList(o.Files))
	}
	open["options"] = list
	if argText(a, "recommended") != "" {
		open["recommended"] = a["recommended"]
	}
	if v := argText(a, "why"); v != "" {
		open["recommendation"] = v
	}
	return onOptions
}

// approvalArgs makes open a yes or no, to an exact change when action names one.
func approvalArgs(a, open map[string]any) error {
	open["kind"] = "approval"
	action := argText(a, "action")
	if action == "" {
		return nil
	}
	open["action"] = action
	var args map[string]any
	if err := objectArg(a, "args", &args); err != nil {
		return err
	}
	if args == nil {
		args = map[string]any{"id": argText(a, "task")} // the usual case: the action is on this task
	}
	open["args"] = args
	return nil
}

// askWithFiles opens the decision with each option's files on it and the
// question's files attached, all in one batch. Given an id, every id in the
// batch comes from it, so sending the call again does nothing twice.
func (s *Server) askWithFiles(token string, a, open map[string]any, onOptions [][]string) (string, bool) {
	base := argText(a, "id")
	ids := func(parts ...string) string {
		if base == "" {
			return id.New()
		}
		return id.From(append([]string{base}, parts...)...)
	}
	open["id"] = ids("decision")
	if opts, ok := open["options"].([]map[string]any); ok {
		for i, files := range onOptions {
			var atts []map[string]any
			for j, f := range files {
				atts = append(atts, map[string]any{"id": ids("attachment", strconv.Itoa(i), strconv.Itoa(j)), "file": f})
			}
			if len(atts) > 0 {
				opts[i]["attachments"] = atts
			}
		}
	}
	first := ids("change", "decision.open")
	if base != "" {
		first = base
	}
	changes := []map[string]any{{"id": first, "type": "decision.open", "args": open}}
	for j, f := range idList(a["files"]) {
		changes = append(changes, map[string]any{"id": ids("change", "attach", strconv.Itoa(j)), "type": "attachment.add",
			"args": map[string]any{"id": ids("attachment", "question", strconv.Itoa(j)), "file": f, "decision": open["id"]}})
	}
	req := map[string]any{"changes": changes}
	if b, _ := a["dry_run"].(bool); b || argText(a, "dry_run") == "true" {
		req["dry_run"] = true
	}
	body, _ := json.Marshal(req)
	out, ok := s.callAPI(token, "POST", "/changes", nil, body)
	if !ok {
		return out, false
	}
	return askedText(out, idList(a["files"]), onOptions)
}

// askedText says in a few lines what the question became: the decision,
// then where each file went.
func askedText(out string, onQuestion []string, onOptions [][]string) (string, bool) {
	var res struct {
		Results []engine.Result `json:"results"`
		DryRun  bool            `json:"dry_run"`
	}
	if json.Unmarshal([]byte(out), &res) != nil || len(res.Results) == 0 {
		return out, true
	}
	r := res.Results[0]
	var b strings.Builder
	if res.DryRun {
		fmt.Fprintf(&b, "would be accepted: %s %s\n", r.Type, r.Key)
	} else {
		fmt.Fprintf(&b, "ok %s %s id=%s seq=%d\n", r.Type, r.Key, r.Ref, r.Seq)
	}
	for _, f := range onQuestion {
		fmt.Fprintf(&b, "file %s on the question\n", f)
	}
	for i, files := range onOptions {
		for _, f := range files {
			fmt.Fprintf(&b, "file %s on option %d\n", f, i+1)
		}
	}
	return b.String(), true
}

// objectArg reads an argument that is an object or a list into out,
// whether the client sent it as JSON or as JSON text.
func objectArg(a map[string]any, k string, out any) error {
	v, ok := a[k]
	if !ok || v == nil || v == "" {
		return nil
	}
	raw, _ := json.Marshal(v)
	if text, isText := v.(string); isText {
		raw = []byte(text)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s does not read as JSON of the right shape: %v", k, err)
	}
	return nil
}

// idList reads a list of file ids: a JSON list, or text with commas.
func idList(v any) []string {
	var out []string
	switch l := v.(type) {
	case []any:
		for _, e := range l {
			if s := strings.TrimSpace(fmt.Sprint(e)); s != "" {
				out = append(out, s)
			}
		}
	case string:
		var list []any
		if json.Unmarshal([]byte(l), &list) == nil {
			return idList(list)
		}
		for _, s := range strings.Split(l, ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}
