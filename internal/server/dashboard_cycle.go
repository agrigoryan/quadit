// A cycle's chart (/cycles/ID/chart): scope against done, day by day.

package server

import (
	"errors"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowCycleChart returns a cycle's scope against done, day by day, in tasks
// and in points.
func (s *Server) handleShowCycleChart(x *c) error {
	var cycle core.Cycle
	err := x.db.Get(x.ctx(), &cycle, store.Eq("id", x.r.PathValue("id")), store.Live)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err != nil || !x.canProject(cycle.ProjectID) {
		return errNotFound("cycle")
	}
	names, err := x.names()
	if err != nil {
		return err
	}
	tasks, err := x.db.Tasks(x.ctx(), store.TaskFilter{CycleIDs: []string{cycle.ID}, Archived: true, Limit: maxTasksByID})
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
	start, err := time.Parse(time.DateOnly, cycle.StartsOn)
	if err != nil {
		return err
	}
	end, err := time.Parse(time.DateOnly, cycle.EndsOn)
	if err != nil {
		return err
	}
	today := time.Now().UTC()
	var days []day
	for date := start; !date.After(end); date = date.AddDate(0, 0, 1) {
		eod := date.AddDate(0, 0, 1).UnixMilli()
		row := day{Date: date.Format(time.DateOnly)}
		if date.After(today) {
			days = append(days, day{Date: row.Date, Scope: -1}) // the future: nothing to plot yet
			continue
		}
		for _, t := range tasks {
			if t.CreatedAt >= eod || names.statuses[t.StatusID].Category == core.CatCanceled && t.CanceledAt < eod {
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
		if names.statuses[t.StatusID].Category == core.CatCanceled {
			continue
		}
		total++
		if names.statuses[t.StatusID].Category == core.CatDone {
			done++
		}
	}
	return x.ok(map[string]any{"cycle": cycle, "days": days, "total": total, "done": done})
}
