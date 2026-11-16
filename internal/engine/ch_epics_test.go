package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// restoredRow finds the "<entity>.restored" event among a batch's results
// and reads the row it carries into dst, failing the test when there is
// none.
func restoredRow(t *testing.T, results []*engine.Result, typ string, dst any) core.Event {
	t.Helper()
	for _, res := range results {
		for _, ev := range res.Events {
			if ev.Type != typ {
				continue
			}
			d, err := ev.Payload()
			if err != nil || !d.ReadRow(dst) {
				t.Fatalf("%s carries no row: %s", typ, ev.Data)
			}
			return ev
		}
	}
	t.Fatalf("no %s event in %+v", typ, results)
	return core.Event{}
}

func TestEpicRestore(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		epic := w.do(w.owner.ID, "epic.create", M{"project": "SVA", "name": "Combat", "description": "swords and lasers"}).Ref
		milestone := w.do(w.owner.ID, "milestone.create", M{"epic": epic, "name": "Alpha"}).Ref
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion", "epic": epic, "milestone": milestone})
		w.do(w.owner.ID, "epic.delete", M{"id": epic})
		if w.searchFinds(w.owner.ID, "lasers", epic) {
			t.Fatal("search finds the epic in the trash")
		}

		t.Run("an epic in another project than one's own stays in the trash", func(t *testing.T) {
			narrow := w.do(w.owner.ID, "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"OPS"}}}).Ref
			w.refused(engine.CodeForbidden, narrow, "epic.restore", M{"id": epic})
		})

		t.Run("an unknown epic is not found", func(t *testing.T) {
			w.refused(engine.CodeNotFound, w.owner.ID, "epic.restore", M{"id": id.New()})
		})

		t.Run("it comes back whole, and its tasks with the changes sent after it", func(t *testing.T) {
			results := w.batch(w.owner.ID,
				change("epic.restore", M{"id": epic}),
				change("task.update", M{"id": "SVA-1", "epic": epic, "milestone": milestone}))
			if results[0].Ref != epic {
				t.Fatalf("answer = %+v", results[0])
			}
			var row core.Epic
			ev := restoredRow(t, results, "epic.restored", &row)
			var e core.Epic
			if err := w.db().Get(ctx, &e, store.Eq("id", epic)); err != nil {
				t.Fatal(err)
			}
			if e.DeletedAt != 0 || row.ID != epic || row.Name != "Combat" || row.DeletedAt != 0 || row.UpdatedSeq != e.UpdatedSeq || e.UpdatedSeq != ev.Seq {
				t.Fatalf("epic = %+v, event row = %+v at %d", e, row, ev.Seq)
			}
			if ev.ScopeType != "project" || ev.ProjectID != e.ProjectID {
				t.Fatalf("event placed in %s %s", ev.ScopeType, ev.ProjectID)
			}
			if got := w.task("SVA-1"); got.EpicID != epic || got.MilestoneID != milestone {
				t.Fatalf("task = %+v", got)
			}
			if !w.searchFinds(w.owner.ID, "lasers", epic) {
				t.Fatal("search does not find the restored epic")
			}
		})

		t.Run("an epic that is not in the trash is left as it is", func(t *testing.T) {
			res := w.do(w.owner.ID, "epic.restore", M{"id": epic})
			if res.Ref != epic || len(res.Events) != 0 {
				t.Fatalf("answer = %+v", res)
			}
		})
	})
}
