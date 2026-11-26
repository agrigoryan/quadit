package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTasksAreAskedForByEstimate: a task list and the feed are narrowed to
// tasks with one of some estimates, by number or T-shirt size, or with
// none; a word that is neither is refused.
func TestTasksAreAskedForByEstimate(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		estimatedProjects(t, s)
		keys := func(text string) string {
			var out []string
			for line := range strings.Lines(text) {
				if key, _, ok := strings.Cut(line, "  ["); ok {
					out = append(out, key)
				}
			}
			return strings.Join(out, ",")
		}
		for query, want := range map[string]string{
			"estimate=M":                "TEE-1,FIB-2", // M is 3 on every project
			"estimate=xs,5":             "FIB-1",
			"estimate=none":             "TEE-3",
			"estimate=0,4":              "TEE-2,TEE-4",
			"estimate=none&project=FIB": "",
		} {
			if got := keys(s.call(t, s.owner, "", "GET", w+"/tasks?format=text&sort=key&"+query, nil, 200, nil)); got != want {
				t.Errorf("%s finds %q, want %q", query, got, want)
			}
		}
		if out := s.call(t, s.owner, "", "GET", w+"/tasks?estimate=huge", nil, 400, nil); !strings.Contains(out, `unknown estimate \"huge\"`) {
			t.Errorf("a word that is no estimate: %s", out)
		}

		feed := s.call(t, s.owner, "", "GET", w+"/events?format=text&limit=500&estimate=none", nil, 200, nil)
		if !strings.Contains(feed, "TEE-3") || strings.Contains(feed, "TEE-1") {
			t.Errorf("the feed of tasks without an estimate:\n%s", feed)
		}
	})
}
