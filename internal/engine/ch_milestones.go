// milestone.create, milestone.update and milestone.delete.

package engine

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// init registers milestone.*.
func init() {
	register("milestone.create", core.RoleMember, milestoneCreate)
	register("milestone.update", core.RoleMember, milestoneUpdate)
	register("milestone.delete", core.RoleMember, milestoneDelete)
}

type milestoneCreateArgs struct {
	ID          string `json:"id"`
	Epic        string `json:"epic"`
	Name        string `json:"name"`
	Description string `json:"description"`
	TargetOn    string `json:"target_on"`
	Rank        string `json:"rank"`
}

// milestoneCreate adds a milestone to an epic.
func milestoneCreate(c *cx, a milestoneCreateArgs) error {
	mid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	e, err := loadLive[core.Epic](c, "epic", "epic", a.Epic)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a milestone needs a name")
	}
	if err := checkDate("target_on", a.TargetOn); err != nil {
		return err
	}
	rk := a.Rank
	if rk == "" {
		if rk, err = nextRank[core.Milestone](c, store.Eq("epic_id", e.ID)); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	m := core.Milestone{ID: mid, WorkspaceID: c.ws, EpicID: e.ID, Name: strings.TrimSpace(a.Name), Description: a.Description,
		TargetOn: a.TargetOn, Rank: rk, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, m); err != nil {
		return alreadyInUse(err, "id", mid)
	}
	return c.created(seq, "milestone", m.ID, inProject(e.ProjectID), m)
}

type milestoneUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Description Opt[string] `json:"description"`
	TargetOn    Opt[string] `json:"target_on"`
	Rank        Opt[string] `json:"rank"`
}

func (c *cx) milestoneEpic(ref string) (core.Milestone, core.Epic, error) {
	m, err := loadLive[core.Milestone](c, "milestone", "id", ref)
	if err != nil {
		return m, core.Epic{}, err
	}
	var e core.Epic
	return m, e, c.tx.Get(c.ctx, &e, store.Eq("id", m.EpicID))
}

func milestoneUpdate(c *cx, a milestoneUpdateArgs) error {
	m, e, err := c.milestoneEpic(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &m.Name); err != nil {
		return err
	}
	p.setText("description", a.Description, &m.Description)
	if err := p.date("target_on", a.TargetOn, &m.TargetOn); err != nil {
		return err
	}
	if err := p.rank(a.Rank, &m.Rank); err != nil {
		return err
	}
	return c.save(p, target{table: "milestones", entity: "milestone", id: m.ID, place: inProject(e.ProjectID)})
}

func milestoneDelete(c *cx, a idArgs) error {
	m, e, err := c.milestoneEpic(a.ID)
	if err != nil {
		return err
	}
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{MilestoneID: m.ID, Archived: true, Limit: scanLimit})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		tp := newPatch()
		tp.put("milestone_id", t.MilestoneID, "")
		if err := c.saveOther(t, tp, nil); err != nil {
			return err
		}
	}
	return c.trash(target{table: "milestones", entity: "milestone", id: m.ID, place: inProject(e.ProjectID)})
}
