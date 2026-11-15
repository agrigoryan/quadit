package engine

import (
	"context"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("cycle.create", core.RoleMember, cycleCreate)
	register("cycle.update", core.RoleMember, cycleUpdate)
	register("cycle.delete", core.RoleMember, cycleDelete)
}

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

func cycleCreate(c *cx, a cycleCreateArgs) error {
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
		return alreadyInUse(err, "id", cid)
	}
	return c.created(seq, "cycle", cy.ID, inProject(p.ID), cy)
}

type cycleUpdateArgs struct {
	ID       string      `json:"id"`
	Name     Opt[string] `json:"name"`
	StartsOn Opt[string] `json:"starts_on"`
	EndsOn   Opt[string] `json:"ends_on"`
}

func cycleUpdate(c *cx, a cycleUpdateArgs) error {
	cy, err := loadLive[core.Cycle](c, "cycle", "id", a.ID)
	if err != nil {
		return err
	}
	p := newPatch()
	p.setText("name", a.Name, &cy.Name)
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
	return c.save(p, target{table: "cycles", entity: "cycle", id: cy.ID, place: inProject(cy.ProjectID)})
}

func cycleDelete(c *cx, a idArgs) error {
	cy, err := loadLive[core.Cycle](c, "cycle", "id", a.ID)
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
	return c.trash(target{table: "cycles", entity: "cycle", id: cy.ID, place: inProject(cy.ProjectID)})
}

// startCycles makes a project's first cycles as soon as cycles are on, so
// there is a current one to put work in straight away.
func (c *cx) startCycles(p core.Project) error {
	if p.Settings == nil || !p.Settings.Cycles {
		return nil
	}
	if p.Settings.CycleDays <= 0 {
		p.Settings.CycleDays = 14
	}
	ref, key := c.ref, c.key
	err := c.rollProject(p, time.UnixMilli(c.at).UTC().Format("2006-01-02"))
	c.ref, c.key = ref, key
	return err
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
		var start string
		if last != "" {
			start = addDays(last, 1)
		} else {
			// The first cycle starts on the project's cycle weekday.
			t, err := time.Parse("2006-01-02", today)
			if err != nil {
				return err
			}
			back := (int(t.Weekday()) - p.Settings.CycleStart + 7) % 7
			start = addDays(today, -back)
		}
		end := addDays(start, days-1)
		if err := c.applyNested("cycle.create", cycleCreateArgs{ID: id.New(), Project: p.ID, StartsOn: start, EndsOn: end}); err != nil {
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
		if err := c.save(cp, target{table: "cycles", entity: "cycle", id: cy.ID, place: inProject(p.ID), extra: map[string]any{"rolled": len(open)}}); err != nil {
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
