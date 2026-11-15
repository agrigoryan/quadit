package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

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

// saveOther saves a task changed as a side effect of a change to something
// else (its label was deleted, its epic removed): the change's answer still
// names what was asked for, not the last task it touched.
func (c *cx) saveOther(t core.Task, p *patch, extra map[string]any) error {
	ref, key := c.ref, c.key
	err := c.saveTask(t, p, extra)
	c.ref, c.key = ref, key
	return err
}

// setWaitingOutside makes a task wait on an outside event, as part of
// another change.
func (c *cx) setWaitingOutside(t core.Task, note string) error {
	p := newPatch()
	p.put("waiting_on_id", t.WaitingOnID, "")
	p.put("waiting_on_note", t.WaitingOnNote, note)
	p.put("waiting_outside", t.WaitingOutside, true)
	ref, key := c.ref, c.key
	err := c.saveTask(t, p, nil)
	c.ref, c.key = ref, key
	return err
}

// setWaitingOn hands a task to userID ("" = nobody) as part of another
// change, and says so in the feed.
func (c *cx) setWaitingOn(t core.Task, userID, note string) error {
	p := newPatch()
	p.put("waiting_on_id", t.WaitingOnID, userID)
	p.put("waiting_on_note", t.WaitingOnNote, note)
	p.put("waiting_outside", t.WaitingOutside, false)
	ref, key := c.ref, c.key
	err := c.saveTask(t, p, nil)
	c.ref, c.key = ref, key
	return err
}
