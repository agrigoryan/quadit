package engine

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("task.create", core.RoleMember, taskCreate)
	register("task.update", core.RoleMember, taskUpdate)
	register("task.delete", core.RoleMember, taskDelete)
	register("task.restore", core.RoleMember, taskRestore)
	register("task.take", core.RoleMember, taskTake)
	register("task.release", core.RoleMember, taskRelease)
	register("task.move", core.RoleMember, taskMove)
	register("relation.add", core.RoleMember, relationAdd)
	register("relation.remove", core.RoleMember, relationRemove)
	register("link.set", core.RoleMember, linkSet)
	register("link.remove", core.RoleMember, linkRemove)
	register("watch.set", core.RoleMember, watchSet)
}

const priorityHelp = "priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)"

type taskCreateArgs struct {
	ID            string       `json:"id"`
	Project       string       `json:"project"`
	Title         string       `json:"title"`
	Description   string       `json:"description"`
	Status        string       `json:"status"`
	Priority      int          `json:"priority"`
	Assignee      string       `json:"assignee"`
	WaitingOn     string       `json:"waiting_on"`
	WaitingOnNote string       `json:"waiting_on_note"`
	Parent        string       `json:"parent"`
	Epic          string       `json:"epic"`
	Milestone     string       `json:"milestone"`
	Cycle         string       `json:"cycle"`
	Estimate      int          `json:"estimate"`
	Labels        []string     `json:"labels"`
	DueOn         string       `json:"due_on"`
	Rank          string       `json:"rank"`
	Template      string       `json:"template"`
	Budget        *core.Budget `json:"budget"`
}

func taskCreate(c *cx) error {
	var a taskCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	tid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	var parent core.Task
	if a.Parent != "" {
		if parent, err = c.task("parent", a.Parent); err != nil {
			return err
		}
		if a.Project == "" {
			a.Project = parent.ProjectID
		}
	}
	p, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if p.ArchivedAt != 0 {
		return conflictErr("project %s is archived", p.Key)
	}
	var opens *decisionOpenArgs
	if a.Template != "" {
		if opens, err = c.applyTemplate(p, &a); err != nil {
			return err
		}
	}
	title := strings.TrimSpace(a.Title)
	if title == "" {
		return invalid("title", "a task needs a title")
	}
	if a.Priority < 0 || a.Priority > 4 {
		return invalid("priority", priorityHelp)
	}
	if a.Estimate < 0 {
		return invalid("estimate", "an estimate is a number of points, 0 or more")
	}
	var st core.Status
	if a.Status != "" {
		st, err = c.status(p, "status", a.Status)
	} else {
		st, err = c.defaultStatus(p)
	}
	if err != nil {
		return err
	}
	t := core.Task{ID: tid, WorkspaceID: c.ws, ProjectID: p.ID, Title: title, Description: a.Description, StatusID: st.ID,
		Priority: a.Priority, WaitingOnNote: a.WaitingOnNote, ParentID: parent.ID, Estimate: a.Estimate, DueOn: a.DueOn,
		Budget: a.Budget, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	if t.AssigneeID, err = c.optMember("assignee", a.Assignee); err != nil {
		return err
	}
	if t.AskedBy, err = c.askedBy(t); err != nil {
		return err
	}
	if isOutside(a.WaitingOn) {
		// The next move is not a member's: a build, a reply, a date. The
		// note says what the task waits for.
		if strings.TrimSpace(a.WaitingOnNote) == "" {
			return invalid("waiting_on_note", "say what outside event the task waits for, in waiting_on_note")
		}
		t.WaitingOutside = true
	} else if t.WaitingOnID, err = c.optMember("waiting_on", a.WaitingOn); err != nil {
		return err
	}
	if err := checkDate("due_on", a.DueOn); err != nil {
		return err
	}
	if t.LabelIDs, err = c.labelIDs(p, "labels", a.Labels); err != nil {
		return err
	}
	if a.Epic != "" {
		e, err := c.epic(p, "epic", a.Epic)
		if err != nil {
			return err
		}
		t.EpicID = e.ID
	} else if parent.EpicID != "" && parent.ProjectID == p.ID {
		t.EpicID = parent.EpicID
	}
	if a.Milestone != "" {
		ms, err := get[core.Milestone](c, "milestone", "milestone", a.Milestone)
		if err != nil {
			return err
		}
		if t.EpicID != "" && ms.EpicID != t.EpicID {
			return invalid("milestone", "that milestone belongs to another epic")
		}
		t.MilestoneID, t.EpicID = ms.ID, ms.EpicID
	}
	if a.Cycle != "" {
		cy, err := c.cycle(p, "cycle", a.Cycle)
		if err != nil {
			return err
		}
		t.CycleID = cy.ID
	}
	n, err := c.tx.Incr(c.ctx, "projects", "task_counter", 1, store.Eq("id", p.ID))
	if err != nil {
		return err
	}
	t.Number = int(n)
	t.Key = p.Key + "-" + itoa(t.Number)
	t.Rank = a.Rank
	if t.Rank == "" {
		t.Rank = rank.ForNumber(t.Number)
	} else if !rank.Valid(t.Rank) {
		return invalid("rank", "%q is not a rank", t.Rank)
	}
	stampStatus(&t.StartedAt, &t.CompletedAt, &t.CanceledAt, st.Category, c.at)
	seq := c.tx.NextSeq()
	t.CreatedSeq, t.UpdatedSeq, t.ActivitySeq = seq, seq, seq
	if err := c.tx.Insert(c.ctx, t); err != nil {
		return taken(err, "id", tid)
	}
	for _, l := range t.LabelIDs {
		if err := c.tx.Insert(c.ctx, core.TaskLabel{TaskID: t.ID, LabelID: l, WorkspaceID: c.ws}); err != nil {
			return err
		}
	}
	if err := c.created(seq, "task", t.ID, "task", t.ID, p.ID, t); err != nil {
		return err
	}
	c.key = t.Key
	if err := c.afterTaskText(t, true, t.AssigneeID, t.WaitingOnID); err != nil {
		return err
	}
	if opens != nil {
		d := *opens
		d.ID, d.Task = "", t.ID
		return c.sub("decision.open", d)
	}
	return nil
}

// afterTaskText keeps search, mentions, watchers and the inbox in step with
// a task whose text or people changed.
func (c *cx) afterTaskText(t core.Task, textChanged bool, newAssignee, newWaitingOn string) error {
	if err := c.watch(t.CreatedBy, "task", t.ID); err != nil {
		return err
	}
	if newWaitingOn != "" {
		if err := c.notifyTask(newWaitingOn, core.NoteWaitingOn, t, "task", t.ID, t.WaitingOnNote); err != nil {
			return err
		}
	}
	if newAssignee != "" {
		if err := c.watch(newAssignee, "task", t.ID); err != nil {
			return err
		}
		if err := c.notifyTask(newAssignee, core.NoteAssigned, t, "task", t.ID, ""); err != nil {
			return err
		}
	}
	if !textChanged {
		return nil
	}
	mentioned, err := c.link("task", t.ID, "task", t.ID, t.Title+"\n"+t.Description)
	if err != nil {
		return err
	}
	for _, m := range mentioned {
		if err := c.watch(m.UserID, "task", t.ID); err != nil {
			return err
		}
		if err := c.notifyTask(m.UserID, core.NoteMentioned, t, "task", t.ID, t.Description); err != nil {
			return err
		}
	}
	return c.index("task", t.ID, "task", t.ID, t.ProjectID, "", t.Key+" "+t.Title, t.Description)
}

// stampStatus keeps the lifecycle times in step with the status category.
func stampStatus(started, completed, canceled *int64, category string, at int64) {
	switch category {
	case core.CatStarted, core.CatWaiting:
		if *started == 0 {
			*started = at
		}
		*completed, *canceled = 0, 0
	case core.CatDone:
		if *started == 0 {
			*started = at
		}
		if *completed == 0 {
			*completed = at
		}
		*canceled = 0
	case core.CatCanceled:
		if *canceled == 0 {
			*canceled = at
		}
		*completed = 0
	default: // backlog, unstarted: reopened
		*completed, *canceled = 0, 0
	}
}

// setStatus moves a task to a status inside a patch, with its lifecycle
// times. A closed task waits on nobody and is held by nobody.
func (c *cx) setStatus(p *patch, t *core.Task, st core.Status) {
	if st.ID == t.StatusID {
		return
	}
	p.put("status_id", t.StatusID, st.ID)
	t.StatusID = st.ID
	started, completed, canceled := t.StartedAt, t.CompletedAt, t.CanceledAt
	stampStatus(&started, &completed, &canceled, st.Category, c.at)
	p.put("started_at", t.StartedAt, started)
	p.put("completed_at", t.CompletedAt, completed)
	p.put("canceled_at", t.CanceledAt, canceled)
	t.StartedAt, t.CompletedAt, t.CanceledAt = started, completed, canceled
	if !core.OpenCategory(st.Category) {
		p.put("waiting_on_id", t.WaitingOnID, "")
		p.put("waiting_on_note", t.WaitingOnNote, "")
		p.put("lease_holder_id", t.LeaseHolderID, "")
		p.put("lease_until", t.LeaseUntil, int64(0))
		t.WaitingOnID, t.WaitingOnNote, t.LeaseHolderID, t.LeaseUntil = "", "", "", 0
	}
}

// setLabels replaces a task's labels inside a patch and keeps the link
// table, which filters use, the same.
func (c *cx) setLabels(p *patch, t *core.Task, ids []string) error {
	old := t.LabelIDs
	for _, l := range old {
		if !contains(ids, l) {
			if _, err := c.tx.Delete(c.ctx, "task_labels", store.Eq("task_id", t.ID), store.Eq("label_id", l)); err != nil {
				return err
			}
		}
	}
	for _, l := range ids {
		if !contains(old, l) {
			if err := c.tx.Upsert(c.ctx, core.TaskLabel{TaskID: t.ID, LabelID: l, WorkspaceID: c.ws}, "task_id", "label_id"); err != nil {
				return err
			}
		}
	}
	if len(ids) == 0 {
		ids = nil
	}
	if len(old) == 0 {
		old = nil
	}
	p.put("label_ids", old, ids)
	t.LabelIDs = ids
	return nil
}

// saveTask writes a task patch and emits task.updated. A task's own fields
// changing also counts as activity in it.
func (c *cx) saveTask(t core.Task, p *patch, extra map[string]any) error {
	c.ref, c.key = t.ID, t.Key
	if p.empty() {
		return nil
	}
	// Whenever the next move goes to a member, or to nobody, the task no
	// longer waits on an outside event.
	if _, moved := p.set["waiting_on_id"]; moved && t.WaitingOutside {
		if _, said := p.set["waiting_outside"]; !said {
			p.put("waiting_outside", true, false)
		}
	}
	seq := c.tx.NextSeq()
	p.set["updated_seq"], p.set["activity_seq"], p.set["updated_at"] = seq, seq, c.at
	if _, err := c.tx.Update(c.ctx, "tasks", p.set, store.Eq("id", t.ID)); err != nil {
		return err
	}
	data := map[string]any{"id": t.ID, "key": t.Key, "changes": p.changes}
	for k, v := range extra {
		data[k] = v
	}
	if err := c.emit(seq, "task.updated", "task", t.ID, "task", t.ID, t.ProjectID, data); err != nil {
		return err
	}
	// The task is done or dropped: the sub-agents made for it are finished too.
	for _, col := range []string{"completed_at", "canceled_at"} {
		if at, ok := p.set[col].(int64); ok && at != 0 {
			return c.endDelegates(t)
		}
	}
	return nil
}

// touch records that something happened inside a task.
func (c *cx) touch(taskID string, seq int64) error {
	_, err := c.tx.Update(c.ctx, "tasks", map[string]any{"activity_seq": seq}, store.Eq("id", taskID))
	return err
}

type taskUpdateArgs struct {
	ID string `json:"id"`
	// BaseSeq, when given, is the task's updated_seq the caller last saw. If
	// the task has changed since, the update is refused instead of applied
	// over the newer values.
	BaseSeq       int64            `json:"base_seq"`
	Title         Opt[string]      `json:"title"`
	Description   Opt[string]      `json:"description"`
	Status        Opt[string]      `json:"status"`
	Priority      Opt[int]         `json:"priority"`
	Assignee      Opt[string]      `json:"assignee"`
	WaitingOn     Opt[string]      `json:"waiting_on"`
	WaitingOnNote Opt[string]      `json:"waiting_on_note"`
	Parent        Opt[string]      `json:"parent"`
	Epic          Opt[string]      `json:"epic"`
	Milestone     Opt[string]      `json:"milestone"`
	Cycle         Opt[string]      `json:"cycle"`
	Estimate      Opt[int]         `json:"estimate"`
	DueOn         Opt[string]      `json:"due_on"`
	Rank          Opt[string]      `json:"rank"`
	Labels        Opt[[]string]    `json:"labels"`
	AddLabels     []string         `json:"add_labels"`
	RemoveLabels  []string         `json:"remove_labels"`
	Archived      Opt[bool]        `json:"archived"`
	Budget        Opt[core.Budget] `json:"budget"`
}

func taskUpdate(c *cx) error {
	var a taskUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	if a.BaseSeq > 0 && t.UpdatedSeq > a.BaseSeq {
		return c.stale(t, a.BaseSeq)
	}
	var pr core.Project
	if err := c.tx.Get(c.ctx, &pr, store.Eq("id", t.ProjectID)); err != nil {
		return err
	}
	before := t
	p := newPatch()
	if err := p.name("title", a.Title, &t.Title); err != nil {
		return err
	}
	p.str("description", a.Description, &t.Description)
	var newStatus *core.Status
	if a.Status.Set {
		st, err := c.status(pr, "status", a.Status.V)
		if err != nil {
			return err
		}
		if st.ID != t.StatusID {
			newStatus = &st
		}
		c.setStatus(p, &t, st)
	}
	if a.Priority.Set {
		if a.Priority.Null || a.Priority.V < 0 || a.Priority.V > 4 {
			return invalid("priority", priorityHelp)
		}
		p.num("priority", a.Priority, &t.Priority)
	}
	if a.Estimate.Set {
		if a.Estimate.V < 0 {
			return invalid("estimate", "an estimate is a number of points, 0 or more")
		}
		p.num("estimate", a.Estimate, &t.Estimate)
	}
	// member applies an optional member reference to a column.
	member := func(col, field string, o Opt[string], cur *string) error {
		if !o.Set {
			return nil
		}
		v := ""
		if !o.Null && o.V != "" {
			if v, err = c.optMember(field, o.V); err != nil {
				return err
			}
		}
		p.put(col, *cur, v)
		*cur = v
		return nil
	}
	if err := member("assignee_id", "assignee", a.Assignee, &t.AssigneeID); err != nil {
		return err
	}
	if t.AssigneeID != before.AssigneeID && t.AssigneeID != "" && c.actor.Kind == core.KindAgent && !c.system {
		if err := c.checkHandoff(t); err != nil {
			return err
		}
	}
	if t.AssigneeID != before.AssigneeID {
		by, err := c.askedBy(t)
		if err != nil {
			return err
		}
		p.put("asked_by", t.AskedBy, by)
		t.AskedBy = by
	}
	if a.WaitingOn.Set && isOutside(a.WaitingOn.V) {
		note := t.WaitingOnNote
		if a.WaitingOnNote.Set {
			note = a.WaitingOnNote.V
		}
		if strings.TrimSpace(note) == "" {
			return invalid("waiting_on_note", "say what outside event the task waits for, in waiting_on_note")
		}
		p.put("waiting_on_id", t.WaitingOnID, "")
		p.put("waiting_outside", t.WaitingOutside, true)
		t.WaitingOnID = ""
	} else if err := member("waiting_on_id", "waiting_on", a.WaitingOn, &t.WaitingOnID); err != nil {
		return err
	}
	p.str("waiting_on_note", a.WaitingOnNote, &t.WaitingOnNote)
	if a.Parent.Set {
		pid := ""
		if !a.Parent.Null && a.Parent.V != "" {
			parent, err := c.task("parent", a.Parent.V)
			if err != nil {
				return err
			}
			if err := c.checkParent(t, parent.ID); err != nil {
				return err
			}
			pid = parent.ID
		}
		p.put("parent_id", t.ParentID, pid)
	}
	if a.Epic.Set {
		eid := ""
		if !a.Epic.Null && a.Epic.V != "" {
			e, err := c.epic(pr, "epic", a.Epic.V)
			if err != nil {
				return err
			}
			eid = e.ID
		}
		if eid != t.EpicID && !a.Milestone.Set {
			p.put("milestone_id", t.MilestoneID, "") // a milestone belongs to its epic
			t.MilestoneID = ""
		}
		p.put("epic_id", t.EpicID, eid)
		t.EpicID = eid
	}
	if a.Milestone.Set {
		mid := ""
		if !a.Milestone.Null && a.Milestone.V != "" {
			ms, err := get[core.Milestone](c, "milestone", "milestone", a.Milestone.V)
			if err != nil {
				return err
			}
			if t.EpicID != "" && ms.EpicID != t.EpicID {
				return invalid("milestone", "that milestone belongs to another epic")
			}
			p.put("epic_id", t.EpicID, ms.EpicID)
			mid = ms.ID
		}
		p.put("milestone_id", t.MilestoneID, mid)
	}
	if a.Cycle.Set {
		cid := ""
		if !a.Cycle.Null && a.Cycle.V != "" {
			cy, err := c.cycle(pr, "cycle", a.Cycle.V)
			if err != nil {
				return err
			}
			cid = cy.ID
		}
		p.put("cycle_id", t.CycleID, cid)
	}
	if err := p.date("due_on", a.DueOn, &t.DueOn); err != nil {
		return err
	}
	if err := p.rank(a.Rank, &t.Rank); err != nil {
		return err
	}
	if a.Archived.Set {
		if a.Archived.V && t.ArchivedAt == 0 {
			p.put("archived_at", int64(0), c.at)
		} else if !a.Archived.V && t.ArchivedAt != 0 {
			p.put("archived_at", t.ArchivedAt, int64(0))
		}
	}
	if a.Budget.Set {
		var b *core.Budget
		if !a.Budget.Null && (a.Budget.V.CostMicros > 0 || a.Budget.V.Minutes > 0 || a.Budget.V.Handoffs > 0) {
			b = &a.Budget.V
		}
		p.set["budget"] = b
		p.changes["budget"] = core.FieldChange{From: t.Budget, To: b}
	}
	if a.Labels.Set || len(a.AddLabels) > 0 || len(a.RemoveLabels) > 0 {
		ids := append([]string(nil), t.LabelIDs...)
		if a.Labels.Set {
			if ids, err = c.labelIDs(pr, "labels", a.Labels.V); err != nil {
				return err
			}
		}
		add, err := c.labelIDs(pr, "add_labels", a.AddLabels)
		if err != nil {
			return err
		}
		for _, l := range add {
			if !contains(ids, l) {
				ids = append(ids, l)
			}
		}
		for _, ref := range a.RemoveLabels {
			if l, err := c.label(pr, "remove_labels", ref); err == nil {
				ids = without(ids, l.ID)
			}
		}
		if err := c.setLabels(p, &t, ids); err != nil {
			return err
		}
	}
	if err := c.saveTask(t, p, nil); err != nil {
		return err
	}
	if p.empty() {
		return nil
	}
	newAssignee, newWaiting := "", ""
	if t.AssigneeID != before.AssigneeID {
		newAssignee = t.AssigneeID
	}
	if t.WaitingOnID != before.WaitingOnID {
		newWaiting = t.WaitingOnID
	}
	textChanged := t.Title != before.Title || t.Description != before.Description
	if err := c.afterTaskText(t, textChanged, newAssignee, newWaiting); err != nil {
		return err
	}
	if newStatus != nil && !core.OpenCategory(newStatus.Category) {
		return c.notifyWatchers(t, core.NoteStatus, "task", t.ID, "moved to "+newStatus.Name)
	}
	return nil
}

// stale refuses an update based on an old version and says what changed
// since, so the caller can decide without reading the task again.
func (c *cx) stale(t core.Task, base int64) error {
	evs, err := c.tx.Events(c.ctx, store.EventFilter{After: base, ScopeType: "task", ScopeID: t.ID, Types: []string{"task.updated"}, Limit: 20})
	if err != nil {
		return err
	}
	fields := map[string]bool{}
	for _, ev := range evs {
		var d struct {
			Changes map[string]json.RawMessage `json:"changes"`
		}
		if json.Unmarshal(ev.Data, &d) == nil {
			for f := range d.Changes {
				fields[f] = true
			}
		}
	}
	var changed []string
	for f := range fields {
		changed = append(changed, f)
	}
	return &Error{Code: CodeStale, Allowed: changed, Message: "task " + t.Key + " changed since seq " + itoa(int(base)) +
		" (it is now at " + itoa(int(t.UpdatedSeq)) + "; changed fields are listed); read it again, or resend without base_seq to overwrite"}
}

// checkParent refuses a parent that would make a loop.
func (c *cx) checkParent(t core.Task, parentID string) error {
	cur := parentID
	for depth := 0; cur != ""; depth++ {
		if cur == t.ID {
			return invalid("parent", "a task cannot be its own ancestor")
		}
		if depth > 50 {
			return invalid("parent", "sub-tasks are nested too deep")
		}
		var p core.Task
		if err := c.tx.Get(c.ctx, &p, store.Eq("id", cur)); err != nil {
			return missing(err, "parent task", cur)
		}
		cur = p.ParentID
	}
	return nil
}

// setWaitingOn hands a task to userID ("" = nobody) as part of another
// change, and says so in the feed.
func (c *cx) setWaitingOn(t core.Task, userID, note string) error {
	p := newPatch()
	p.put("waiting_on_id", t.WaitingOnID, userID)
	p.put("waiting_on_note", t.WaitingOnNote, note)
	ref, key := c.ref, c.key
	err := c.saveTask(t, p, nil)
	c.ref, c.key = ref, key
	return err
}

type idArgs struct {
	ID string `json:"id"`
}

func taskDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("deleted_at", int64(0), c.at)
	p.set["deleted_by"] = c.actor.UserID
	if err := c.saveTask(t, p, map[string]any{"deleted": true}); err != nil {
		return err
	}
	return c.tx.Unindex(c.ctx, t.ID)
}

func taskRestore(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.anyTask("id", a.ID)
	if err != nil {
		return err
	}
	if t.DeletedAt == 0 {
		c.ref, c.key = t.ID, t.Key
		return nil // not in the trash: nothing to do
	}
	p := newPatch()
	p.put("deleted_at", t.DeletedAt, int64(0))
	p.set["deleted_by"] = ""
	if err := c.saveTask(t, p, map[string]any{"restored": true}); err != nil {
		return err
	}
	return c.index("task", t.ID, "task", t.ID, t.ProjectID, "", t.Key+" "+t.Title, t.Description)
}

type taskTakeArgs struct {
	ID string `json:"id"`
	// Minutes is how long the lease lasts without being renewed. Taking a
	// task you already hold renews it.
	Minutes int `json:"minutes"`
}

// taskTake makes the caller the one working on a task. Two cannot take the
// same task: the second is told who has it and until when. The lease ends
// by itself if it is not renewed, so a task held by a stopped agent frees up.
func taskTake(c *cx) error {
	var a taskTakeArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	if err := c.checkTaskBudget(t); err != nil {
		return err
	}
	if a.Minutes <= 0 {
		a.Minutes = 30
	}
	if a.Minutes > 24*60 {
		return invalid("minutes", "a lease lasts at most 1440 minutes; renew it by taking the task again")
	}
	if t.LeaseHolderID != "" && t.LeaseHolderID != c.actor.UserID && t.LeaseUntil > c.at {
		holder := t.LeaseHolderID
		if m, err := c.memberRef("id", t.LeaseHolderID); err == nil {
			holder = "@" + m.Handle
		}
		return conflictErr("%s is held by %s until %s", t.Key, holder, time.UnixMilli(t.LeaseUntil).UTC().Format(time.RFC3339))
	}
	if err := c.checkBudget(); err != nil {
		return err
	}
	var pr core.Project
	if err := c.tx.Get(c.ctx, &pr, store.Eq("id", t.ProjectID)); err != nil {
		return err
	}
	var cur core.Status
	if err := c.tx.Get(c.ctx, &cur, store.Eq("id", t.StatusID)); err != nil {
		return err
	}
	if !core.OpenCategory(cur.Category) {
		return conflictErr("%s is %s; reopen it before taking it", t.Key, cur.Name)
	}
	p := newPatch()
	p.put("lease_holder_id", t.LeaseHolderID, c.actor.UserID)
	p.put("lease_until", t.LeaseUntil, c.at+int64(a.Minutes)*60_000)
	newAssignee := ""
	if t.AssigneeID != c.actor.UserID {
		p.put("assignee_id", t.AssigneeID, c.actor.UserID)
		t.AssigneeID = c.actor.UserID
		if c.actor.Kind != core.KindAgent {
			p.put("asked_by", t.AskedBy, "") // a person holds it now
			t.AskedBy = ""
		}
	}
	if t.WaitingOnID == c.actor.UserID {
		p.put("waiting_on_id", t.WaitingOnID, "")
		p.put("waiting_on_note", t.WaitingOnNote, "")
	}
	if cur.Category == core.CatBacklog || cur.Category == core.CatUnstarted {
		if st, err := c.status(pr, "status", core.CatStarted); err == nil {
			c.setStatus(p, &t, st)
		}
	}
	if err := c.saveTask(t, p, nil); err != nil {
		return err
	}
	return c.afterTaskText(t, false, newAssignee, "")
}

func taskRelease(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	if t.LeaseHolderID == "" {
		c.ref, c.key = t.ID, t.Key
		return nil
	}
	if t.LeaseHolderID != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) && t.LeaseUntil > c.at {
		return forbidden("%s is held by someone else; an admin can release it", t.Key)
	}
	p := newPatch()
	p.put("lease_holder_id", t.LeaseHolderID, "")
	p.put("lease_until", t.LeaseUntil, int64(0))
	return c.saveTask(t, p, nil)
}

type taskMoveArgs struct {
	ID      string `json:"id"`
	Project string `json:"project"`
}

// taskMove moves a task to another project. It gets a new number there; its
// status becomes the nearest one of the same category, and labels, epic and
// cycle that belong to the old project are dropped.
func taskMove(c *cx) error {
	var a taskMoveArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	to, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if to.ID == t.ProjectID {
		c.ref, c.key = t.ID, t.Key
		return nil
	}
	var cur core.Status
	if err := c.tx.Get(c.ctx, &cur, store.Eq("id", t.StatusID)); err != nil {
		return err
	}
	st, err := c.status(to, "status", cur.Name)
	if err != nil {
		if st, err = c.status(to, "status", cur.Category); err != nil {
			if st, err = c.defaultStatus(to); err != nil {
				return err
			}
		}
	}
	n, err := c.tx.Incr(c.ctx, "projects", "task_counter", 1, store.Eq("id", to.ID))
	if err != nil {
		return err
	}
	oldKey, oldProject := t.Key, t.ProjectID
	p := newPatch()
	p.put("project_id", t.ProjectID, to.ID)
	p.put("number", t.Number, int(n))
	p.put("key", t.Key, to.Key+"-"+itoa(int(n)))
	p.put("status_id", t.StatusID, st.ID)
	p.put("epic_id", t.EpicID, "")
	p.put("milestone_id", t.MilestoneID, "")
	p.put("cycle_id", t.CycleID, "")
	var keep []string
	for _, lid := range t.LabelIDs {
		var l core.Label
		if err := c.tx.Get(c.ctx, &l, store.Eq("id", lid)); err == nil && l.ProjectID == "" {
			keep = append(keep, lid)
		}
	}
	if err := c.setLabels(p, &t, keep); err != nil {
		return err
	}
	t.ProjectID, t.Number, t.Key = to.ID, int(n), to.Key+"-"+itoa(int(n))
	if err := c.saveTask(t, p, map[string]any{"moved_from": oldKey, "from_project_id": oldProject}); err != nil {
		return err
	}
	return c.index("task", t.ID, "task", t.ID, t.ProjectID, "", t.Key+" "+t.Title, t.Description)
}

// ---- relations ----

type relationArgs struct {
	ID    string `json:"id"`
	Task  string `json:"task"`
	Type  string `json:"type"` // blocks, blocked_by, relates, duplicates
	Other string `json:"other"`
}

func relationAdd(c *cx) error {
	var a relationArgs
	if err := c.args(&a); err != nil {
		return err
	}
	rid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	o, err := c.task("other", a.Other)
	if err != nil {
		return err
	}
	if t.ID == o.ID {
		return invalid("other", "a task cannot relate to itself")
	}
	typ := a.Type
	switch typ {
	case "blocked_by":
		t, o, typ = o, t, core.RelBlocks
	case core.RelBlocks, core.RelDuplicates:
	case "", core.RelRelates:
		typ = core.RelRelates
		if o.ID < t.ID { // one row per pair, whichever side adds it
			t, o = o, t
		}
	default:
		return oneOf("type", "relation type", a.Type, []string{"blocks", "blocked_by", "relates", "duplicates"})
	}
	n, err := c.tx.Count(c.ctx, "task_relations", store.Eq("task_id", t.ID), store.Eq("related_task_id", o.ID), store.Eq("type", typ))
	if err != nil || n > 0 {
		return err // already there
	}
	r := core.Relation{ID: rid, WorkspaceID: c.ws, TaskID: t.ID, RelatedTaskID: o.ID, Type: typ, CreatedBy: c.actor.UserID, CreatedAt: c.at}
	if err := c.tx.Insert(c.ctx, r); err != nil {
		return taken(err, "id", rid)
	}
	seq := c.tx.NextSeq()
	for _, tid := range []string{t.ID, o.ID} {
		if err := c.touch(tid, seq); err != nil {
			return err
		}
	}
	if err := c.emit(seq, "relation.created", "relation", r.ID, "task", t.ID, t.ProjectID,
		map[string]any{"row": r, "key": t.Key, "other_key": o.Key}); err != nil {
		return err
	}
	return c.related(o, t, r, false)
}

// related tells those who follow the other end of a relation. The relation's
// own event belongs to one task; this one belongs to the other, so a feed
// narrowed to either task has it.
func (c *cx) related(t, other core.Task, r core.Relation, removed bool) error {
	return c.emit(c.tx.NextSeq(), "task.related", "task", t.ID, "task", t.ID, t.ProjectID,
		map[string]any{"id": t.ID, "key": t.Key, "other_key": other.Key, "relation": r.ID, "type": r.Type, "removed": removed})
}

func relationRemove(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	r, err := get[core.Relation](c, "relation", "id", a.ID)
	if err != nil {
		return err
	}
	if _, err := c.tx.Delete(c.ctx, "task_relations", store.Eq("id", r.ID)); err != nil {
		return err
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", r.TaskID)); err != nil {
		return err
	}
	if err := c.gone("relation", r.ID, "task", t.ID, t.ProjectID); err != nil {
		return err
	}
	var o core.Task
	if err := c.tx.Get(c.ctx, &o, store.Eq("id", r.RelatedTaskID)); err != nil {
		return nil // the other task is gone for good
	}
	seq := c.tx.Seq()
	for _, tid := range []string{t.ID, o.ID} {
		if err := c.touch(tid, seq); err != nil {
			return err
		}
	}
	return c.related(o, t, r, true)
}

// ---- links to the outside ----

type linkSetArgs struct {
	ID     string          `json:"id"`
	Task   string          `json:"task"`
	Kind   string          `json:"kind"` // branch, commit, pr, url
	URL    string          `json:"url"`
	Title  string          `json:"title"`
	Repo   string          `json:"repo"`
	Ref    string          `json:"ref"` // branch name, commit hash or pull request number
	State  string          `json:"state"`
	Checks string          `json:"checks"`
	Data   json.RawMessage `json:"data"`
}

// linkSet adds a link from a task to a branch, commit, pull request or URL,
// or updates the one already there for the same thing.
func linkSet(c *cx) error {
	var a linkSetArgs
	if err := c.args(&a); err != nil {
		return err
	}
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	kinds := []string{"branch", "commit", "pr", "issue", "url"}
	if !contains(kinds, a.Kind) {
		return oneOf("kind", "link kind", a.Kind, kinds)
	}
	if a.Kind == "url" && a.URL == "" {
		return invalid("url", "a url link needs a url")
	}
	if a.Kind != "url" && a.Ref == "" {
		return invalid("ref", "a %s link needs ref: the branch name, commit hash or pull request number", a.Kind)
	}
	var l core.TaskLink
	conds := []store.Cond{store.Eq("task_id", t.ID), store.Eq("kind", a.Kind), store.Live}
	if a.ID != "" {
		conds = []store.Cond{store.Eq("id", a.ID), store.Live}
	} else if a.Kind == "url" {
		conds = append(conds, store.Eq("url", a.URL))
	} else {
		conds = append(conds, store.Eq("repo", a.Repo), store.Eq("ref", a.Ref))
	}
	err = c.tx.Get(c.ctx, &l, conds...)
	if errors.Is(err, store.ErrNotFound) {
		lid, err := newID("id", a.ID)
		if err != nil {
			return err
		}
		seq := c.tx.NextSeq()
		l = core.TaskLink{ID: lid, WorkspaceID: c.ws, TaskID: t.ID, Kind: a.Kind, URL: a.URL, Title: a.Title, Repo: a.Repo, Ref: a.Ref,
			State: a.State, Checks: a.Checks, Data: a.Data, CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, UpdatedSeq: seq}
		if err := c.tx.Insert(c.ctx, l); err != nil {
			return err
		}
		if err := c.touch(t.ID, seq); err != nil {
			return err
		}
		return c.emit(seq, "link.created", "link", l.ID, "task", t.ID, t.ProjectID, map[string]any{"row": l, "key": t.Key})
	}
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("url", l.URL, orStr(a.URL, l.URL))
	p.put("title", l.Title, orStr(a.Title, l.Title))
	p.put("state", l.State, orStr(a.State, l.State))
	p.put("checks", l.Checks, orStr(a.Checks, l.Checks))
	if len(a.Data) > 0 && string(a.Data) != string(l.Data) {
		p.set["data"] = a.Data
		p.changes["data"] = core.FieldChange{To: a.Data}
	}
	if p.empty() {
		c.ref = l.ID
		return nil
	}
	p.set["updated_at"] = c.at
	if err := c.save(p, "task_links", "link", l.ID, "task", t.ID, t.ProjectID, map[string]any{"key": t.Key, "kind": l.Kind, "ref": l.Ref}); err != nil {
		return err
	}
	return c.touch(t.ID, c.tx.Seq())
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func linkRemove(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	l, err := get[core.TaskLink](c, "link", "id", a.ID)
	if err != nil {
		return err
	}
	var t core.Task
	if err := c.tx.Get(c.ctx, &t, store.Eq("id", l.TaskID)); err != nil {
		return err
	}
	return c.trash("task_links", "link", l.ID, "task", t.ID, t.ProjectID, nil)
}

// ---- watching ----

type watchSetArgs struct {
	Type     string `json:"type"`    // task (default), epic, project, view, doc
	Subject  string `json:"subject"` // its id, or a task key
	Watching *bool  `json:"watching"`
	User     string `json:"user"` // default: the caller
}

func watchSet(c *cx) error {
	var a watchSetArgs
	if err := c.args(&a); err != nil {
		return err
	}
	if a.Type == "" {
		a.Type = "task"
	}
	userID := c.actor.UserID
	if a.User != "" {
		m, err := c.memberRef("user", a.User)
		if err != nil {
			return err
		}
		userID = m.UserID
	}
	var subjectID, scopeType, projectID string
	scopeType = a.Type
	switch a.Type {
	case "task":
		t, err := c.task("subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID, projectID = t.ID, t.ProjectID
	case "epic":
		e, err := get[core.Epic](c, "epic", "subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID, projectID, scopeType = e.ID, e.ProjectID, "project"
	case "project":
		p, err := c.project(a.Subject)
		if err != nil {
			return err
		}
		subjectID, projectID = p.ID, p.ID
	case "view":
		v, err := get[core.View](c, "view", "subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID, scopeType = v.ID, "workspace"
	case "doc":
		d, err := get[core.Doc](c, "doc", "subject", a.Subject)
		if err != nil {
			return err
		}
		subjectID = d.ID
	default:
		return oneOf("type", "subject type", a.Type, []string{"task", "epic", "project", "view", "doc"})
	}
	scopeID := subjectID
	if scopeType == "project" {
		scopeID = projectID
	} else if scopeType == "workspace" {
		scopeID = c.ws
	}
	w := core.Watcher{WorkspaceID: c.ws, UserID: userID, SubjectType: a.Type, SubjectID: subjectID, CreatedAt: c.at}
	if a.Watching != nil && !*a.Watching {
		n, err := c.tx.Delete(c.ctx, "watchers", store.Eq("subject_id", subjectID), store.Eq("user_id", userID))
		if err != nil || n == 0 {
			return err
		}
		return c.emitTo(userID, c.tx.NextSeq(), "watcher.deleted", "watcher", subjectID, scopeType, scopeID, projectID,
			map[string]any{"id": subjectID, "gone": true, "user_id": userID})
	}
	if n, err := c.tx.Count(c.ctx, "watchers", store.Eq("subject_id", subjectID), store.Eq("user_id", userID)); err != nil || n > 0 {
		return err
	}
	if err := c.tx.Insert(c.ctx, w); err != nil {
		return err
	}
	return c.emitTo(userID, c.tx.NextSeq(), "watcher.created", "watcher", subjectID, scopeType, scopeID, projectID, map[string]any{"row": w})
}

// checkBudget refuses new work to an agent that has used up its week.
func (c *cx) checkBudget() error {
	b := c.actor.Budget
	if b == nil || c.system {
		return nil
	}
	cost, minutes, err := c.e.Usage(c.ctx, c.tx, c.actor.UserID, weekStart(c.at))
	if err != nil {
		return err
	}
	if b.CostMicros > 0 && cost >= b.CostMicros || b.Minutes > 0 && minutes >= b.Minutes {
		return &Error{Code: CodeBudget, Message: "this agent has used its budget for the week; finish or hand over what is open, and ask the person responsible to raise the limit"}
	}
	return nil
}

const maxHandoffs = 5

// checkHandoff stops a task from bouncing between agents with no person in
// between: after a few agent-to-agent hand-offs in a row, a person has to
// step in.
func (c *cx) checkHandoff(t core.Task) error {
	to, err := c.memberRef("assignee", t.AssigneeID)
	if err != nil || to.Kind != core.KindAgent {
		return err
	}
	evs, err := c.tx.Events(c.ctx, store.EventFilter{ScopeType: "task", ScopeID: t.ID, Types: []string{"task.updated", "task.created"}, Desc: true, Limit: 60})
	if err != nil {
		return err
	}
	chain := 0
	for _, ev := range evs {
		if !strings.Contains(string(ev.Data), `"assignee_id"`) {
			continue
		}
		var actor core.Member
		if err := c.tx.Get(c.ctx, &actor, store.Eq("user_id", ev.ActorID)); err != nil || actor.Kind != core.KindAgent {
			break // a person assigned it: the chain starts over
		}
		chain++
	}
	// A hand-off counts against a budget: the agent's for the week, and the
	// task's own.
	if b := c.actor.Budget; b != nil && b.Handoffs > 0 {
		mine, err := c.tx.Events(c.ctx, store.EventFilter{ActorID: c.actor.UserID, Types: []string{"task.updated"}, Desc: true, Limit: 2000})
		if err != nil {
			return err
		}
		var n int64
		for _, ev := range mine {
			if ev.At < weekStart(c.at) {
				break
			}
			if strings.Contains(string(ev.Data), `"assignee_id"`) {
				n++
			}
		}
		if n >= b.Handoffs {
			return &Error{Code: CodeBudget, Message: "this agent has passed work on " + itoa(int(n)) + " times this week, which is its limit; hand the task to a person"}
		}
	}
	if b := t.Budget; b != nil && b.Handoffs > 0 {
		var n int64
		for _, ev := range evs {
			var actor core.Member
			if strings.Contains(string(ev.Data), `"assignee_id"`) && c.tx.Get(c.ctx, &actor, store.Eq("user_id", ev.ActorID)) == nil && actor.Kind == core.KindAgent {
				n++
			}
		}
		if n >= b.Handoffs {
			return &Error{Code: CodeBudget, Message: t.Key + " has been passed between agents " + itoa(int(n)) + " times, which is its limit; hand it to a person"}
		}
	}
	if chain >= maxHandoffs {
		return &Error{Code: CodeConflict, Message: "this task has been handed from agent to agent " + itoa(chain) +
			" times in a row; hand it to a person (waiting_on or assignee) so they can decide where it goes"}
	}
	return nil
}

// weekStart returns the start of the week (Monday, UTC) containing at.
func weekStart(at int64) int64 {
	t := time.UnixMilli(at).UTC()
	wd := (int(t.Weekday()) + 6) % 7
	return time.Date(t.Year(), t.Month(), t.Day()-wd, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// isOutside reports whether a "waiting on" names no member but an outside
// event: a build, a delivery, a date, someone who is not here.
func isOutside(ref string) bool {
	switch strings.ToLower(strings.TrimSpace(ref)) {
	case "outside", "external", "event":
		return true
	}
	return false
}
