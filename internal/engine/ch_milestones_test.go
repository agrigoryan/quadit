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

func TestMilestoneRestore(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		epic := w.do(w.owner.ID, "epic.create", M{"project": "SVA", "name": "Combat"}).Ref
		milestone := w.do(w.owner.ID, "milestone.create", M{"epic": epic, "name": "Alpha"}).Ref
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion", "epic": epic, "milestone": milestone})
		w.do(w.owner.ID, "milestone.delete", M{"id": milestone})

		t.Run("an unknown milestone is not found", func(t *testing.T) {
			w.refused(engine.CodeNotFound, w.owner.ID, "milestone.restore", M{"id": id.New()})
		})

		t.Run("a milestone in another project than one's own stays in the trash", func(t *testing.T) {
			narrow := w.do(w.owner.ID, "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"OPS"}}}).Ref
			w.refused(engine.CodeForbidden, narrow, "milestone.restore", M{"id": milestone})
		})

		t.Run("a milestone of an epic in the trash waits for the epic", func(t *testing.T) {
			w.do(w.owner.ID, "epic.delete", M{"id": epic})
			e := w.refused(engine.CodeConflict, w.owner.ID, "milestone.restore", M{"id": milestone})
			if !strings.Contains(e.Message, "restore the epic first") {
				t.Fatalf("refusal = %v", e)
			}
			w.do(w.owner.ID, "epic.restore", M{"id": epic})
		})

		t.Run("it comes back whole, and its tasks with the changes sent after it", func(t *testing.T) {
			results := w.batch(w.owner.ID,
				change("milestone.restore", M{"id": milestone}),
				change("task.update", M{"id": "SVA-1", "epic": epic, "milestone": milestone}))
			if results[0].Ref != milestone {
				t.Fatalf("answer = %+v", results[0])
			}
			var row core.Milestone
			ev := restoredRow(t, results, "milestone.restored", &row)
			var m core.Milestone
			if err := w.db().Get(ctx, &m, store.Eq("id", milestone)); err != nil {
				t.Fatal(err)
			}
			if m.DeletedAt != 0 || row.ID != milestone || row.Name != "Alpha" || row.DeletedAt != 0 || row.UpdatedSeq != ev.Seq || m.UpdatedSeq != ev.Seq {
				t.Fatalf("milestone = %+v, event row = %+v at %d", m, row, ev.Seq)
			}
			if ev.ScopeType != "project" || ev.ProjectID == "" {
				t.Fatalf("event placed in %s %s", ev.ScopeType, ev.ProjectID)
			}
			if got := w.task("SVA-1"); got.MilestoneID != milestone {
				t.Fatalf("task = %+v", got)
			}
		})

		t.Run("a milestone that is not in the trash is left as it is", func(t *testing.T) {
			res := w.do(w.owner.ID, "milestone.restore", M{"id": milestone})
			if res.Ref != milestone || len(res.Events) != 0 {
				t.Fatalf("answer = %+v", res)
			}
		})
	})
}
