package server

import (
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// hCycleChart returns a cycle's scope against done, day by day, in tasks
// and in points.
func (s *Server) hCycleChart(x *c) error {
	var cy core.Cycle
	if err := x.db.Get(x.ctx(), &cy, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil || !x.canProject(cy.ProjectID) {
		return errNotFound("cycle")
	}
	nm, err := x.names()
	if err != nil {
		return err
	}
	tasks, err := x.db.Tasks(x.ctx(), store.TaskFilter{CycleIDs: []string{cy.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	type day struct {
		Date       string `json:"date"`
		Scope      int    `json:"scope"`
		Done       int    `json:"done"`
		Points     int    `json:"points"`
		PointsDone int    `json:"points_done"`
	}
	start, _ := time.Parse("2006-01-02", cy.StartsOn)
	end, _ := time.Parse("2006-01-02", cy.EndsOn)
	today := time.Now().UTC()
	var days []day
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		eod := d.AddDate(0, 0, 1).UnixMilli()
		row := day{Date: d.Format("2006-01-02")}
		if d.After(today) {
			days = append(days, day{Date: row.Date, Scope: -1}) // the future: nothing to plot yet
			continue
		}
		for _, t := range tasks {
			if t.CreatedAt >= eod || nm.statuses[t.StatusID].Category == core.CatCanceled && t.CanceledAt < eod {
				continue
			}
			row.Scope++
			row.Points += t.Estimate
			if t.CompletedAt != 0 && t.CompletedAt < eod {
				row.Done++
				row.PointsDone += t.Estimate
			}
		}
		days = append(days, row)
	}
	total, done := 0, 0
	for _, t := range tasks {
		if nm.statuses[t.StatusID].Category == core.CatCanceled {
			continue
		}
		total++
		if nm.statuses[t.StatusID].Category == core.CatDone {
			done++
		}
	}
	return x.ok(map[string]any{"cycle": cy, "days": days, "total": total, "done": done})
}
