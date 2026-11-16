// task.take and task.release: leases on a task.

package engine

import (
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("task.take", core.RoleMember, taskTake)
	register("task.release", core.RoleMember, taskRelease)
}

// defaultLeaseMinutes is how long a hold on a task or a resource
// (resource.acquire) lasts without renewing, unless the one taking it says;
// maxLeaseMinutes the longest it may.
const (
	defaultLeaseMinutes = 30
	maxLeaseMinutes     = 24 * 60
)

type taskTakeArgs struct {
	ID string `json:"id" quadit:"required,handler"`
	// Minutes is how long the lease lasts without being renewed. Taking a
	// task you already hold renews it.
	Minutes int `json:"minutes"`
}

// taskTake makes the caller the one working on a task. Two cannot take the
// same task: the second is told who has it and until when. The lease ends
// by itself if it is not renewed, so a task held by a stopped agent frees up.
func taskTake(c *cx, a taskTakeArgs) error {
	t, err := c.task("id", a.ID)
	if err != nil {
		return err
	}
	if err := c.checkTaskBudget(t); err != nil {
		return err
	}
	if a.Minutes <= 0 {
		a.Minutes = defaultLeaseMinutes
	}
	if a.Minutes > maxLeaseMinutes {
		return invalid("minutes", "a lease lasts at most 1440 minutes; renew it by taking the task again")
	}
	if err := c.refuseHeld(t); err != nil {
		return err
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
	p.put("lease_until", t.LeaseUntil, c.at+int64(a.Minutes)*msPerMinute)
	newAssignee := ""
	if t.AssigneeID != c.actor.UserID {
		p.put("assignee_id", t.AssigneeID, c.actor.UserID)
		t.AssigneeID = c.actor.UserID
		newAssignee = c.actor.UserID
		if c.actor.Kind != core.KindAgent {
			p.put("asked_by", t.AskedBy, "") // a person holds it now
			t.AskedBy = ""
		}
	}
	if t.WaitingOnID == c.actor.UserID {
		p.put("waiting_on_id", t.WaitingOnID, "")
		p.put("waiting_on_note", t.WaitingOnNote, "")
	}
	if err := c.markStarted(p, &t, pr, cur); err != nil {
		return err
	}
	if err := c.saveTask(t, p, core.EventData{}); err != nil {
		return err
	}
	return c.afterTaskPeople(t, newAssignee, "")
}

// refuseHeld refuses to take a task someone else holds a live lease on,
// saying who and until when.
func (c *cx) refuseHeld(t core.Task) error {
	if t.LeaseHolderID == "" || t.LeaseHolderID == c.actor.UserID || t.LeaseUntil <= c.at {
		return nil
	}
	holder := t.LeaseHolderID
	m, err := c.memberRef("id", t.LeaseHolderID)
	if err != nil && !isRefusal(err) {
		return err
	}
	if err == nil {
		holder = "@" + m.Handle
	}
	return conflictErr("%s is held by %s until %s", t.Key, holder, time.UnixMilli(t.LeaseUntil).UTC().Format(time.RFC3339))
}

// markStarted moves a task that was not started yet to its project's first
// started status, when it has one.
func (c *cx) markStarted(p *patch, t *core.Task, pr core.Project, cur core.Status) error {
	if cur.Category != core.CatBacklog && cur.Category != core.CatUnstarted {
		return nil
	}
	st, err := c.status(pr, "status", core.CatStarted)
	if isRefusal(err) {
		return nil
	}
	if err != nil {
		return err
	}
	c.setStatus(p, t, st)
	return nil
}

func taskRelease(c *cx, a idArgs) error {
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
	return c.saveTask(t, p, core.EventData{})
}
