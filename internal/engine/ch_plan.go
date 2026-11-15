package engine

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("epic.create", core.RoleMember, epicCreate)
	register("epic.update", core.RoleMember, epicUpdate)
	register("epic.delete", core.RoleMember, epicDelete)
	register("milestone.create", core.RoleMember, milestoneCreate)
	register("milestone.update", core.RoleMember, milestoneUpdate)
	register("milestone.delete", core.RoleMember, milestoneDelete)
	register("cycle.create", core.RoleMember, cycleCreate)
	register("cycle.update", core.RoleMember, cycleUpdate)
	register("cycle.delete", core.RoleMember, cycleDelete)
	register("view.create", core.RoleMember, viewCreate)
	register("view.update", core.RoleMember, viewUpdate)
	register("view.delete", core.RoleMember, viewDelete)
	register("template.create", core.RoleMember, templateCreate)
	register("template.update", core.RoleMember, templateUpdate)
	register("template.delete", core.RoleMember, templateDelete)
}

// sub runs another change type inside this one, as the same actor.
func (c *cx) sub(changeType string, args any) error {
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	saved, ref, key := c.change, c.ref, c.key
	c.change = Change{ID: saved.ID, Type: changeType, Args: raw}
	err = handlers[changeType].fn(c)
	c.subRef = c.ref
	c.change, c.ref, c.key = saved, ref, key
	return err
}

// ---- epics ----

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

func epicCreate(c *cx) error {
	var a epicCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	eid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	p, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "an epic needs a name")
	}
	if a.State == "" {
		a.State = core.EpicPlanned
	}
	if !contains(core.EpicStates, a.State) {
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
		if rk, err = nextRank[core.Epic](c, store.Eq("project_id", p.ID)); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	e := core.Epic{ID: eid, WorkspaceID: c.ws, ProjectID: p.ID, Name: strings.TrimSpace(a.Name), Description: a.Description, State: a.State,
		LeadID: lead, Color: a.Color, Icon: a.Icon, StartOn: a.StartOn, TargetOn: a.TargetOn, Rank: rk,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at, UpdatedSeq: seq}
	if e.State == core.EpicDone {
		e.CompletedAt = c.at
	}
	if err := c.tx.Insert(c.ctx, e); err != nil {
		return taken(err, "id", eid)
	}
	if err := c.watch(c.actor.UserID, "epic", e.ID); err != nil {
		return err
	}
	if err := c.index("epic", e.ID, "epic", e.ID, p.ID, "", e.Name, e.Description); err != nil {
		return err
	}
	return c.created(seq, "epic", e.ID, "project", p.ID, p.ID, e)
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

func epicUpdate(c *cx) error {
	var a epicUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	e, err := get[core.Epic](c, "epic", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &e.Name); err != nil {
		return err
	}
	p.str("description", a.Description, &e.Description)
	if a.State.Set {
		if !contains(core.EpicStates, a.State.V) {
			return oneOf("state", "epic state", a.State.V, core.EpicStates)
		}
		was := e.State
		p.str("state", a.State, &e.State)
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
	p.str("color", a.Color, &e.Color)
	p.str("icon", a.Icon, &e.Icon)
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
	if err := c.save(p, "epics", "epic", e.ID, "project", e.ProjectID, e.ProjectID, nil); err != nil {
		return err
	}
	return c.index("epic", e.ID, "epic", e.ID, e.ProjectID, "", e.Name, e.Description)
}

func epicDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	e, err := get[core.Epic](c, "epic", "id", a.ID)
	if err != nil {
		return err
	}
	// Its tasks stay, without an epic.
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{EpicIDs: []string{e.ID}, Archived: true, Limit: 5000})
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
	return c.trash("epics", "epic", e.ID, "project", e.ProjectID, e.ProjectID, nil)
}

// ---- milestones ----

type milestoneCreateArgs struct {
	ID          string `json:"id"`
	Epic        string `json:"epic"`
	Name        string `json:"name"`
	Description string `json:"description"`
	TargetOn    string `json:"target_on"`
	Rank        string `json:"rank"`
}

func milestoneCreate(c *cx) error {
	var a milestoneCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	mid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	e, err := get[core.Epic](c, "epic", "epic", a.Epic)
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
		return taken(err, "id", mid)
	}
	return c.created(seq, "milestone", m.ID, "project", e.ProjectID, e.ProjectID, m)
}

type milestoneUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Description Opt[string] `json:"description"`
	TargetOn    Opt[string] `json:"target_on"`
	Rank        Opt[string] `json:"rank"`
}

func (c *cx) milestoneEpic(ref string) (core.Milestone, core.Epic, error) {
	m, err := get[core.Milestone](c, "milestone", "id", ref)
	if err != nil {
		return m, core.Epic{}, err
	}
	var e core.Epic
	return m, e, c.tx.Get(c.ctx, &e, store.Eq("id", m.EpicID))
}

func milestoneUpdate(c *cx) error {
	var a milestoneUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	m, e, err := c.milestoneEpic(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &m.Name); err != nil {
		return err
	}
	p.str("description", a.Description, &m.Description)
	if err := p.date("target_on", a.TargetOn, &m.TargetOn); err != nil {
		return err
	}
	if err := p.rank(a.Rank, &m.Rank); err != nil {
		return err
	}
	return c.save(p, "milestones", "milestone", m.ID, "project", e.ProjectID, e.ProjectID, nil)
}

func milestoneDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	m, e, err := c.milestoneEpic(a.ID)
	if err != nil {
		return err
	}
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{MilestoneID: m.ID, Archived: true, Limit: 5000})
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
	return c.trash("milestones", "milestone", m.ID, "project", e.ProjectID, e.ProjectID, nil)
}

// ---- cycles ----

type cycleCreateArgs struct {
	ID       string `json:"id"`
	Project  string `json:"project"`
	Name     string `json:"name"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
}

func (c *cx) cycleOverlap(projectID, skipID, starts, ends string) error {
	var all []core.Cycle
	if err := c.tx.List(c.ctx, &all, store.Where(store.Eq("project_id", projectID), store.Live)); err != nil {
		return err
	}
	for _, o := range all {
		if o.ID != skipID && starts <= o.EndsOn && o.StartsOn <= ends {
			return conflictErr("those dates overlap cycle %d (%s to %s)", o.Number, o.StartsOn, o.EndsOn)
		}
	}
	return nil
}

func cycleCreate(c *cx) error {
	var a cycleCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	p, err := c.project(a.Project)
	if err != nil {
		return err
	}
	if a.StartsOn == "" || a.EndsOn == "" {
		return invalid("starts_on", "a cycle needs starts_on and ends_on (YYYY-MM-DD)")
	}
	if err := checkDate("starts_on", a.StartsOn); err != nil {
		return err
	}
	if err := checkDate("ends_on", a.EndsOn); err != nil {
		return err
	}
	if a.EndsOn < a.StartsOn {
		return invalid("ends_on", "a cycle ends on or after the day it starts")
	}
	if err := c.cycleOverlap(p.ID, "", a.StartsOn, a.EndsOn); err != nil {
		return err
	}
	n, err := c.tx.Incr(c.ctx, "projects", "cycle_counter", 1, store.Eq("id", p.ID))
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	cy := core.Cycle{ID: cid, WorkspaceID: c.ws, ProjectID: p.ID, Number: int(n), Name: strings.TrimSpace(a.Name),
		StartsOn: a.StartsOn, EndsOn: a.EndsOn, CreatedAt: c.at, UpdatedSeq: seq}
	if err := c.tx.Insert(c.ctx, cy); err != nil {
		return taken(err, "id", cid)
	}
	return c.created(seq, "cycle", cy.ID, "project", p.ID, p.ID, cy)
}

type cycleUpdateArgs struct {
	ID       string      `json:"id"`
	Name     Opt[string] `json:"name"`
	StartsOn Opt[string] `json:"starts_on"`
	EndsOn   Opt[string] `json:"ends_on"`
}

func cycleUpdate(c *cx) error {
	var a cycleUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cy, err := get[core.Cycle](c, "cycle", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.str("name", a.Name, &cy.Name)
	if err := p.date("starts_on", a.StartsOn, &cy.StartsOn); err != nil {
		return err
	}
	if err := p.date("ends_on", a.EndsOn, &cy.EndsOn); err != nil {
		return err
	}
	if cy.StartsOn == "" || cy.EndsOn < cy.StartsOn {
		return invalid("ends_on", "a cycle ends on or after the day it starts")
	}
	if err := c.cycleOverlap(cy.ProjectID, cy.ID, cy.StartsOn, cy.EndsOn); err != nil {
		return err
	}
	return c.save(p, "cycles", "cycle", cy.ID, "project", cy.ProjectID, cy.ProjectID, nil)
}

func cycleDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	cy, err := get[core.Cycle](c, "cycle", "id", a.ID)
	if err != nil {
		return err
	}
	tasks, err := c.tx.Tasks(c.ctx, store.TaskFilter{CycleIDs: []string{cy.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	for _, t := range tasks {
		tp := newPatch()
		tp.put("cycle_id", t.CycleID, "")
		if err := c.saveOther(t, tp, nil); err != nil {
			return err
		}
	}
	return c.trash("cycles", "cycle", cy.ID, "project", cy.ProjectID, cy.ProjectID, nil)
}

// RollCycles keeps every project that uses cycles supplied with a current
// and a next cycle, and moves what was not finished in an ended cycle into
// the one after it. It is safe to run as often as wanted.
func (e *Engine) RollCycles(ctx context.Context) error {
	var projects []core.Project
	if err := e.st.List(ctx, &projects, store.Where(store.Live, store.Null("archived_at"))); err != nil {
		return err
	}
	today := e.now().UTC().Format("2006-01-02")
	for _, p := range projects {
		if p.Settings == nil || !p.Settings.Cycles {
			continue
		}
		if err := e.System(ctx, p.WorkspaceID, p.CreatedBy, func(s *Sys) error { return s.c.rollProject(p, today) }); err != nil {
			return err
		}
	}
	return nil
}

func (c *cx) rollProject(p core.Project, today string) error {
	days := p.Settings.CycleDays
	if days <= 0 {
		days = 14
	}
	var all []core.Cycle
	if err := c.tx.List(c.ctx, &all, store.Q{Where: []store.Cond{store.Eq("project_id", p.ID), store.Live}, Order: "starts_on"}); err != nil {
		return err
	}
	// Make cycles until one starts after today.
	last := ""
	if len(all) > 0 {
		last = all[len(all)-1].EndsOn
	}
	for last <= today || !hasFuture(all, today) {
		start := today
		if last != "" {
			start = addDays(last, 1)
		} else {
			// The first cycle starts on the project's cycle weekday.
			t, _ := time.Parse("2006-01-02", today)
			back := (int(t.Weekday()) - p.Settings.CycleStart + 7) % 7
			start = addDays(today, -back)
		}
		end := addDays(start, days-1)
		if err := c.sub("cycle.create", cycleCreateArgs{ID: id.New(), Project: p.ID, StartsOn: start, EndsOn: end}); err != nil {
			return err
		}
		all = append(all, core.Cycle{StartsOn: start, EndsOn: end})
		last = end
		if len(all) > 400 {
			break
		}
	}
	if err := c.tx.List(c.ctx, &all, store.Q{Where: []store.Cond{store.Eq("project_id", p.ID), store.Live}, Order: "starts_on"}); err != nil {
		return err
	}
	// Roll unfinished work out of cycles that have ended.
	for i, cy := range all {
		if cy.EndsOn >= today || cy.ClosedAt != 0 {
			continue
		}
		next := ""
		for _, n := range all[i+1:] {
			if n.EndsOn >= today {
				next = n.ID
				break
			}
		}
		open, err := c.tx.Tasks(c.ctx, store.TaskFilter{CycleIDs: []string{cy.ID}, Open: true, Limit: 5000})
		if err != nil {
			return err
		}
		for _, t := range open {
			tp := newPatch()
			tp.put("cycle_id", t.CycleID, next)
			if err := c.saveOther(t, tp, map[string]any{"rolled_over": true}); err != nil {
				return err
			}
		}
		cp := newPatch()
		cp.put("closed_at", int64(0), c.at)
		if err := c.save(cp, "cycles", "cycle", cy.ID, "project", p.ID, p.ID, map[string]any{"rolled": len(open)}); err != nil {
			return err
		}
	}
	return nil
}

func hasFuture(all []core.Cycle, today string) bool {
	for _, c := range all {
		if c.StartsOn > today {
			return true
		}
	}
	return false
}

func addDays(date string, n int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

// ---- saved views ----

type viewCreateArgs struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Project     string          `json:"project"`
	Description string          `json:"description"`
	Icon        string          `json:"icon"`
	Query       json.RawMessage `json:"query"`   // the same filter object a task query takes
	Layout      string          `json:"layout"`  // list, board, timeline
	Display     json.RawMessage `json:"display"` // grouping, sorting, shown fields
	Shared      *bool           `json:"shared"`  // default true: everyone sees it
	Rank        string          `json:"rank"`
}

var viewLayouts = []string{"list", "board", "timeline"}

func slugify(s string) string {
	s = strings.Trim(handleStrip.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-"), "-_")
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		s = "view"
	}
	return s
}

func viewCreate(c *cx) error {
	var a viewCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	vid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a view needs a name")
	}
	if a.Layout == "" {
		a.Layout = "list"
	}
	if !contains(viewLayouts, a.Layout) {
		return oneOf("layout", "layout", a.Layout, viewLayouts)
	}
	v := core.View{ID: vid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Description: a.Description, Icon: a.Icon,
		OwnerID: c.actor.UserID, Shared: a.Shared == nil || *a.Shared, Query: a.Query, Layout: a.Layout, Display: a.Display, CreatedAt: c.at}
	if len(a.Query) > 0 {
		if err := CheckViewQuery(a.Query); err != nil {
			return invalid("query", "%v", err)
		}
		if err := c.checkViewValues(a.Query); err != nil {
			return err
		}
	}
	scopeType, scopeID := "workspace", c.ws
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		v.ProjectID, scopeType, scopeID = p.ID, "project", p.ID
	}
	base := slugify(v.Name)
	v.Slug = base
	for i := 2; ; i++ {
		n, err := c.tx.Count(c.ctx, "views", store.Eq("slug", v.Slug), store.Live)
		if err != nil {
			return err
		}
		if n == 0 {
			break
		}
		v.Slug = base + "-" + itoa(i)
	}
	if v.Rank = a.Rank; v.Rank == "" {
		if v.Rank, err = nextRank[core.View](c, store.Live); err != nil {
			return err
		}
	}
	seq := c.tx.NextSeq()
	v.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, v); err != nil {
		return taken(err, "id", vid)
	}
	c.ref, c.key = v.ID, v.Slug
	audience := ""
	if !v.Shared {
		audience = v.OwnerID
	}
	return c.emitTo(audience, seq, "view.created", "view", v.ID, scopeType, scopeID, v.ProjectID, map[string]any{"row": v})
}

type viewUpdateArgs struct {
	ID          string               `json:"id"` // id or slug
	Name        Opt[string]          `json:"name"`
	Description Opt[string]          `json:"description"`
	Icon        Opt[string]          `json:"icon"`
	Query       Opt[json.RawMessage] `json:"query"`
	Layout      Opt[string]          `json:"layout"`
	Display     Opt[json.RawMessage] `json:"display"`
	Shared      Opt[bool]            `json:"shared"`
	Rank        Opt[string]          `json:"rank"`
}

func (c *cx) view(ref string) (core.View, string, string, error) {
	var v core.View
	cond := store.Eq("slug", ref)
	if isID(ref) {
		cond = store.Eq("id", ref)
	}
	if err := c.tx.Get(c.ctx, &v, cond, store.Live); err != nil {
		return v, "", "", missing(err, "view", ref)
	}
	if !v.Shared && v.OwnerID != c.actor.UserID {
		return v, "", "", notFound("view", ref)
	}
	if v.OwnerID != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return v, "", "", forbidden("only its owner, or an admin, can change a view")
	}
	if v.ProjectID != "" {
		return v, "project", v.ProjectID, nil
	}
	return v, "workspace", c.ws, nil
}

func viewUpdate(c *cx) error {
	var a viewUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	v, st, sid, err := c.view(a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &v.Name); err != nil {
		return err
	}
	p.str("description", a.Description, &v.Description)
	p.str("icon", a.Icon, &v.Icon)
	if a.Layout.Set {
		if !contains(viewLayouts, a.Layout.V) {
			return oneOf("layout", "layout", a.Layout.V, viewLayouts)
		}
		p.str("layout", a.Layout, &v.Layout)
	}
	raw := func(col string, o Opt[json.RawMessage], cur json.RawMessage) error {
		if !o.Set {
			return nil
		}
		if !o.Null && !json.Valid(o.V) {
			return invalid(col, "%s must be JSON", col)
		}
		if string(o.V) != string(cur) {
			p.set[col] = o.V
			p.changes[col] = core.FieldChange{From: cur, To: o.V}
		}
		return nil
	}
	if a.Query.Set && len(a.Query.V) > 0 {
		if err := CheckViewQuery(a.Query.V); err != nil {
			return invalid("query", "%v", err)
		}
		if err := c.checkViewValues(a.Query.V); err != nil {
			return err
		}
	}
	if err := raw("query", a.Query, v.Query); err != nil {
		return err
	}
	if err := raw("display", a.Display, v.Display); err != nil {
		return err
	}
	p.flag("shared", a.Shared, &v.Shared)
	if err := p.rank(a.Rank, &v.Rank); err != nil {
		return err
	}
	return c.save(p, "views", "view", v.ID, st, sid, v.ProjectID, nil)
}

func viewDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	v, st, sid, err := c.view(a.ID)
	if err != nil {
		return err
	}
	return c.trash("views", "view", v.ID, st, sid, v.ProjectID, nil)
}

// ---- task templates ----

// Preset is what a template fills in on a new task.
type Preset struct {
	Status   string   `json:"status,omitempty"`
	Priority int      `json:"priority,omitempty"`
	Labels   []string `json:"labels,omitempty"`
	Assignee string   `json:"assignee,omitempty"`
	Estimate int      `json:"estimate,omitempty"`
	// Decision, when set, is opened on the new task: a review template
	// starts with its question and options.
	Decision *decisionOpenArgs `json:"decision,omitempty"`
}

type templateCreateArgs struct {
	ID          string  `json:"id"`
	Project     string  `json:"project"`
	Name        string  `json:"name"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Preset      *Preset `json:"preset"`
}

func templateCreate(c *cx) error {
	var a templateCreateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	tid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name", "a template needs a name")
	}
	tp := core.Template{ID: tid, WorkspaceID: c.ws, Name: strings.TrimSpace(a.Name), Title: a.Title, Description: a.Description, CreatedAt: c.at}
	if a.Preset != nil {
		tp.Preset, _ = json.Marshal(a.Preset)
	}
	scopeType, scopeID := "workspace", c.ws
	if a.Project != "" {
		p, err := c.project(a.Project)
		if err != nil {
			return err
		}
		tp.ProjectID, scopeType, scopeID = p.ID, "project", p.ID
	}
	seq := c.tx.NextSeq()
	tp.UpdatedSeq = seq
	if err := c.tx.Insert(c.ctx, tp); err != nil {
		return taken(err, "id", tid)
	}
	return c.created(seq, "template", tp.ID, scopeType, scopeID, tp.ProjectID, tp)
}

type templateUpdateArgs struct {
	ID          string      `json:"id"`
	Name        Opt[string] `json:"name"`
	Title       Opt[string] `json:"title"`
	Description Opt[string] `json:"description"`
	Preset      Opt[Preset] `json:"preset"`
}

func tplScope(c *cx, t core.Template) (string, string) {
	if t.ProjectID != "" {
		return "project", t.ProjectID
	}
	return "workspace", c.ws
}

func templateUpdate(c *cx) error {
	var a templateUpdateArgs
	if err := c.args(&a); err != nil {
		return err
	}
	tp, err := get[core.Template](c, "template", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	if err := p.name("name", a.Name, &tp.Name); err != nil {
		return err
	}
	p.str("title", a.Title, &tp.Title)
	p.str("description", a.Description, &tp.Description)
	if a.Preset.Set {
		raw, _ := json.Marshal(a.Preset.V)
		if a.Preset.Null {
			raw = nil
		}
		if string(raw) != string(tp.Preset) {
			p.set["preset"] = json.RawMessage(raw)
			p.changes["preset"] = core.FieldChange{From: tp.Preset, To: json.RawMessage(raw)}
		}
	}
	st, sid := tplScope(c, tp)
	return c.save(p, "templates", "template", tp.ID, st, sid, tp.ProjectID, nil)
}

func templateDelete(c *cx) error {
	var a idArgs
	if err := c.args(&a); err != nil {
		return err
	}
	tp, err := get[core.Template](c, "template", "id", a.ID)
	if err != nil {
		return err
	}
	st, sid := tplScope(c, tp)
	return c.trash("templates", "template", tp.ID, st, sid, tp.ProjectID, nil)
}

// template finds a template usable in project p by id or name.
func (c *cx) template(p core.Project, ref string) (core.Template, error) {
	var all []core.Template
	if err := c.tx.List(c.ctx, &all, store.Q{Where: []store.Cond{store.Live}, Order: "name"}); err != nil {
		return core.Template{}, err
	}
	var names []string
	for _, t := range all {
		if t.ProjectID != "" && t.ProjectID != p.ID {
			continue
		}
		if t.ID == ref || strings.EqualFold(t.Name, ref) {
			return t, nil
		}
		names = append(names, t.Name)
	}
	return core.Template{}, &Error{Code: CodeInvalid, Field: "template", Message: "no template " + ref + " in project " + p.Key,
		Allowed: names, Nearest: nearest(ref, names)}
}

// applyTemplate fills what the caller left empty on a new task from a
// template, and returns the decision the template opens, if any.
func (c *cx) applyTemplate(p core.Project, a *taskCreateArgs) (*decisionOpenArgs, error) {
	tp, err := c.template(p, a.Template)
	if err != nil {
		return nil, err
	}
	if a.Title == "" {
		a.Title = tp.Title
	} else if tp.Title != "" && !strings.HasPrefix(a.Title, tp.Title) && strings.HasSuffix(tp.Title, " ") {
		a.Title = tp.Title + a.Title // a title ending in a space is a prefix
	}
	if a.Description == "" {
		a.Description = tp.Description
	}
	var ps Preset
	if len(tp.Preset) > 0 {
		if err := json.Unmarshal(tp.Preset, &ps); err != nil {
			return nil, err
		}
	}
	if a.Status == "" {
		a.Status = ps.Status
	}
	if a.Priority == 0 {
		a.Priority = ps.Priority
	}
	if len(a.Labels) == 0 {
		a.Labels = ps.Labels
	}
	if a.Assignee == "" {
		a.Assignee = ps.Assignee
	}
	if a.Estimate == 0 {
		a.Estimate = ps.Estimate
	}
	return ps.Decision, nil
}

// checkViewValues refuses a filter that names a status or a label the
// workspace does not have, or an ordering there is none of: such a view
// would save and then fail every time it is opened.
func (c *cx) checkViewValues(raw json.RawMessage) error {
	var q struct {
		Status   []string `json:"status"`
		Label    []string `json:"label"`
		Sort     string   `json:"sort"`
		Assignee []string `json:"assignee"`
		Epic     []string `json:"epic"`
		Priority []int    `json:"priority"`
		Category []string `json:"category"`
		Creator  string   `json:"creator"`
		Parent   string   `json:"parent"`
		Asked    string   `json:"asked"`
		Mentions string   `json:"mentions"`
	}
	if json.Unmarshal(raw, &q) != nil {
		return nil // CheckViewQuery has said so already
	}
	for _, p := range q.Priority {
		if p < 0 || p > 4 {
			return invalid("query.priority", "priority is 0 (none) to 4 (low): 1 urgent, 2 high, 3 medium, 4 low; %d is none of them", p)
		}
	}
	for _, cat := range q.Category {
		if !core.ValidCategory(strings.ToLower(cat)) {
			return oneOf("query.category", "category", cat, core.Categories)
		}
	}
	people := map[string][]string{"query.assignee": q.Assignee, "query.creator": {q.Creator}, "query.asked": {q.Asked}, "query.mentions": {q.Mentions}}
	for field, refs := range people {
		for _, ref := range refs {
			if ref == "" || ref == "me" || ref == "none" {
				continue
			}
			if _, err := c.memberRef(field, ref); err != nil {
				var e *Error
				if errors.As(err, &e) {
					e.Code = CodeInvalid // the view is what is wrong, not the address asked
				}
				return err
			}
		}
	}
	if q.Parent != "" {
		if _, err := c.anyTask("query.parent", q.Parent); err != nil {
			var e *Error
			if errors.As(err, &e) {
				e.Code = CodeInvalid
			}
			return err
		}
	}
	if len(q.Epic) > 0 {
		var all []core.Epic
		if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
			return err
		}
		for _, ref := range q.Epic {
			names, found := []string{}, ref == "none"
			for _, e := range all {
				found = found || e.ID == ref || strings.EqualFold(e.Name, ref)
				names = append(names, e.Name)
			}
			if !found {
				sort.Strings(names)
				return oneOf("query.epic", "epic", ref, append(names, "none"))
			}
		}
	}
	if _, ok := store.TaskSortKeys[q.Sort]; !ok {
		var sorts []string
		for k := range store.TaskSortKeys {
			if k != "" {
				sorts = append(sorts, k)
			}
		}
		sort.Strings(sorts)
		return oneOf("query.sort", "sort", q.Sort, sorts)
	}
	if len(q.Status) > 0 {
		var all []core.Status
		if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
			return err
		}
		for _, ref := range q.Status {
			names, found := []string{}, core.ValidCategory(strings.ToLower(ref))
			for _, s := range all {
				found = found || s.ID == ref || strings.EqualFold(s.Name, ref)
				if !contains(names, s.Name) {
					names = append(names, s.Name)
				}
			}
			if !found {
				sort.Strings(names)
				return oneOf("query.status", "status", ref, append(names, core.Categories...))
			}
		}
	}
	if len(q.Label) > 0 {
		var all []core.Label
		if err := c.tx.List(c.ctx, &all, store.Where(store.Live)); err != nil {
			return err
		}
		for _, ref := range q.Label {
			names, found := []string{}, false
			for _, l := range all {
				found = found || l.ID == ref || strings.EqualFold(l.Name, ref)
				if !contains(names, l.Name) {
					names = append(names, l.Name)
				}
			}
			if !found {
				sort.Strings(names)
				return oneOf("query.label", "label", ref, names)
			}
		}
	}
	return nil
}

// CheckViewQuery says whether a saved view's filter can be read. The server
// sets it: the filter's fields belong to its task queries.
var CheckViewQuery = func(q json.RawMessage) error {
	if !json.Valid(q) {
		return errors.New("query must be a JSON object")
	}
	return nil
}
