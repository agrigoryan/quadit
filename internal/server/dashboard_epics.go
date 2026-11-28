// The dashboard's epics part: each epic's progress, and whether it is at risk.

package server

import (
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// epicProgress is one epic with how far along it is.
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
	// Points and PointsOK, its points and those done, are there (0
	// included) exactly when points are shown for it: when one of its tasks
	// is in a project that estimates.
	Points   *int `json:"points,omitempty"`
	PointsOK *int `json:"points_done,omitempty"`
	// AtRisk: the target date is close or past and work is left, or nothing
	// has moved in two weeks.
	AtRisk string `json:"at_risk,omitempty"`
	// AtRiskCode names the reason for programs: past_target, due_soon, stalled.
	AtRiskCode string `json:"at_risk_code,omitempty"`
}

// epicProgressOf is the epics a dashboard covers with their progress: the
// tasks and points done and started, leaving out canceled tasks and
// canceled epics. An epic has points (core's Points) when one of its tasks
// is in a project that estimates.
func epicProgressOf(scope dashboardScope) []epicProgress {
	names := scope.names
	byEpic := map[string]*epicProgress{}
	for _, epic := range names.epics {
		if epic.DeletedAt != 0 || !scope.covers.canProject(epic.ProjectID) || epic.State == core.EpicCanceled {
			continue
		}
		byEpic[epic.ID] = &epicProgress{ID: epic.ID, Name: epic.Name, Project: names.projects[epic.ProjectID].Key, State: epic.State, Lead: names.handle(epic.LeadID), TargetOn: epic.TargetOn}
	}
	lastMove := map[string]int64{}
	type tally struct {
		points, done int
		shown        bool
	}
	tallies := map[string]*tally{}
	for _, t := range scope.tasks {
		category := names.statuses[t.StatusID].Category
		progress, ok := byEpic[t.EpicID]
		if !ok || category == core.CatCanceled {
			continue
		}
		settings := names.projects[t.ProjectID].Settings
		points := tallies[t.EpicID]
		if points == nil {
			points = &tally{}
			tallies[t.EpicID] = points
		}
		points.shown = points.shown || settings.Estimating()
		points.points += settings.Points(t)
		progress.Total++
		switch category {
		case core.CatDone:
			progress.Done++
			points.done += settings.Points(t)
		case core.CatStarted:
			progress.Started++
		}
		if t.UpdatedAt > lastMove[t.EpicID] {
			lastMove[t.EpicID] = t.UpdatedAt
		}
	}
	var epics []epicProgress
	for epicID, progress := range byEpic {
		if points := tallies[epicID]; points != nil && points.shown {
			progress.Points, progress.PointsOK = &points.points, &points.done
		}
		markAtRisk(progress, lastMove[epicID], scope.now)
		epics = append(epics, *progress)
	}
	sort.Slice(epics, func(i, j int) bool { return epicBefore(epics[i], epics[j]) })
	return epics
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

// markAtRisk says on an epic why it is at risk, if it is, as of now.
// lastMove is when one of its tasks last changed.
func markAtRisk(progress *epicProgress, lastMove int64, now time.Time) {
	today := now.UTC().Format(time.DateOnly)
	soon := now.UTC().AddDate(0, 0, 7).Format(time.DateOnly)
	left := progress.Total - progress.Done
	switch {
	case progress.State == core.EpicDone || left == 0:
	case progress.TargetOn != "" && progress.TargetOn < today:
		progress.AtRisk, progress.AtRiskCode = "past its target date", "past_target"
	case progress.TargetOn != "" && progress.TargetOn <= soon && progress.Done*2 < progress.Total:
		progress.AtRisk, progress.AtRiskCode = "due within a week and less than half done", "due_soon"
	case progress.State == core.EpicActive && lastMove != 0 && now.UnixMilli()-lastMove > (14*24*time.Hour).Milliseconds():
		progress.AtRisk, progress.AtRiskCode = "nothing has moved in two weeks", "stalled"
	}
}
