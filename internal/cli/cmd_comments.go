// The comment commands: comment and result, reply, resolve and reopen, on
// tasks and on pages alike.

package cli

import (
	"errors"
	"strings"
)

// comment writes a comment on a task, or, called as result, the report of
// what was done: what was checked, measured and left unverified, and the
// files that show it. Given page=ID instead of a task, it starts a thread
// on that page, on one of its blocks with block=ID, or on words of the
// block with quote=WORDS too (the server finds them; occurrence=N says
// which when they are there more than once).
func (r *runner) comment(in input) error {
	a, err := argsFrom(in.f, "checked", "measured", "not_verified", "file", "page")
	if err != nil {
		return err
	}
	words := in.pos
	if page := in.f["page"]; len(page) > 0 {
		a["doc"] = page[len(page)-1]
	} else if len(words) < 2 {
		return errors.New("usage: quadit " + in.name + " KEY TEXT, or quadit comment page=PAGE_ID [block=BLOCK_ID [quote=WORDS [occurrence=N]]] TEXT")
	} else {
		a["task"], words = words[0], words[1:]
	}
	a["body"] = strings.Join(words, " ")
	if a["body"] == "-" {
		if a["body"], err = readStdin(); err != nil {
			return err
		}
	}
	ev := map[string]string{}
	for _, k := range []string{"checked", "measured", "not_verified"} {
		if v := in.f[k]; len(v) > 0 {
			ev[k] = v[0]
		}
	}
	if in.name == "result" {
		a["kind"] = "result"
	}
	if len(ev) > 0 {
		a["evidence"] = ev
	}
	if err := r.attachUploads(a, in.f["file"]); err != nil {
		return err
	}
	return r.change("comment.create", a, in.approval)
}

// reply answers in the thread of the comment named, on a task or a page,
// with the files that show it: the reply joins that comment's thread,
// whichever comment of it is named.
func (r *runner) reply(in input) error {
	a, err := argsFrom(in.f, "file")
	if err != nil {
		return err
	}
	a["parent"], a["body"] = in.pos[0], strings.Join(in.pos[1:], " ")
	if a["body"] == "-" {
		if a["body"], err = readStdin(); err != nil {
			return err
		}
	}
	if err := r.attachUploads(a, in.f["file"]); err != nil {
		return err
	}
	return r.change("comment.create", a, in.approval)
}

// attachUploads sends the files at paths and names them in a, the
// arguments of a new comment, as what it comes with.
func (r *runner) attachUploads(a map[string]any, paths []string) error {
	atts, err := r.uploads(paths)
	if err != nil {
		return err
	}
	if len(atts) > 0 {
		a["attachments"] = atts
	}
	return nil
}

// resolve marks the thread of the comment named as resolved; called as
// reopen, it opens it again.
func (r *runner) resolve(in input) error {
	return r.change("comment.update", map[string]any{"id": in.pos[0], "resolved": in.name == "resolve"}, in.approval)
}
