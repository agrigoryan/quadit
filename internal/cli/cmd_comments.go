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
// on that page, or on one of its blocks with block=ID.
func (r *runner) comment(in input) error {
	a, err := argsFrom(in.f, "checked", "measured", "not_verified", "file", "page")
	if err != nil {
		return err
	}
	words := in.pos
	if page := in.f["page"]; len(page) > 0 {
		a["doc"] = page[len(page)-1]
	} else if len(words) < 2 {
		return errors.New("usage: quadit " + in.name + " KEY TEXT, or quadit comment page=PAGE_ID [block=BLOCK_ID] TEXT")
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
	if atts, err := r.uploads(in.f["file"]); err != nil {
		return err
	} else if len(atts) > 0 {
		a["attachments"] = atts
	}
	return r.change("comment.create", a, in.approval)
}

// reply answers in the thread of the comment named, on a task or a page:
// the reply joins that comment's thread, whichever comment of it is named.
func (r *runner) reply(in input) error {
	a, err := argsFrom(in.f)
	if err != nil {
		return err
	}
	a["parent"], a["body"] = in.pos[0], strings.Join(in.pos[1:], " ")
	if a["body"] == "-" {
		if a["body"], err = readStdin(); err != nil {
			return err
		}
	}
	return r.change("comment.create", a, in.approval)
}

// resolve marks the thread of the comment named as resolved; called as
// reopen, it opens it again.
func (r *runner) resolve(in input) error {
	return r.change("comment.update", map[string]any{"id": in.pos[0], "resolved": in.name == "resolve"}, in.approval)
}
