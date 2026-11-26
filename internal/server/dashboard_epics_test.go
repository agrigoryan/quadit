package server_test

import (
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAnEpicHasPointsWhenItsProjectEstimates: an epic's points follow the
// points rule (a task without an estimate is 1); an epic of a project that
// does not estimate has none, only its counts of tasks.
func TestAnEpicHasPointsWhenItsProjectEstimates(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		for _, key := range []string{"EST", "OFF"} {
			settings := M{"estimates": key == "EST"}
			s.change(t, s.owner, "", "project.create", M{"key": key, "name": key, "settings": settings})
			s.change(t, s.owner, "", "epic.create", M{"project": key, "name": "Epic " + key})
			s.change(t, s.owner, "", "task.create", M{"project": key, "title": "Sized", "epic": "Epic " + key, "estimate": 5})
			s.change(t, s.owner, "", "task.create", M{"project": key, "title": "Not sized", "epic": "Epic " + key, "status": "done"})
		}
		var dash struct {
			Epics []map[string]any `json:"epics"`
		}
		s.call(t, s.owner, "", "GET", w+"/dashboard", nil, 200, &dash)
		got := map[string][2]any{}
		for _, epic := range dash.Epics {
			got[epic["name"].(string)] = [2]any{epic["points"], epic["points_done"]}
		}
		if want := [2]any{6.0, 1.0}; got["Epic EST"] != want {
			t.Errorf("the epic of a project that estimates has points %v, want %v", got["Epic EST"], want)
		}
		if want := [2]any{nil, nil}; got["Epic OFF"] != want {
			t.Errorf("the epic of a project that does not estimate has points %v", got["Epic OFF"])
		}
	})
}
