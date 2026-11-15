package engine

import (
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("relation.add", core.RoleMember, relationAdd)
	register("relation.remove", core.RoleMember, relationRemove)
}

type relationArgs struct {
	ID    string `json:"id"`
	Task  string `json:"task"`
	Type  string `json:"type"` // blocks, blocked_by, relates, duplicates
	Other string `json:"other"`
}

func relationAdd(c *cx, a relationArgs) error {
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

func relationRemove(c *cx, a idArgs) error {
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
