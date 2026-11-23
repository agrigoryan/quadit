package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestThePersonWhoTakesATaskWatchesIt: taking a task makes a person follow
// it, as being assigned it does; an agent that takes one follows it only if
// it chooses to (watch.set).
func TestThePersonWhoTakesATaskWatchesIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		mia, a := w.person("mia"), w.agent("alpha")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Build"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Test"})
		w.do(mia, "task.take", M{"id": "SVA-1"})
		w.do(a, "task.take", M{"id": "SVA-2"})
		watches := func(userID, key string) bool {
			t.Helper()
			var watching []core.Watcher
			if err := w.db().List(context.Background(), &watching, store.Where(store.Eq("subject_id", w.task(key).ID), store.Eq("user_id", userID))); err != nil {
				t.Fatal(err)
			}
			return len(watching) == 1
		}
		if !watches(mia, "SVA-1") {
			t.Error("the person took the task but does not watch it")
		}
		if watches(a, "SVA-2") {
			t.Error("the agent took the task and was made to watch it")
		}
	})
}
