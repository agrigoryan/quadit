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
	var keep []string
	for _, lid := range t.LabelIDs {
		var l core.Label
		if err := c.tx.Get(c.ctx, &l, store.Eq("id", lid)); err != nil {
			continue
		}
		if l.ProjectID == "" {
			keep = append(keep, lid)
			continue
		}
		// A label of the old project: the new project's label of the same
		// name takes its place, when it has one.
		var same []core.Label
		if err := c.tx.List(c.ctx, &same, store.Where(store.Eq("project_id", to.ID), store.Live)); err != nil {
			return err
		}
		for _, s := range same {
			if strings.EqualFold(s.Name, l.Name) {
				keep = append(keep, s.ID)
				break
			}
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
