package server_test

import (
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAnEpicHasPointsWhenItsProjectEstimates: an epic's points follow the
// points rule (a task without an estimate is 1), and are there, 0 included,
// exactly when one of its tasks is in a project that estimates; otherwise
// it has only its counts of tasks.
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
		s.change(t, s.owner, "", "project.create", M{"key": "ZERO", "name": "Zero", "settings": M{"estimates": true, "estimate_zero": true}})
		s.change(t, s.owner, "", "epic.create", M{"project": "ZERO", "name": "Epic of nothing"})
		s.change(t, s.owner, "", "task.create", M{"project": "ZERO", "title": "Nothing to it", "epic": "Epic of nothing", "estimate": 0})
		s.change(t, s.owner, "", "epic.create", M{"project": "ZERO", "name": "Empty epic"})
		var dash struct {
			Epics []map[string]any `json:"epics"`
		}
		s.call(t, s.owner, "", "GET", w+"/dashboard", nil, 200, &dash)
		got := map[string][2]any{}
		for _, epic := range dash.Epics {
			points, shown := epic["points"]
			done, shownDone := epic["points_done"]
			if shown != shownDone {
				t.Errorf("%s has points %v and points done %v", epic["name"], points, done)
			}
			got[epic["name"].(string)] = [2]any{points, done}
		}
		if want := [2]any{6.0, 1.0}; got["Epic EST"] != want {
			t.Errorf("the epic of a project that estimates has points %v, want %v", got["Epic EST"], want)
		}
		if want := [2]any{0.0, 0.0}; got["Epic of nothing"] != want {
			t.Errorf("an epic of zero points has points %v, want %v", got["Epic of nothing"], want)
		}
		for _, name := range []string{"Epic OFF", "Empty epic"} {
			if want := [2]any{nil, nil}; got[name] != want {
				t.Errorf("%s has points %v, want none", name, got[name])
			}
		}
	})
}
