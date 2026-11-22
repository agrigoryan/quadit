package engine_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// manyTasks is more tasks than a change ever read in one go before: a
// change that works through the tasks of a project, a status, a cycle or
// a label must reach the last of them as surely as the first.
const manyTasks = 5003

// addTasks puts n tasks in a project straight into the database, as
// making them one change at a time would take long; set fills in what the
// test needs of each.
func addTasks(t *testing.T, w *world, projectKey string, n int, set func(i int, task *core.Task)) {
	t.Helper()
	ctx := context.Background()
	var pr core.Project
	if err := w.db().Get(ctx, &pr, store.Eq("key", projectKey)); err != nil {
		t.Fatal(err)
	}
	var todo core.Status
	if err := w.db().Get(ctx, &todo, store.Eq("project_id", pr.ID), store.Eq("name", "Todo")); err != nil {
		t.Fatal(err)
	}
	err := w.st.Write(ctx, w.ws.ID, func(tx store.Tx) error {
		for i := range n {
			task := core.Task{ID: id.New(), ProjectID: pr.ID, Number: pr.TaskCounter + i + 1, Title: fmt.Sprintf("Task %d", i), StatusID: todo.ID,
				Rank: fmt.Sprintf("%08d", i), CreatedBy: w.owner.ID, CreatedAt: 1, UpdatedAt: 1}
			task.Key = fmt.Sprintf("%s-%d", pr.Key, task.Number)
			if set != nil {
				set(i, &task)
			}
			if err := tx.Insert(ctx, task); err != nil {
				return err
			}
			for _, l := range task.LabelIDs {
				if err := tx.Insert(ctx, core.TaskLabel{TaskID: task.ID, LabelID: l}); err != nil {
					return err
				}
			}
		}
		_, err := tx.Update(ctx, "projects", map[string]any{"task_counter": pr.TaskCounter + n}, store.Eq("id", pr.ID))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

// count counts a project's tasks, in the trash or not, that match conds.
func count(t *testing.T, w *world, conds ...store.Cond) int {
	t.Helper()
	n, err := w.db().Count(context.Background(), "tasks", conds...)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestAChangeToManyTasksReachesEveryOne: the changes that work through a
// set of tasks (renaming a project's key, taking a status, a label or a
// cycle away, emptying the trash) change every task of the set, however
// many there are.
func TestAChangeToManyTasksReachesEveryOne(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	// Each case has databases of its own and runs beside the others:
	// writing thousands of tasks takes a while.
	t.Run("a project's new key reaches every task, the trash included", func(t *testing.T) {
		t.Parallel()
		testdb.Each(t, func(t *testing.T, st store.Store) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			addTasks(t, w, "SVA", manyTasks+3, func(i int, task *core.Task) {
				if i >= manyTasks {
					task.DeletedAt = 1
				}
			})
			w.do(w.owner.ID, "project.update", M{"id": "SVA", "key": "SAM"})
			if left := count(t, w, store.Like("key", "SVA-%")); left != 0 {
				t.Fatalf("%d tasks kept the old key", left)
			}
			if got := w.task(fmt.Sprint("SAM-", manyTasks-1)); got.Number != manyTasks-1 {
				t.Fatalf("the last task is %+v", got)
			}
		})
	})

	t.Run("deleting a status moves every task off it, the trash included", func(t *testing.T) {
		t.Parallel()
		testdb.Each(t, func(t *testing.T, st store.Store) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			addTasks(t, w, "SVA", manyTasks+3, func(i int, task *core.Task) {
				if i >= manyTasks {
					task.DeletedAt = 1
				}
			})
			var todo core.Status
			if err := w.db().Get(ctx, &todo, store.Eq("name", "Todo")); err != nil {
				t.Fatal(err)
			}
			w.do(w.owner.ID, "status.delete", M{"id": todo.ID, "move_to": "Backlog"})
			if left := count(t, w, store.Eq("status_id", todo.ID)); left != 0 {
				t.Fatalf("%d tasks kept the deleted status", left)
			}
		})
	})

	t.Run("deleting a label takes it off every task", func(t *testing.T) {
		t.Parallel()
		testdb.Each(t, func(t *testing.T, st store.Store) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			label := w.do(w.owner.ID, "label.create", M{"name": "art", "project": "SVA"}).Ref
			addTasks(t, w, "SVA", manyTasks, func(_ int, task *core.Task) { task.LabelIDs = []string{label} })
			w.do(w.owner.ID, "label.delete", M{"id": label})
			if left, err := w.db().Count(ctx, "task_labels", store.Eq("label_id", label)); err != nil || left != 0 {
				t.Fatalf("%d tasks kept the deleted label (%v)", left, err)
			}
		})
	})

	t.Run("an ended cycle passes every unfinished task on", func(t *testing.T) {
		t.Parallel()
		testdb.Each(t, func(t *testing.T, st store.Store) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien", "settings": M{"cycles": true, "cycle_days": 7}})
			ended := w.do(w.owner.ID, "cycle.create", M{"project": "SVA", "starts_on": "2020-01-01", "ends_on": "2020-01-07"}).Ref
			addTasks(t, w, "SVA", manyTasks, func(_ int, task *core.Task) { task.CycleID = ended })
			if err := w.e.RollCycles(ctx); err != nil {
				t.Fatal(err)
			}
			if left := count(t, w, store.Eq("cycle_id", ended)); left != 0 {
				t.Fatalf("%d unfinished tasks stayed in the ended cycle", left)
			}
			var cy core.Cycle
			if err := w.db().Get(ctx, &cy, store.Eq("id", ended)); err != nil || cy.ClosedAt == 0 {
				t.Fatalf("the ended cycle is %+v (%v)", cy, err)
			}
		})
	})

	t.Run("emptying the trash empties it of every task", func(t *testing.T) {
		t.Parallel()
		testdb.Each(t, func(t *testing.T, st store.Store) {
			w := newWorld(t, st)
			w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
			addTasks(t, w, "SVA", manyTasks, func(_ int, task *core.Task) { task.DeletedAt = 1 })
			if _, _, err := w.e.PurgeTrash(ctx, -time.Hour); err != nil {
				t.Fatal(err)
			}
			if left := count(t, w); left != 0 {
				t.Fatalf("%d tasks are still in the trash", left)
			}
		})
	})
}
