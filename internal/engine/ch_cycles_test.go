package engine_test

import (
	"context"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestCycleRestore(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		cycle := w.do(w.owner.ID, "cycle.create", M{"project": "SVA", "starts_on": "2030-06-01", "ends_on": "2030-06-07"}).Ref
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion", "cycle": cycle})
		w.do(w.owner.ID, "cycle.delete", M{"id": cycle})

		t.Run("an unknown cycle is not found", func(t *testing.T) {
			w.refused(engine.CodeNotFound, w.owner.ID, "cycle.restore", M{"id": id.New()})
		})

		t.Run("a cycle in another project than one's own stays in the trash", func(t *testing.T) {
			narrow := w.do(w.owner.ID, "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"OPS"}}}).Ref
			w.refused(engine.CodeForbidden, narrow, "cycle.restore", M{"id": cycle})
		})

		t.Run("a cycle whose dates another took meanwhile stays in the trash", func(t *testing.T) {
			other := w.do(w.owner.ID, "cycle.create", M{"project": "SVA", "starts_on": "2030-06-05", "ends_on": "2030-06-10"}).Ref
			e := w.refused(engine.CodeConflict, w.owner.ID, "cycle.restore", M{"id": cycle})
			if !strings.Contains(e.Message, "overlap") {
				t.Fatalf("refusal = %v", e)
			}
			w.do(w.owner.ID, "cycle.delete", M{"id": other})
		})

		t.Run("it comes back whole, and its tasks with the changes sent after it", func(t *testing.T) {
			results := w.batch(w.owner.ID,
				change("cycle.restore", M{"id": cycle}),
				change("task.update", M{"id": "SVA-1", "cycle": cycle}))
			if results[0].Ref != cycle {
				t.Fatalf("answer = %+v", results[0])
			}
			var row core.Cycle
			ev := restoredRow(t, results, "cycle.restored", &row)
			var cy core.Cycle
			if err := w.db().Get(ctx, &cy, store.Eq("id", cycle)); err != nil {
				t.Fatal(err)
			}
			if cy.DeletedAt != 0 || row.ID != cycle || row.StartsOn != "2030-06-01" || row.DeletedAt != 0 || row.UpdatedSeq != ev.Seq || cy.UpdatedSeq != ev.Seq {
				t.Fatalf("cycle = %+v, event row = %+v at %d", cy, row, ev.Seq)
			}
			if ev.ScopeType != "project" || ev.ProjectID != cy.ProjectID {
				t.Fatalf("event placed in %s %s", ev.ScopeType, ev.ProjectID)
			}
			if got := w.task("SVA-1"); got.CycleID != cycle {
				t.Fatalf("task = %+v", got)
			}
		})

		t.Run("a cycle that is not in the trash is left as it is", func(t *testing.T) {
			res := w.do(w.owner.ID, "cycle.restore", M{"id": cycle})
			if res.Ref != cycle || len(res.Events) != 0 {
				t.Fatalf("answer = %+v", res)
			}
		})
	})
}
