package server_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestContextPackListsLinkedPagesByTitle: the pages a task's context pack
// links come in the order of their titles, the same on every read.
func TestContextPackListsLinkedPagesByTitle(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		for _, title := range []string{"Delta", "Alpha", "Echo", "Charlie", "Bravo"} {
			s.change(t, s.owner, "", "doc.create", M{"title": title, "markdown": "About SVA-1.\n"})
		}
		for range 5 {
			text := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1/context?format=text", nil, 200, nil)
			_, linked, _ := strings.Cut(text, "=== linked docs\n")
			var titles []string
			for line := range strings.Lines(linked) {
				if title, _, ok := strings.Cut(line, "  (doc "); ok {
					titles = append(titles, title)
				}
			}
			if got := strings.Join(titles, ","); got != "Alpha,Bravo,Charlie,Delta,Echo" {
				t.Fatalf("the linked pages come as %s, want by title", got)
			}
		}
	})
}
