package sqlstore

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// TestGetNamesWhatIsMissing: a row that is not there is ErrNotFound, and
// says what was looked for in a person's words.
func TestGetNamesWhatIsMissing(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ws := fillTasks(t, s, 1)
		err := s.In(ws).Get(context.Background(), &core.Task{}, store.Eq("id", id.New()))
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("a missing task is %v, want ErrNotFound", err)
		}
		if err.Error() != "task not found" {
			t.Fatalf("a missing task says %q", err)
		}
		var nf *store.NotFoundError
		if !errors.As(err, &nf) || nf.What != "task" {
			t.Fatalf("a missing task is %#v, want a NotFoundError naming the task", err)
		}
		err = s.Get(context.Background(), &core.Invite{}, store.Eq("id", id.New()))
		if err == nil || err.Error() != "invitation not found" {
			t.Fatalf("a missing invite says %v", err)
		}
	})
}

// TestFindTellsAMissingRowFromAFailure: Find answers whether the row is
// there, and errs only when it cannot tell.
func TestFindTellsAMissingRowFromAFailure(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		ws := fillTasks(t, s, 1)
		other := id.New()
		if err := s.Insert(ctx, core.Workspace{ID: other, Slug: "other", Name: "Other", CreatedAt: 1, UpdatedAt: 1}); err != nil {
			t.Fatal(err)
		}
		var some core.Task
		if err := s.In(ws).Get(ctx, &some); err != nil {
			t.Fatal(err)
		}

		t.Run("there", func(t *testing.T) {
			var got core.Task
			there, err := store.Find(ctx, s.In(ws), &got, store.Eq("id", some.ID))
			if err != nil || !there || got.ID != some.ID || got.Key != some.Key {
				t.Fatalf("Find of a task there: %v %v %+v", there, err, got)
			}
		})
		t.Run("not there", func(t *testing.T) {
			there, err := store.Find(ctx, s.In(ws), &core.Task{}, store.Eq("id", id.New()))
			if err != nil || there {
				t.Fatalf("Find of a task not there: %v %v", there, err)
			}
		})
		t.Run("in another workspace", func(t *testing.T) {
			there, err := store.Find(ctx, s.In(other), &core.Task{}, store.Eq("id", some.ID))
			if err != nil || there {
				t.Fatalf("Find of another workspace's task: %v %v", there, err)
			}
		})
		t.Run("in a write", func(t *testing.T) {
			err := s.Write(ctx, ws, func(tx store.Tx) error {
				there, err := store.Find(ctx, tx, &core.Task{}, store.Eq("id", some.ID))
				if err != nil || !there {
					t.Fatalf("Find in a write: %v %v", there, err)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
		t.Run("a failure", func(t *testing.T) {
			if _, err := s.db.ExecContext(ctx, `DROP TABLE task_keys`); err != nil {
				t.Fatal(err)
			}
			there, err := store.Find(ctx, s.In(ws), &core.TaskKey{}, store.Eq("key", "X-1"))
			if err == nil || errors.Is(err, store.ErrNotFound) || there {
				t.Fatalf("Find on a table that cannot be read: %v %v, want the failure", there, err)
			}
		})
	})
}

// TestIncrStartsACounterThatIsNotThere: Incr on a counter with no row makes
// the row, once, however many callers start it at the same time.
func TestIncrStartsACounterThatIsNotThere(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		at := []store.Cond{store.Eq("name", "test:a"), store.Eq("bucket", 7)}

		n, err := s.Incr(ctx, "rate_counters", "hits", 3, at...)
		if err != nil || n != 3 {
			t.Fatalf("the first Incr: %d %v, want 3", n, err)
		}
		if n, err = s.Incr(ctx, "rate_counters", "hits", 2, at...); err != nil || n != 5 {
			t.Fatalf("the second Incr: %d %v, want 5", n, err)
		}

		t.Run("by many at once", func(t *testing.T) {
			const callers = 20
			got := make(chan int64, callers)
			var wg sync.WaitGroup
			for range callers {
				wg.Go(func() {
					n, err := s.Incr(ctx, "rate_counters", "hits", 1, store.Eq("name", "test:b"), store.Eq("bucket", 7))
					if err != nil {
						t.Error(err)
					}
					got <- n
				})
			}
			wg.Wait()
			close(got)
			seen := map[int64]bool{}
			for n := range got {
				seen[n] = true
			}
			if len(seen) != callers || !seen[1] || !seen[callers] {
				t.Fatalf("the callers were told %v, want each of 1 to %d once", seen, callers)
			}
		})

		t.Run("not in another workspace", func(t *testing.T) {
			ws := fillTasks(t, s, 1)
			var project core.Project
			if err := s.In(ws).Get(ctx, &project); err != nil {
				t.Fatal(err)
			}
			elsewhere := id.New()
			if err := s.Insert(ctx, core.Workspace{ID: elsewhere, Slug: "elsewhere", Name: "E", CreatedAt: 1, UpdatedAt: 1}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.In(elsewhere).Incr(ctx, "projects", "task_counter", 1, store.Eq("id", project.ID)); err == nil {
				t.Fatal("a project of another workspace was counted on")
			}
			var after core.Project
			if err := s.Get(ctx, &after, store.Eq("id", project.ID)); err != nil || after.TaskCounter != project.TaskCounter {
				t.Fatalf("the project's counter went from %d to %d (%v)", project.TaskCounter, after.TaskCounter, err)
			}
		})
	})
}

// TestEitherSelectsTheRowsAnyOfItsConditionsDoes: Either is an OR of whole
// conditions, combined with the others by AND; with no condition it
// selects nothing.
func TestEitherSelectsTheRowsAnyOfItsConditionsDoes(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		db := s.In(fillTasks(t, s, 6))
		var all []core.Task
		if err := db.List(ctx, &all, store.Q{Order: "created_seq"}); err != nil || len(all) != 6 {
			t.Fatalf("%d tasks (%v)", len(all), err)
		}
		count := func(conds ...store.Cond) int {
			t.Helper()
			var got []core.Task
			if err := db.List(ctx, &got, store.Where(conds...)); err != nil {
				t.Fatal(err)
			}
			return len(got)
		}
		if n := count(store.Either(store.Eq("id", all[0].ID), store.Eq("id", all[1].ID))); n != 2 {
			t.Errorf("either of two ids selects %d tasks, want 2", n)
		}
		if n := count(store.Either(store.Eq("id", all[0].ID), store.In("id", []string{all[1].ID, all[2].ID})), store.Eq("project_id", all[0].ProjectID)); n != 2 {
			t.Errorf("either of three ids, in one of the two projects, selects %d tasks, want 2", n)
		}
		if n := count(store.Either()); n != 0 {
			t.Errorf("a choice of nothing selects %d tasks, want none", n)
		}
	})
}
