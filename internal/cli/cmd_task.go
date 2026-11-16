// The task commands: new, update, status, assign, take and the like.

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
