package server

import (
	"sort"

	"github.com/agrigoryan/quadit/internal/core"
)

type epicProgress struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Project  string `json:"project"`
	State    string `json:"state"`
	Lead     string `json:"lead,omitempty"`
	TargetOn string `json:"target_on,omitempty"`
	Total    int    `json:"total"`
	Done     int    `json:"done"`
	Started  int    `json:"started"`
	Points   int    `json:"points,omitempty"`
	PointsOK int    `json:"points_done,omitempty"`
	// AtRisk: the target date is close or past and work is left, or nothing
	// has moved in two weeks.
	AtRisk string `json:"at_risk,omitempty"`
	// AtRiskCode names the reason for programs: past_target, due_soon, stalled.
	AtRiskCode string `json:"at_risk_code,omitempty"`
}

// epicProgress fills in the epics with their progress.
func (d *dashboard) epicProgress() error {
	nm := d.nm
	byEpic := map[string]*epicProgress{}
	for _, e := range nm.epics {
		if e.DeletedAt != 0 || (len(d.projects) > 0 && !has(d.projects, e.ProjectID)) || e.State == core.EpicCanceled {
			continue
		}
		byEpic[e.ID] = &epicProgress{ID: e.ID, Name: e.Name, Project: nm.projects[e.ProjectID].Key, State: e.State, Lead: nm.handle(e.LeadID), TargetOn: e.TargetOn}
	}
	lastMove := map[string]int64{}
	for _, t := range d.tasks {
		cat := nm.statuses[t.StatusID].Category
		ep, ok := byEpic[t.EpicID]
		if !ok || cat == core.CatCanceled {
			continue
		}
		ep.Total++
		ep.Points += t.Estimate
		switch cat {
		case core.CatDone:
			ep.Done++
			ep.PointsOK += t.Estimate
		case core.CatStarted, core.CatWaiting:
			ep.Started++
		}
		if t.UpdatedAt > lastMove[t.EpicID] {
			lastMove[t.EpicID] = t.UpdatedAt
		}
	}
	var epics []epicProgress
	for id, ep := range byEpic {
		d.markAtRisk(ep, lastMove[id])
		epics = append(epics, *ep)
	}
	sort.Slice(epics, func(i, j int) bool { return epicBefore(epics[i], epics[j]) })
	d.epics = epics
	return nil
}

// epicBefore orders epics: those with a target date first, the nearest
// first, then by name, and by id where even the names are the same, so the
// same dashboard lists them in the same order every time.
func epicBefore(a, b epicProgress) bool {
	if (a.TargetOn == "") != (b.TargetOn == "") {
		return a.TargetOn != ""
	}
	if a.TargetOn != b.TargetOn {
		return a.TargetOn < b.TargetOn
	}
	if a.Name != b.Name {
		return a.Name < b.Name
	}
	return a.ID < b.ID
}

// markAtRisk says on an epic why it is at risk, if it is. lastMove is when
// one of its tasks last changed.
func (d *dashboard) markAtRisk(ep *epicProgress, lastMove int64) {
	today := d.now.UTC().Format("2006-01-02")
	soon := d.now.AddDate(0, 0, 7).UTC().Format("2006-01-02")
	left := ep.Total - ep.Done
	switch {
	case ep.State == core.EpicDone || left == 0:
	case ep.TargetOn != "" && ep.TargetOn < today:
		ep.AtRisk, ep.AtRiskCode = "past its target date", "past_target"
	case ep.TargetOn != "" && ep.TargetOn <= soon && ep.Done*2 < ep.Total:
		ep.AtRisk, ep.AtRiskCode = "due within a week and less than half done", "due_soon"
	case ep.State == core.EpicActive && lastMove != 0 && d.now.UnixMilli()-lastMove > 14*24*3600_000:
		ep.AtRisk, ep.AtRiskCode = "nothing has moved in two weeks", "stalled"
	}
}
