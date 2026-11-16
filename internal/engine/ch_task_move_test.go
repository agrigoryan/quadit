package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestTaskMovedBackGetsItsKeyBack: a task moved to a project it was in
// before takes the number it had there, so undoing a move leaves no third
// key; the key it leaves still finds it.
func TestTaskMovedBackGetsItsKeyBack(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		for _, key := range []string{"SVA", "OPS", "ART"} {
			w.do(w.owner.ID, "project.create", M{"key": key, "name": key})
		}
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "First"})
		moved := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Second"}).Ref
		w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Already there"})
		move := func(ref, project, want string) {
			t.Helper()
			if res := w.do(w.owner.ID, "task.move", M{"id": ref, "project": project}); res.Key != want {
				t.Fatalf("moved to %s as %s, want %s", project, res.Key, want)
			}
			if got := w.task(moved); got.Key != want {
				t.Fatalf("task is %s, want %s", got.Key, want)
			}
		}
		// finds checks that a key, live or old, reaches the task.
		finds := func(key string) {
			t.Helper()
			if res := w.do(w.owner.ID, "task.update", M{"id": key, "priority": 1}); res.Ref != moved {
				t.Fatalf("%s finds %s, not the moved task", key, res.Ref)
			}
		}

		t.Run("there and back again", func(t *testing.T) {
			move("SVA-2", "OPS", "OPS-2")
			move("OPS-2", "SVA", "SVA-2")
			if got := w.task(moved); got.Number != 2 {
				t.Fatalf("number = %d", got.Number)
			}
			finds("OPS-2")
			finds("SVA-2")
			// The project's count was not touched: the next task is SVA-3.
			if res := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Third"}); res.Key != "SVA-3" {
				t.Fatalf("next task in SVA = %s", res.Key)
			}
			// And again: each project gives back its own number.
			move("SVA-2", "OPS", "OPS-2")
			move("OPS-2", "SVA", "SVA-2")
		})

		t.Run("back by way of a third project", func(t *testing.T) {
			move("SVA-2", "OPS", "OPS-2")
			move("OPS-2", "ART", "ART-1")
			move("ART-1", "SVA", "SVA-2")
			finds("OPS-2")
			finds("ART-1")
			var keys []core.TaskKey
			if err := w.db().List(context.Background(), &keys, store.Where(store.Eq("task_id", moved))); err != nil {
				t.Fatal(err)
			}
			if len(keys) != 2 {
				t.Fatalf("old keys = %+v, want OPS-2 and ART-1", keys)
			}
		})

		t.Run("a project whose key changed gives a new number", func(t *testing.T) {
			move("SVA-2", "OPS", "OPS-2")
			w.do(w.owner.ID, "project.update", M{"id": "SVA", "key": "SAM"})
			move("OPS-2", "SAM", "SAM-4")
			finds("OPS-2")
		})

		t.Run("a number another task holds now is not taken from it", func(t *testing.T) {
			// SVA-2 is an old key of the task, but SVA is now another project
			// whose own second task is SVA-2.
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Again"})
			w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "One"})
			w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Two"})
			move("SAM-4", "SVA", "SVA-3")
		})
	})
}
