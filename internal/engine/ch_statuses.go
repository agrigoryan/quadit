// status.create, status.update and status.delete.

package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers status.*.
func init() {
	register("status.create", core.RoleAdmin, statusCreate)
	register("status.update", core.RoleAdmin, statusUpdate)
	register("status.delete", core.RoleAdmin, statusDelete)
}

type statusCreateArgs struct {
	ID       string `json:"id"`
	Project  string `json:"project"`
	Name     string `json:"name"`
	Category string `json:"category"`
	Color    string `json:"color"`
	Rank     string `json:"rank"`
}

// statusCreate adds a status to a project's workflow.
func statusCreate(c *cx, a statusCreateArgs) error {
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	project, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a status needs a name")
	}
	if !core.ValidCategory(a.Category) {
		return oneOf("category", "category", a.Category, core.Categories)
	}
	rk := a.Rank
	if rk == "" {
		// A new status goes after the last one of its category.
		all, err := c.statuses(project.ID)
		if err != nil {
			return err
		}
		order := map[string]int{}
		for i, k := range core.Categories {
			order[k] = i
		}
		prev, next := "", ""
		for _, s := range all {
			if order[s.Category] <= order[a.Category] {
				prev = s.Rank
			} else if next == "" {
				next = s.Rank
			}
		}
		rk = rank.Between(prev, next)
	} else if !rank.Valid(rk) {
		return invalid("rank", "%q is not a rank", rk)
	}
	seq := c.tx.NextSeq()
	st := core.Status{ID: sid, WorkspaceID: c.ws, ProjectID: project.ID, Name: strings.TrimSpace(a.Name), Color: a.Color,
		Category: a.Category, Rank: rk, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, st); err != nil {
		return alreadyInUse(err, "status name", st.Name)
	}
	return c.created(seq, "status", st.ID, inProject(project.ID), st)
}

type statusUpdateArgs struct {
	ID        string      `json:"id"`
	Name      Opt[string] `json:"name"`
	Category  Opt[string] `json:"category"`
	Color     Opt[string] `json:"color"`
	Rank      Opt[string] `json:"rank"`
	IsDefault Opt[bool]   `json:"is_default"`
}

// statusUpdate changes a status; making it the default takes that from the
// one before.
func statusUpdate(c *cx, a statusUpdateArgs) error {
	st, err := loadLive[core.Status](c, "status", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &st.Name); err != nil {
		return err
	}
	if a.Category.Set {
		if !core.ValidCategory(a.Category.V) {
			return oneOf("category", "category", a.Category.V, core.Categories)
		}
		p.setText("category", a.Category, &st.Category)
	}
	p.setText("color", a.Color, &st.Color)
	if err := p.rank(a.Rank, &st.Rank); err != nil {
		return err
	}
	if a.IsDefault.Set && a.IsDefault.V && !st.IsDefault {
		// One default per project: the old one steps down.
		all, err := c.statuses(st.ProjectID)
		if err != nil {
			return err
		}
		for _, o := range all {
			if o.IsDefault {
				op := newPatch()
				op.put("is_default", true, false)
				if err := c.save(op, target{table: "statuses", entity: "status", id: o.ID, place: inProject(st.ProjectID)}); err != nil {
					return err
				}
			}
		}
		p.put("is_default", false, true)
	}
	return alreadyInUse(c.save(p, target{table: "statuses", entity: "status", id: st.ID, place: inProject(st.ProjectID)}), "status name", st.Name)
}

type statusDeleteArgs struct {
	ID     string `json:"id"`
	MoveTo string `json:"move_to"` // where its tasks go
}

// statusDelete puts a status in the trash, once its tasks are moved to
// another.
func statusDelete(c *cx, a statusDeleteArgs) error {
	st, err := loadLive[core.Status](c, "status", "id", a.ID)
	if err != nil {
		return err
	}
	var pr core.Project
	if err := c.tx.Get(c.ctx, &pr, store.Eq("id", st.ProjectID)); err != nil {
		return err
	}
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{StatusIDs: []string{st.ID}, Archived: true, Limit: scanLimit})
	if err != nil {
		return err
	}
	trashed, err := c.tx.Tasks(c.ctx, store.TaskFilter{StatusIDs: []string{st.ID}, InTrash: true, Limit: scanLimit})
	if err != nil {
		return err
	}
	tasks = append(tasks, trashed...)
	if len(tasks) > 0 || st.IsDefault {
		if err := c.moveOffStatus(st, pr, a.MoveTo, tasks); err != nil {
			return err
		}
	}
	return c.trash(target{table: "statuses", entity: "status", id: st.ID, place: inProject(pr.ID)})
}

// moveOffStatus moves the tasks of a status being deleted to another, which
// also takes over being the default when the deleted one was.
func (c *cx) moveOffStatus(st core.Status, pr core.Project, moveTo string, tasks []core.Task) error {
	if moveTo == "" {
		return invalid("move_to", "%d tasks have this status: say where they go with move_to", len(tasks))
	}
	to, err := c.status(pr, "move_to", moveTo)
	if err != nil {
		return err
	}
	if to.ID == st.ID {
		return invalid("move_to", "move_to must be another status")
	}
	for _, t := range tasks {
		tp := newPatch()
		c.setStatus(tp, &t, to)
		if err := c.saveOther(t, tp, core.EventData{}); err != nil {
			return err
		}
	}
	if !st.IsDefault {
		return nil
	}
	defaultPatch := newPatch()
	defaultPatch.put("is_default", false, true)
	return c.save(defaultPatch, target{table: "statuses", entity: "status", id: to.ID, place: inProject(pr.ID)})
}
