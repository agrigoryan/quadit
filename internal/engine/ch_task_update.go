package engine

import (
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("task.update", core.RoleMember, taskUpdate)
}

type taskUpdateArgs struct {
	ID string `json:"id" quadit:"required,handler"`
	// BaseSeq, when given, is the task's updated_seq the caller last saw. If
	// the task has changed since, the update is refused instead of applied
	// over the newer values.
	BaseSeq       int64         `json:"base_seq"`
	Title         Opt[string]   `json:"title"`
	Description   Opt[string]   `json:"description"`
	Status        Opt[string]   `json:"status"`
	Priority      Opt[int]      `json:"priority"`
	Assignee      Opt[string]   `json:"assignee"`
	WaitingOn     Opt[string]   `json:"waiting_on"`
	WaitingOnNote Opt[string]   `json:"waiting_on_note"`
	Parent        Opt[string]   `json:"parent"`
	Epic          Opt[string]   `json:"epic"`
	Milestone     Opt[string]   `json:"milestone"`
	Cycle         Opt[string]   `json:"cycle"`
	Estimate      Opt[int]      `json:"estimate"`
	DueOn         Opt[string]   `json:"due_on"`
	Rank          Opt[string]   `json:"rank"`
	Labels        Opt[[]string] `json:"labels"`
	AddLabels     []string      `json:"add_labels"`
	RemoveLabels  []string      `json:"remove_labels"`
	Archived      Opt[bool]     `json:"archived"`
	// HandoffLimit is how many times the task may be passed from agent to
	// agent in all; 0 or null is no limit.
	HandoffLimit Opt[int] `json:"handoff_limit"`
}

// taskUpdate changes a task's fields: each one given, in the order of the
// steps, and the first thing wrong is what the caller is told.
func taskUpdate(c *cx, a taskUpdateArgs) error {
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	if a.BaseSeq > 0 && t.UpdatedSeq > a.BaseSeq {
		return c.staleError(t, a.BaseSeq)
	}
	u := &taskEdit{c: c, a: a, before: t, t: t, p: newPatch()}
	if err := c.tx.Get(c.ctx, &u.pr, store.Eq("id", t.ProjectID)); err != nil {
		return err
	}
	steps := []func() error{
		u.text,
		u.status,
		u.numbers,
		u.assignee,
		u.waitingOn,
		u.parent,
		u.epic,
		u.milestone,
		u.cycle,
		u.dueAndRank,
		u.archived,
		u.handoffLimit,
		u.labels,
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	if err := c.saveTask(u.t, u.p, core.EventData{}); err != nil {
		return err
	}
	if u.p.empty() {
		return nil
	}
	return u.notifyConcerned()
}

// taskEdit is one task.update under way: the task as it was and as it is
// becoming, and the patch that takes it from the one to the other.
type taskEdit struct {
	c      *cx
	a      taskUpdateArgs
	pr     core.Project
	before core.Task
	t      core.Task
	p      *patch
	// moved is the status the task goes to, when the update changes it.
	moved *core.Status
}

func (u *taskEdit) text() error {
	if err := u.p.name("title", u.a.Title, &u.t.Title); err != nil {
		return err
	}
	u.p.setText("description", u.a.Description, &u.t.Description)
	return nil
}

func (u *taskEdit) status() error {
	if !u.a.Status.Set {
		return nil
	}
	st, err := u.c.status(u.pr, "status", u.a.Status.V)
	if err != nil {
		return err
	}
	if st.ID != u.t.StatusID {
		u.moved = &st
	}
	u.c.setStatus(u.p, &u.t, st)
	return nil
}

func (u *taskEdit) numbers() error {
	a, t, p := u.a, &u.t, u.p
	if a.Priority.Set {
		if a.Priority.Null || !priorityOK(a.Priority.V) {
			return invalid("priority", priorityHelp)
		}
		p.setNumber("priority", a.Priority, &t.Priority)
	}
	if a.Estimate.Set {
		if err := checkEstimate(a.Estimate.V); err != nil {
			return err
		}
		p.setNumber("estimate", a.Estimate, &t.Estimate)
	}
	return nil
}

// member applies an optional reference to the member the task names for
// its work (personOnTask) to a column.
func (u *taskEdit) member(col, field string, o Opt[string], cur *string) error {
	if !o.Set {
		return nil
	}
	v, err := u.c.personOnTask(field, refOf(o), u.t)
	if err != nil {
		return err
	}
	u.p.put(col, *cur, v)
	*cur = v
	return nil
}

// assignee gives the task to someone, or to nobody. An agent passing it to
// another agent is held to the limits on hand-offs, and who the task is
// worked for follows who holds it.
func (u *taskEdit) assignee() error {
	c, t := u.c, &u.t
	if err := u.member("assignee_id", "assignee", u.a.Assignee, &t.AssigneeID); err != nil {
		return err
	}
	if t.AssigneeID == u.before.AssigneeID {
		return nil
	}
	if t.AssigneeID != "" && c.actor.Kind == core.KindAgent && !c.system {
		if err := c.checkHandoff(*t); err != nil {
			return err
		}
	}
	by, err := c.askedBy(*t)
	if err != nil {
		return err
	}
	u.p.put("asked_by", t.AskedBy, by)
	t.AskedBy = by
	return nil
}

// waitingOn says whose move it is: a member's, nobody's, or an outside
// event's, and with what note.
func (u *taskEdit) waitingOn() error {
	a, t, p := u.a, &u.t, u.p
	if a.WaitingOn.Set && isOutside(a.WaitingOn.V) {
		note := t.WaitingOnNote
		if a.WaitingOnNote.Set {
			note = a.WaitingOnNote.V
		}
		if err := checkOutsideNote(note); err != nil {
			return err
		}
		p.put("waiting_on_id", t.WaitingOnID, "")
		p.put("waiting_outside", t.WaitingOutside, true)
		t.WaitingOnID = ""
	} else if err := u.member("waiting_on_id", "waiting_on", a.WaitingOn, &t.WaitingOnID); err != nil {
		return err
	} else if a.WaitingOn.Set && t.WaitingOutside {
		// Named a member, or nobody: it no longer waits on the outside. With
		// nobody named and no new note, the old note goes with it.
		p.put("waiting_outside", true, false)
		if t.WaitingOnID == "" && !a.WaitingOnNote.Set {
			p.put("waiting_on_note", t.WaitingOnNote, "")
			t.WaitingOnNote = ""
		}
	}
	p.setText("waiting_on_note", a.WaitingOnNote, &t.WaitingOnNote)
	return nil
}

func (u *taskEdit) parent() error {
	if !u.a.Parent.Set {
		return nil
	}
	pid := ""
	if ref := refOf(u.a.Parent); ref != "" {
		parent, err := u.c.task("parent", ref)
		if err != nil {
			return err
		}
		if err := u.c.checkParent(u.t, parent.ID); err != nil {
			return err
		}
		pid = parent.ID
	}
	u.p.put("parent_id", u.t.ParentID, pid)
	return nil
}

func (u *taskEdit) epic() error {
	a, t, p := u.a, &u.t, u.p
	if !a.Epic.Set {
		return nil
	}
	eid, err := u.c.taskEpic(u.pr, refOf(a.Epic))
	if err != nil {
		return err
	}
	if eid != t.EpicID && !a.Milestone.Set {
		p.put("milestone_id", t.MilestoneID, "") // a milestone belongs to its epic
		t.MilestoneID = ""
	}
	p.put("epic_id", t.EpicID, eid)
	t.EpicID = eid
	return nil
}

func (u *taskEdit) milestone() error {
	a, t, p := u.a, &u.t, u.p
	if !a.Milestone.Set {
		return nil
	}
	mid := ""
	if ref := refOf(a.Milestone); ref != "" {
		ms, err := u.c.taskMilestone(ref, t.EpicID)
		if err != nil {
			return err
		}
		p.put("epic_id", t.EpicID, ms.EpicID)
		mid = ms.ID
	}
	p.put("milestone_id", t.MilestoneID, mid)
	return nil
}

func (u *taskEdit) cycle() error {
	if !u.a.Cycle.Set {
		return nil
	}
	cid, err := u.c.taskCycle(u.pr, refOf(u.a.Cycle))
	if err != nil {
		return err
	}
	u.p.put("cycle_id", u.t.CycleID, cid)
	return nil
}

func (u *taskEdit) dueAndRank() error {
	if err := u.p.date("due_on", u.a.DueOn, &u.t.DueOn); err != nil {
		return err
	}
	return u.p.rank(u.a.Rank, &u.t.Rank)
}

func (u *taskEdit) archived() error {
	a, t, p := u.a, &u.t, u.p
	p.setStamp("archived_at", a.Archived, t.ArchivedAt, u.c.at)
	return nil
}

func (u *taskEdit) handoffLimit() error {
	if err := checkHandoffLimit(u.a.HandoffLimit.V); err != nil {
		return err
	}
	u.p.setNumber("handoff_limit", u.a.HandoffLimit, &u.t.HandoffLimit)
	return nil
}

// labels sets the task's labels: the whole list when one is given, then
// those to add and those to take away.
func (u *taskEdit) labels() error {
	c, a := u.c, u.a
	if !a.Labels.Set && len(a.AddLabels) == 0 && len(a.RemoveLabels) == 0 {
		return nil
	}
	ids := append([]string(nil), u.t.LabelIDs...)
	if a.Labels.Set {
		var err error
		if ids, err = c.labelIDs(u.pr, "labels", a.Labels.V); err != nil {
			return err
		}
	}
	add, err := c.labelIDs(u.pr, "add_labels", a.AddLabels)
	if err != nil {
		return err
	}
	for _, l := range add {
		if !slices.Contains(ids, l) {
			ids = append(ids, l)
		}
	}
	for _, ref := range a.RemoveLabels {
		l, err := c.label(u.pr, "remove_labels", ref)
		if isRefusal(err) {
			continue // no such label: nothing to take off
		}
		if err != nil {
			return err
		}
		ids = without(ids, l.ID)
	}
	return c.setLabels(u.p, &u.t, ids)
}

// notifyConcerned lets the people the update concerns know of it: a new assignee, a
// new next mover, those mentioned, and the watchers when the task closes.
func (u *taskEdit) notifyConcerned() error {
	c, t, before := u.c, u.t, u.before
	newAssignee, newWaiting := "", ""
	if t.AssigneeID != before.AssigneeID {
		newAssignee = t.AssigneeID
	}
	if t.WaitingOnID != before.WaitingOnID {
		newWaiting = t.WaitingOnID
	}
	if err := c.afterTaskPeople(t, newAssignee, newWaiting); err != nil {
		return err
	}
	if t.Title != before.Title || t.Description != before.Description {
		if err := c.afterTaskText(t); err != nil {
			return err
		}
	}
	if u.moved != nil && !core.OpenCategory(u.moved.Category) {
		return c.notifyWatchers(t, core.NoteStatus, about{entity: "task", id: t.ID, text: "moved to " + u.moved.Name})
	}
	return nil
}
