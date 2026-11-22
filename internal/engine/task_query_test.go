package engine_test

import (
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestViewQueryIsReadByTheEngine checks that the engine itself reads a
// saved view's query the way a task list will, with nothing set from
// outside: a field there is none of, a value of the wrong type and a name
// that is not in the view's project are each refused, and say what would
// have been accepted.
func TestViewQueryIsReadByTheEngine(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		w.do(w.owner.ID, "label.create", M{"name": "art", "project": "SVA"})
		for _, tc := range []struct {
			name    string
			project string
			query   M
			field   string
			says    string
		}{
			{"a field there is none of", "", M{"labels": []string{"art"}}, "query", "there is no field"},
			{"text where a list goes", "", M{"label": "art"}, "query", "label takes a list"},
			{"a label of another project", "OPS", M{"label": []string{"art"}}, "query.label", `no label "art"`},
			{"a label nearly right", "SVA", M{"label": []string{"arts"}}, "query.label", `no label "arts"`},
			{"a sort there is none of", "", M{"sort": "nope"}, "query.sort", "unknown sort"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				w.t = t
				e := w.refused(engine.CodeInvalid, w.owner.ID, "view.create", M{"name": "V", "project": tc.project, "query": tc.query})
				if e.Field != tc.field || !strings.Contains(e.Message, tc.says) {
					t.Fatalf("refusal = %+v, want field %s saying %q", e, tc.field, tc.says)
				}
			})
		}
		w.t = t
		if e := w.refused(engine.CodeInvalid, w.owner.ID, "view.create", M{"name": "V", "project": "SVA", "query": M{"label": []string{"arts"}}}); e.Nearest != "art" {
			t.Fatalf("the refusal does not name the nearest label: %+v", e)
		}
		w.do(w.owner.ID, "view.create", M{"name": "Art", "project": "SVA", "query": M{"label": []string{"art"}, "open": true}})
	})
}

func TestNearestIgnoresCaseAndGivesUpWhenFarOff(t *testing.T) {
	t.Parallel()
	allowed := []string{"assignee", "status", "label"}
	for got, want := range map[string]string{
		"asignee":  "assignee", // one letter short
		"Assignee": "assignee", // right but for its case
		"assignee": "",         // right as it is: nothing to suggest
		"zzzzzz":   "",         // nothing like it
	} {
		if n := engine.Nearest(got, allowed); n != want {
			t.Errorf("Nearest(%q) = %q, want %q", got, n, want)
		}
	}
}
