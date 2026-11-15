// The decision commands: ask, approval, pick and unclear.

package cli

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// ask opens a decision on a task: a question with options or, called as
// approval, a yes or no to a change. Files given with file=PATH go up first
// and come with the question (see askFiles).
func (r *runner) ask(in input) error {
	a, err := decisionArgs(in)
	if err != nil {
		return err
	}
	labels, files := questionParts(fieldsInOrder(in.rest))
	if opts := options(labels); len(opts) > 0 {
		a["options"] = opts
	}
	if len(files) > 0 {
		return r.askWithFiles(a, files, in.approval)
	}
	return r.change("decision.open", a, in.approval)
}

// decisionArgs are a new decision's arguments from what was typed, less
// its options and files.
func decisionArgs(in input) (map[string]any, error) {
	a, err := argsFrom(in.f, "option", "why", "file")
	if err != nil {
		return nil, err
	}
	a["task"], a["question"] = in.pos[0], strings.Join(in.pos[1:], " ")
	if in.name == "approval" {
		a["kind"] = "approval"
		// args='{"id":"SVA-12"}': what exactly is to be approved.
		if raw := firstValue(in.f["args"]); raw != "" {
			var args map[string]any
			if err := json.Unmarshal([]byte(raw), &args); err != nil {
				return nil, fmt.Errorf("args must be a JSON object, the arguments the change will be sent with: %w", err)
			}
			a["args"] = args
		} else if _, ok := a["action"]; ok {
			a["args"] = map[string]any{"id": in.pos[0]} // the usual case: the action is on this task
		}
	}
	if w := in.f["why"]; len(w) > 0 {
		a["recommendation"] = w[0]
	}
	return a, nil
}

// options reads a question's options, each written option=LABEL or
// option=LABEL::DESCRIPTION.
func options(given []string) []map[string]any {
	var opts []map[string]any
	for _, o := range given {
		label, desc, _ := strings.Cut(o, "::")
		opt := map[string]any{"label": label}
		if desc != "" {
			opt["description"] = desc
		}
		opts = append(opts, opt)
	}
	return opts
}

// pick answers a decision: with one of its options, by number or label,
// or with an outcome.
func (r *runner) pick(in input) error {
	a, err := argsFrom(in.f)
	if err != nil {
		return err
	}
	a["id"] = in.pos[0]
	switch choice := strings.Join(in.pos[1:], " "); choice {
	case "approved", "declined", "none":
		a["outcome"] = choice
	default:
		if n, err := strconv.Atoi(choice); err == nil {
			a["option"] = n
		} else {
			a["option"] = choice
		}
	}
	return r.change("decision.pick", a, in.approval)
}

// unclear answers a decision by saying the question is not clear, and why.
func (r *runner) unclear(in input) error {
	return r.change("decision.unclear", map[string]any{"id": in.pos[0], "note": strings.Join(in.pos[1:], " ")}, in.approval)
}
