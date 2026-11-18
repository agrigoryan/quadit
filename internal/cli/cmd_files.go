// The file commands: attach and upload.

package cli

import (
	"fmt"
	"os"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// attach uploads files and attaches each to a task, or to the decision or
// option named with decision=ID or option=ID. A dry run uploads nothing:
// it checks the files can be read and says where each would go.
func (r *runner) attach(in input) error {
	if r.dry {
		if err := readable(in.pos[1:]); err != nil {
			return err
		}
		for _, p := range in.pos[1:] {
			fmt.Fprintf(r.out, "would upload %s and attach it to %s\n", p, in.pos[0])
		}
		return nil
	}
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

// upload sends files and prints where each one is. A dry run sends
// nothing: it checks the files can be read.
func (r *runner) upload(in input) error {
	if r.dry {
		if err := readable(in.pos); err != nil {
			return err
		}
		for _, p := range in.pos {
			fmt.Fprintf(r.out, "would upload %s\n", p)
		}
		return nil
	}
	for _, p := range in.pos {
		fid, furl, err := r.c.Upload(r.ctx, p)
		if err != nil {
			return err
		}
		if r.json {
			raw := plainjson.Marshal(map[string]string{"id": fid, "url": furl})
			fmt.Fprintln(r.out, string(raw))
			continue
		}
		fmt.Fprintf(r.out, "%s id=%s\n", furl, fid)
	}
	return nil
}

// uploads sends files and gives them back as a comment's attachments. A
// dry run sends none and gives none back: it checks the files can be read
// and says each would be attached.
func (r *runner) uploads(paths []string) ([]map[string]any, error) {
	if r.dry {
		if err := readable(paths); err != nil {
			return nil, err
		}
		for _, p := range paths {
			fmt.Fprintf(r.out, "would upload and attach %s\n", p)
		}
		return nil, nil
	}
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

// readable says whether every file can be read, so that nothing is sent
// when one of them cannot.
func readable(paths []string) error {
	for _, p := range paths {
		h, err := os.Open(p)
		if err != nil {
			return fmt.Errorf("file %s: %w", p, err)
		}
		st, err := h.Stat()
		h.Close()
		if err != nil {
			return fmt.Errorf("file %s: %w", p, err)
		}
		if st.IsDir() {
			return fmt.Errorf("file %s is a folder", p)
		}
	}
	return nil
}
