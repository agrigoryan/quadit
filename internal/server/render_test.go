package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// estimatedProjects makes two projects that estimate, TEE on T-shirt sizes
// and FIB on Fibonacci, both allowing zero, and their tasks: TEE-1 M,
// TEE-2 0, TEE-3 none, TEE-4 4 (off the scale, as an import keeps it),
// FIB-1 1 and FIB-2 3.
func estimatedProjects(t *testing.T, s *site) {
	t.Helper()
	s.change(t, s.owner, "", "project.create", M{"key": "TEE", "name": "Sized", "settings": M{"estimates": true, "estimate_scale": "tshirt", "estimate_zero": true}})
	s.change(t, s.owner, "", "project.create", M{"key": "FIB", "name": "Counted", "settings": M{"estimates": true, "estimate_zero": true}})
	for _, task := range []M{
		{"project": "TEE", "title": "Medium", "estimate": "M"},
		{"project": "TEE", "title": "Nothing to it", "estimate": 0},
		{"project": "TEE", "title": "Not estimated"},
		{"project": "TEE", "title": "Brought in", "estimate": 4, "keep_estimate": true},
		{"project": "FIB", "title": "One", "estimate": 1},
		{"project": "FIB", "title": "Three", "estimate": 3},
	} {
		s.change(t, s.owner, "", "task.create", task)
	}
}

// TestAnEstimateIsSaidInTheProjectsWords: the text for agents says a task's
// estimate with its size on a T-shirt project and in points elsewhere,
// says a zero estimate and leaves none out; the JSON carries the number, 0
// included, and no estimate where there is none.
func TestAnEstimateIsSaidInTheProjectsWords(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		estimatedProjects(t, s)
		for key, want := range map[string]string{
			"TEE-1": "estimate: M (3 points)",
			"TEE-2": "estimate: 0 points",
			"TEE-3": "",
			"TEE-4": "estimate: 4 points",
			"FIB-1": "estimate: 1 point",
			"FIB-2": "estimate: 3 points",
		} {
			text := s.call(t, s.owner, "", "GET", w+"/tasks/"+key+"?format=text", nil, 200, nil)
			if want == "" && strings.Contains(text, "estimate:") || want != "" && !strings.Contains(text, want+"   ") {
				t.Errorf("%s says, want %q:\n%s", key, want, text)
			}
		}

		var detail struct {
			Task map[string]any `json:"task"`
		}
		s.call(t, s.owner, "", "GET", w+"/tasks/TEE-2", nil, 200, &detail)
		if got, ok := detail.Task["estimate"]; !ok || got != 0.0 {
			t.Errorf("a zero estimate is sent as %v (%v)", got, ok)
		}
		detail.Task = nil
		s.call(t, s.owner, "", "GET", w+"/tasks/TEE-3", nil, 200, &detail)
		if got, ok := detail.Task["estimate"]; ok {
			t.Errorf("no estimate is sent as %v", got)
		}
		if raw := s.call(t, s.owner, "", "GET", w+"/tasks/TEE-2?raw=1", nil, 200, nil); !strings.Contains(raw, `"estimate":0`) {
			t.Errorf("the stored row leaves out a zero estimate: %s", raw)
		}
	})
}
