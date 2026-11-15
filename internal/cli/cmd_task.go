// The task commands: new, update, status, assign, take and the like, and
// comments and results.

package cli

import "strings"

// newTask makes a task in a project; the words after the project are its
// title.
func (r *runner) newTask(in input) error {
	a, err := argsFrom(in.f)
	if err != nil {
		return err
	}
	a["project"], a["title"] = in.pos[0], strings.Join(in.pos[1:], " ")
	return r.change("task.create", a, in.approval)
}

// update changes a task's fields.
func (r *runner) update(in input) error {
	return r.changeTask("task.update", in)
}

// changeNamed is take, release, delete and restore: each is the change of
// its own name on one task.
func (r *runner) changeNamed(in input) error {
	return r.changeTask("task."+in.name, in)
}

// changeTask sends one change to the task the first argument names, with
// the field=value arguments as the rest of it.
func (r *runner) changeTask(typ string, in input) error {
	a, err := argsFrom(in.f)
	if err != nil {
		return err
	}
	a["id"] = in.pos[0]
	return r.change(typ, a, in.approval)
}

// status moves a task to the status named by the words after its key.
func (r *runner) status(in input) error {
	return r.change("task.update", map[string]any{"id": in.pos[0], "status": strings.Join(in.pos[1:], " ")}, in.approval)
}

// assign gives a task to a member, or to nobody.
func (r *runner) assign(in input) error {
	return r.change("task.update", map[string]any{"id": in.pos[0], "assignee": apiValue("assignee", in.pos[1])}, in.approval)
}

// comment writes a comment on a task, or, called as result, the report of
// what was done: what was checked, measured and left unverified, and the
// files that show it.
func (r *runner) comment(in input) error {
	a, err := argsFrom(in.f, "checked", "measured", "not_verified", "file")
	if err != nil {
		return err
	}
	a["task"], a["body"] = in.pos[0], strings.Join(in.pos[1:], " ")
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
