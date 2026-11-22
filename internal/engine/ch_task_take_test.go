package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestTheTakerOfATaskWatchesIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		a := w.agent("alpha")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Build"})
		w.do(a, "task.take", M{"id": "SVA-1"})
		var watching []core.Watcher
		if err := w.db().List(context.Background(), &watching, store.Where(store.Eq("subject_id", w.task("SVA-1").ID), store.Eq("user_id", a))); err != nil {
			t.Fatal(err)
		}
		if len(watching) != 1 {
			t.Fatal("the agent took the task but does not watch it")
		}
	})
}
