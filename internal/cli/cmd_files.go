// The file commands: attach and upload.

package cli

import (
	"encoding/json"
	"fmt"
)

// attach uploads files and attaches each to a task, or to the decision or
// option named with decision=ID or option=ID.
func (r *runner) attach(in input) error {
	for _, p := range in.pos[1:] {
		fid, furl, err := r.c.Upload(r.ctx, p)
		if err != nil {
			return err
		}
		a, err := argsFrom(in.f)
		if err != nil {
			return err
		}
		a["file"] = fid
		if _, on := a["option"]; !on {
			if _, on := a["decision"]; !on {
				a["task"] = in.pos[0]
			}
		}
		if err := r.change("attachment.add", a, in.approval); err != nil {
			return err
		}
		fmt.Fprintln(r.out, furl)
	}
	return nil
}

// upload sends files and prints where each one is.
func (r *runner) upload(in input) error {
	for _, p := range in.pos {
		fid, furl, err := r.c.Upload(r.ctx, p)
		if err != nil {
			return err
		}
		if r.json {
			raw, _ := json.Marshal(map[string]string{"id": fid, "url": furl})
			fmt.Fprintln(r.out, string(raw))
			continue
		}
		fmt.Fprintf(r.out, "%s id=%s\n", furl, fid)
	}
	return nil
}

// uploads sends files and gives them back as a comment's attachments.
func (r *runner) uploads(paths []string) ([]map[string]any, error) {
	var out []map[string]any
	for _, p := range paths {
		fid, _, err := r.c.Upload(r.ctx, p)
		if err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"file": fid})
	}
	return out, nil
}
