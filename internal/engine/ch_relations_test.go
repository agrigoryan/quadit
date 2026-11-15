package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestARelationAddedWithoutAnIDAnswersWithItsID(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss art"})
		ref := w.do(w.owner.ID, "relation.add", M{"task": "SVA-1", "type": "blocks", "other": "SVA-2"}).Ref
		var r core.Relation
		if err := w.db().Get(context.Background(), &r, store.Eq("id", ref)); err != nil {
			t.Fatalf("the answer %q is not the relation made: %v", ref, err)
		}
	})
}

// TestARelationAddedAgainAnswersWithTheOneThere: adding a relation that is
// there already changes nothing and answers with its id, whichever side
// adds it.
func TestARelationAddedAgainAnswersWithTheOneThere(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss art"})
		for _, c := range []struct{ first, again M }{
			{M{"task": "SVA-1", "type": "blocks", "other": "SVA-2"}, M{"task": "SVA-2", "type": "blocked_by", "other": "SVA-1"}},
			{M{"task": "SVA-1", "type": "relates", "other": "SVA-2"}, M{"task": "SVA-2", "type": "relates", "other": "SVA-1"}},
		} {
			made := w.do(w.owner.ID, "relation.add", c.first).Ref
			again := w.do(w.owner.ID, "relation.add", c.again)
			if again.Ref != made || len(again.Events) != 0 {
				t.Fatalf("%v added again answered %q with %d events, want %q and nothing written", c.again, again.Ref, len(again.Events), made)
			}
		}
	})
}
