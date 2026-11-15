// task.move: a task to another project.

package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("task.move", core.RoleMember, taskMove)
}

type taskMoveArgs struct {
	ID      string `json:"id"`
	Project string `json:"project"`
}

// taskMove moves a task to another project. It gets a new number there; its
// status becomes the nearest one of the same category, and labels, epic and
// cycle that belong to the old project are dropped.
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
	st, err := c.nearestStatus(to, t.StatusID)
	if err != nil {
		return err
	}
	n, err := c.tx.Incr(c.ctx, "projects", "task_counter", 1, store.Eq("id", to.ID))
	if err != nil {
		return err
	}
	oldKey, oldProject := t.Key, t.ProjectID
	if err := c.tx.Upsert(c.ctx, core.TaskKey{WorkspaceID: c.ws, Key: oldKey, TaskID: t.ID, At: c.at}, "workspace_id", "key"); err != nil {
		return err
	}
	p := newPatch()
	p.put("project_id", t.ProjectID, to.ID)
	p.put("number", t.Number, int(n))
	p.put("key", t.Key, to.Key+"-"+itoa(int(n)))
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
	t.ProjectID, t.Number, t.Key = to.ID, int(n), to.Key+"-"+itoa(int(n))
	if err := c.saveTask(t, p, core.EventData{MovedFrom: oldKey, FromProjectID: oldProject}); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "task", EntityID: t.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: t.Key + " " + t.Title, Body: t.Description})
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
