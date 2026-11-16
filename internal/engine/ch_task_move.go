// task.move: a task to another project.

package engine

import (
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("task.move", core.RoleMember, taskMove)
}

type taskMoveArgs struct {
	ID      string `json:"id" quadit:"required,handler"`
	Project string `json:"project" quadit:"required,handler"`
}

// taskMove moves a task to another project. It gets a new number there, or
// the one it had there before (see takeNumberIn), and its old key still
// finds it; its status becomes the nearest one of the same category, and
// labels, epic and cycle that belong to the old project are dropped. It is
// refused while the task is given to, waits on or asks a member who cannot
// read the new project (see personOnTask).
func taskMove(c *cx, a taskMoveArgs) error {
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
	if err := c.checkPeopleCanFollow(t, to); err != nil {
		return err
	}
	st, err := c.nearestStatus(to, t.StatusID)
	if err != nil {
		return err
	}
	oldKey, oldProject := t.Key, t.ProjectID
	if err := c.tx.Upsert(c.ctx, core.TaskKey{WorkspaceID: c.ws, Key: oldKey, TaskID: t.ID, At: c.at}, "workspace_id", "key"); err != nil {
		return err
	}
	n, err := c.takeNumberIn(to, t.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.put("project_id", t.ProjectID, to.ID)
	p.put("number", t.Number, n)
	p.put("key", t.Key, to.Key+"-"+strconv.Itoa(n))
	p.put("status_id", t.StatusID, st.ID)
	p.put("epic_id", t.EpicID, "")
	p.put("milestone_id", t.MilestoneID, "")
	p.put("cycle_id", t.CycleID, "")
	keep, err := c.labelsIn(to, t.LabelIDs)
	if err != nil {
		return err
	}
	if err := c.setLabels(p, &t, keep); err != nil {
		return err
	}
	t.ProjectID, t.Number, t.Key = to.ID, n, to.Key+"-"+strconv.Itoa(n)
	if err := c.saveTask(t, p, core.EventData{MovedFrom: oldKey, FromProjectID: oldProject}); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "task", EntityID: t.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: t.Key + " " + t.Title, Body: t.Description})
}

// takeNumberIn is the number a task moving to project to takes there. A
// task that was there before takes back its number there (that of its most
// recent old key that starts with the project's key), so a move that is
// undone leaves the task as it was; that key is its own again, no longer an
// old one. A number another task holds now (the key went to another project
// meanwhile) is not taken. Otherwise the task takes the project's next
// number.
func (c *cx) takeNumberIn(to core.Project, taskID string) (int, error) {
	var old []core.TaskKey
	if err := c.tx.List(c.ctx, &old, store.Q{Where: []store.Cond{store.Eq("task_id", taskID)}, Order: "-at"}); err != nil {
		return 0, err
	}
	for _, k := range old {
		prefix, number, _ := strings.Cut(k.Key, "-")
		n, err := strconv.Atoi(number)
		if prefix != to.Key || err != nil || n <= 0 {
			continue
		}
		taken, err := c.tx.Count(c.ctx, "tasks", store.Eq("project_id", to.ID), store.Eq("number", n))
		if err != nil {
			return 0, err
		}
		held, err := c.tx.Count(c.ctx, "tasks", store.Eq("key", k.Key))
		if err != nil {
			return 0, err
		}
		if taken+held > 0 {
			continue
		}
		if _, err := c.tx.Delete(c.ctx, "task_keys", store.Eq("key", k.Key)); err != nil {
			return 0, err
		}
		return n, nil
	}
	n, err := c.tx.Incr(c.ctx, "projects", "task_counter", 1, store.Eq("id", to.ID))
	return int(n), err
}

// checkPeopleCanFollow refuses to move a task to a project that a member
// whose work it is cannot read: its assignee, the one it waits on, the one
// an open decision of it asks. The rule is personOnTask's: they could not
// open the task where it goes. task.move does not change who is on the
// task, so the refusal says what to do first.
func (c *cx) checkPeopleCanFollow(t core.Task, to core.Project) error {
	on := map[string][]string{} // user id: what they are on the task as
	var order []string
	add := func(userID, as string) {
		if userID == "" {
			return
		}
		if on[userID] == nil {
			order = append(order, userID)
		}
		on[userID] = append(on[userID], as)
	}
	add(t.AssigneeID, "assignee")
	add(t.WaitingOnID, "waiting_on")
	var open []core.Decision
	if err := c.tx.List(c.ctx, &open, store.Where(store.Eq("task_id", t.ID), store.Eq("state", core.StateOpen), store.Live)); err != nil {
		return err
	}
	for _, d := range open {
		add(d.AskedID, "asked")
	}
	var kept []string
	for _, userID := range order {
		var m core.Member
		there, err := store.Find(c.ctx, c.tx, &m, store.Eq("user_id", userID), store.Null("removed_at"))
		if err != nil {
			return err
		}
		if there && !m.Scope.MayRead(to.ID) {
			kept = append(kept, "@"+m.Handle+" ("+strings.Join(on[userID], ", ")+")")
		}
	}
	if kept == nil {
		return nil
	}
	return invalid("project", "%s cannot read %s, so %s cannot go there while it is theirs: give it to someone else or clear them (task.update; a decision with decision.delete) first, then move it",
		strings.Join(kept, ", "), to.Key, t.Key)
}

// nearestStatus is the status a task moved to project to takes: the one of
// the same name, else the first of the same category, else the default.
func (c *cx) nearestStatus(to core.Project, statusID string) (core.Status, error) {
	var cur core.Status
	if err := c.tx.Get(c.ctx, &cur, store.Eq("id", statusID)); err != nil {
		return cur, err
	}
	for _, ref := range []string{cur.Name, cur.Category} {
		st, err := c.status(to, "status", ref)
		if !isRefusal(err) {
			return st, err
		}
	}
	return c.defaultStatus(to)
}

// labelsIn is the labels a task moved to project to keeps: the workspace's
// own, and for each of the old project's the new project's label of the
// same name, when it has one.
func (c *cx) labelsIn(to core.Project, labelIDs []string) ([]string, error) {
	var keep []string
	for _, lid := range labelIDs {
		var l core.Label
		ok, err := store.Find(c.ctx, c.tx, &l, store.Eq("id", lid))
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if l.ProjectID == "" {
			keep = append(keep, lid)
			continue
		}
		var same []core.Label
		if err := c.tx.List(c.ctx, &same, store.Where(store.Eq("project_id", to.ID), store.Live)); err != nil {
			return nil, err
		}
		for _, s := range same {
			if strings.EqualFold(s.Name, l.Name) {
				keep = append(keep, s.ID)
				break
			}
		}
	}
	return keep, nil
}
