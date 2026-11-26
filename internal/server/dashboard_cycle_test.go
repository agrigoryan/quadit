package server_test

import (
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestACyclesPointsFollowThePointsRule: a cycle's chart counts each task's
// estimate, 0 included, and a task without one as 1, or as 0 where the
// project says so; in a project that does not estimate, every task is 1.
func TestACyclesPointsFollowThePointsRule(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		for _, c := range []struct {
			key      string
			settings M
			want     int
		}{
			{"EST", M{"cycles": true, "estimates": true, "estimate_zero": true}, 5 + 0 + 1},
			{"IGN", M{"cycles": true, "estimates": true, "estimate_zero": true, "estimate_ignore_unestimated": true}, 5 + 0 + 0},
			{"OFF", M{"cycles": true}, 1 + 1 + 1},
		} {
			project := s.change(t, s.owner, "", "project.create", M{"key": c.key, "name": c.key, "settings": c.settings})
			for _, estimate := range []any{5, 0, nil} {
				s.change(t, s.owner, "", "task.create", M{"project": c.key, "title": "Work", "cycle": "current", "estimate": estimate})
			}
			var list struct {
				Cycles []struct {
					ID        string `json:"id"`
					ProjectID string `json:"project_id"`
					Number    int    `json:"number"`
				} `json:"cycles"`
			}
			s.call(t, s.owner, "", "GET", w+"/list/cycles", nil, 200, &list)
			var chart struct {
				Days []struct{ Scope, Points int }
			}
			for _, cycle := range list.Cycles {
				if cycle.ProjectID == project["ref"] && cycle.Number == 1 { // the current one
					s.call(t, s.owner, "", "GET", w+"/cycles/"+cycle.ID+"/chart", nil, 200, &chart)
					break
				}
			}
			points := -1
			for _, day := range chart.Days {
				if day.Scope >= 0 {
					points = day.Points
				}
			}
			if points != c.want {
				t.Errorf("%s: %d points today, want %d", c.key, points, c.want)
			}
		}
	})
}
