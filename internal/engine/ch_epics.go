package engine

import (
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("epic.create", core.RoleMember, epicCreate)
	register("epic.update", core.RoleMember, epicUpdate)
	register("epic.delete", core.RoleMember, epicDelete)
}

type epicCreateArgs struct {
	ID          string `json:"id"`
	Project     string `json:"project"`
	Name        string `json:"name"`
	Description string `json:"description"`
	State       string `json:"state"`
	Lead        string `json:"lead"`
	Color       string `json:"color"`
	Icon        string `json:"icon"`
	StartOn     string `json:"start_on"`
	TargetOn    string `json:"target_on"`
	Rank        string `json:"rank"`
}

func epicCreate(c *cx, a epicCreateArgs) error {
	eid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	project, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "an epic needs a name")
	}
	if a.State == "" {
		a.State = core.EpicPlanned
	}
	if !slices.Contains(core.EpicStates, a.State) {
		return oneOf("state", "epic state", a.State, core.EpicStates)
	}
	lead, err := c.optMember("lead", a.Lead)
	if err != nil {
		return err
	}
	if err := checkDate("start_on", a.StartOn); err != nil {
		return err
	}
	if err := checkDate("target_on", a.TargetOn); err != nil {
		return err
	}
	rk := a.Rank
	if rk == "" {
		if rk, err = nextRank[core.Epic](c, store.Eq("project_id", project.ID)); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	e := core.Epic{ID: eid, WorkspaceID: c.ws, ProjectID: project.ID, Name: strings.TrimSpace(a.Name), Description: a.Description, State: a.State,
		LeadID: lead, Color: a.Color, Icon: a.Icon, StartOn: a.StartOn, TargetOn: a.TargetOn, Rank: rk,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, UpdatedSeq: seq}
	if e.State == core.EpicDone {
		e.CompletedAt = c.at
	}
	if err := c.tx.Insert(c.ctx, e); err != nil {
		return alreadyInUse(err, "id", eid)
	}
	if err := c.watch(c.actor.UserID, "epic", e.ID); err != nil {
		return err
	}
	if err := c.index(store.SearchDoc{Kind: "epic", EntityID: e.ID, ScopeType: "epic", ScopeID: e.ID, ProjectID: project.ID, Title: e.Name, Body: e.Description}); err != nil {
		return err
	}
	return c.created(seq, "epic", e.ID, inProject(project.ID), e)
}

type epicUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Description Opt[string] `json:"description"`
	State       Opt[string] `json:"state"`
	Lead        Opt[string] `json:"lead"`
	Color       Opt[string] `json:"color"`
	Icon        Opt[string] `json:"icon"`
	StartOn     Opt[string] `json:"start_on"`
	TargetOn    Opt[string] `json:"target_on"`
	Rank        Opt[string] `json:"rank"`
}

func epicUpdate(c *cx, a epicUpdateArgs) error {
	e, err := loadLive[core.Epic](c, "epic", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &e.Name); err != nil {
		return err
	}
	p.setText("description", a.Description, &e.Description)
	if a.State.Set {
		if !slices.Contains(core.EpicStates, a.State.V) {
			return oneOf("state", "epic state", a.State.V, core.EpicStates)
		}
		was := e.State
		p.setText("state", a.State, &e.State)
		if e.State == core.EpicDone && was != core.EpicDone {
			p.put("completed_at", e.CompletedAt, c.at)
		} else if e.State != core.EpicDone && e.CompletedAt != 0 {
			p.put("completed_at", e.CompletedAt, int64(0))
		}
	}
	if a.Lead.Set {
		lead := ""
		if !a.Lead.Null {
			if lead, err = c.optMember("lead", a.Lead.V); err != nil {
				return err
			}
		}
		p.put("lead_id", e.LeadID, lead)
	}
	p.setText("color", a.Color, &e.Color)
	p.setText("icon", a.Icon, &e.Icon)
	if err := p.date("start_on", a.StartOn, &e.StartOn); err != nil {
		return err
	}
	if err := p.date("target_on", a.TargetOn, &e.TargetOn); err != nil {
		return err
	}
	if err := p.rank(a.Rank, &e.Rank); err != nil {
		return err
	}
	if !p.empty() {
		p.set["updated_at"] = c.at
	}
	if err := c.save(p, target{table: "epics", entity: "epic", id: e.ID, place: inProject(e.ProjectID)}); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "epic", EntityID: e.ID, ScopeType: "epic", ScopeID: e.ID, ProjectID: e.ProjectID, Title: e.Name, Body: e.Description})
}

func epicDelete(c *cx, a idArgs) error {
	e, err := loadLive[core.Epic](c, "epic", "id", a.ID)
	if err != nil {
		return err
	}
	// Its tasks stay, without an epic.
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{EpicIDs: []string{e.ID}, Archived: true, Limit: scanLimit})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		tp := newPatch()
		tp.put("epic_id", t.EpicID, "")
		tp.put("milestone_id", t.MilestoneID, "")
		if err := c.saveOther(t, tp, nil); err != nil {
			return err
		}
	}
	if err := c.tx.Unindex(c.ctx, e.ID); err != nil {
		return err
	}
	return c.trash(target{table: "epics", entity: "epic", id: e.ID, place: inProject(e.ProjectID)})
}
