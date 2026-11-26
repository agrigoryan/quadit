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

// TestAdvanceOnlyMovesForward: Advance makes the row, moves it forward,
// leaves it where it is when asked to move back, and callers racing on it
// leave it at the furthest of their positions.
func TestAdvanceOnlyMovesForward(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		ws := fillTasks(t, s, 1)
		var project core.Project
		if err := s.In(ws).Get(ctx, &project); err != nil {
			t.Fatal(err)
		}
		db := s.In(ws)
		key := []string{"workspace_id", "user_id", "name"}
		at := func(name string) int64 {
			t.Helper()
			var cur core.Cursor
			if err := db.Get(ctx, &cur, store.Eq("user_id", project.CreatedBy), store.Eq("name", name)); err != nil {
				t.Fatal(err)
			}
			return cur.Seq
		}
		move := func(name string, seq int64) error {
			return db.Advance(ctx, core.Cursor{WorkspaceID: ws, UserID: project.CreatedBy, Name: name, Seq: seq, UpdatedAt: seq}, "seq", key...)
		}

		for _, step := range []struct{ to, want int64 }{{5, 5}, {9, 9}, {7, 9}, {9, 9}} {
			if err := move("main", step.to); err != nil {
				t.Fatal(err)
			}
			if got := at("main"); got != step.want {
				t.Fatalf("after moving to %d the row stands at %d, want %d", step.to, got, step.want)
			}
		}

		t.Run("by many at once", func(t *testing.T) {
			const callers = 40
			var wg sync.WaitGroup
			for seq := range int64(callers) {
				wg.Go(func() {
					if err := move("raced", seq+1); err != nil {
						t.Error(err)
					}
				})
			}
			wg.Wait()
			if got := at("raced"); got != callers {
				t.Fatalf("after %d racing moves the row stands at %d", callers, got)
			}
		})
	})
}

// TestEnsureLeavesARowThatIsThere: Ensure makes a row that is not there,
// and leaves one with the same key columns exactly as it is, inside a
// transaction too, which goes on (a refused insert would end it on
// Postgres).
func TestEnsureLeavesARowThatIsThere(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		ws := fillTasks(t, s, 1)
		var project core.Project
		if err := s.In(ws).Get(ctx, &project); err != nil {
			t.Fatal(err)
		}
		key := []string{"workspace_id", "user_id", "name"}
		cursor := func(seq int64) core.Cursor {
			return core.Cursor{WorkspaceID: ws, UserID: project.CreatedBy, Name: "main", Seq: seq, UpdatedAt: seq}
		}
		at := func() int64 {
			t.Helper()
			var cur core.Cursor
			if err := s.In(ws).Get(ctx, &cur, store.Eq("user_id", project.CreatedBy), store.Eq("name", "main")); err != nil {
				t.Fatal(err)
			}
			return cur.Seq
		}
		if err := s.In(ws).Ensure(ctx, cursor(5), key...); err != nil || at() != 5 {
			t.Fatalf("a row that was not there: %v, at %d", err, at())
		}
		err := s.Atomic(ctx, func(db store.DB) error {
			if err := db.Ensure(ctx, cursor(9), key...); err != nil {
				return err
			}
			return db.Ensure(ctx, core.Cursor{WorkspaceID: ws, UserID: project.CreatedBy, Name: "other", Seq: 1, UpdatedAt: 1}, key...)
		})
		if err != nil || at() != 5 {
			t.Fatalf("a row that was there: %v, at %d, want 5", err, at())
		}
		var other core.Cursor
		if err := s.In(ws).Get(ctx, &other, store.Eq("name", "other")); err != nil {
			t.Fatalf("the transaction did not go on after a row that was there: %v", err)
		}
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

// TestARunnersMachineIDIsFoundByIt: a runner's machine id is 16 hex digits
// of its own, not a UUID, and a session or a listener is found by it.
func TestARunnersMachineIDIsFoundByIt(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		db := s.In(fillTasks(t, s, 1))
		var task core.Task
		if err := db.Get(ctx, &task); err != nil {
			t.Fatal(err)
		}
		const machine = "0123456789abcdef"
		if err := db.Insert(ctx, core.AgentSession{ID: id.New(), AgentID: task.CreatedBy, TaskID: task.ID, State: core.AgentSessionWaiting, MachineID: machine, StartedAt: 1, UpdatedSeq: 1}); err != nil {
			t.Fatal(err)
		}
		if err := db.Insert(ctx, core.Listener{AgentID: task.CreatedBy, ProjectID: task.ProjectID, Lease: "KQ7MX4PA", LeaseUntil: 1, HeardAt: 1, MachineID: machine}); err != nil {
			t.Fatal(err)
		}
		if there, err := store.Find(ctx, db, &core.AgentSession{}, store.Eq("machine_id", machine)); err != nil || !there {
			t.Errorf("the session of machine %s: found %v, %v", machine, there, err)
		}
		if there, err := store.Find(ctx, db, &core.Listener{}, store.Eq("machine_id", machine)); err != nil || !there {
			t.Errorf("the listener of machine %s: found %v, %v", machine, there, err)
		}
	})
}

// TestAPointerFieldKeepsItsZeroApartFromNone: a pointer field is NULL when
// nil and its value otherwise, 0 included, written whole or by Update.
func TestAPointerFieldKeepsItsZeroApartFromNone(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		db := s.In(fillTasks(t, s, 3))
		var tasks []core.Task
		if err := db.List(ctx, &tasks, store.Q{Order: "created_seq"}); err != nil {
			t.Fatal(err)
		}
		zero, five := 0, 5
		set := map[string]any{tasks[0].ID: nil, tasks[1].ID: zero, tasks[2].ID: &five}
		for taskID, estimate := range set {
			if _, err := db.Update(ctx, "tasks", map[string]any{"estimate": estimate}, store.Eq("id", taskID)); err != nil {
				t.Fatal(err)
			}
		}
		read := func(taskID string) *int {
			t.Helper()
			var got core.Task
			if err := db.Get(ctx, &got, store.Eq("id", taskID)); err != nil {
				t.Fatal(err)
			}
			return got.Estimate
		}
		if got := read(tasks[0].ID); got != nil {
			t.Errorf("none reads as %d", *got)
		}
		if got := read(tasks[1].ID); got == nil || *got != 0 {
			t.Errorf("0 reads as %v, want 0", got)
		}
		if got := read(tasks[2].ID); got == nil || *got != 5 {
			t.Errorf("5 reads as %v, want 5", got)
		}

		// Written whole, and read again into a row that held a value.
		made := tasks[0]
		made.ID, made.Number, made.Key, made.Estimate = id.New(), 99, "P0-99", &zero
		if err := db.Insert(ctx, made); err != nil {
			t.Fatal(err)
		}
		if got := read(made.ID); got == nil || *got != 0 {
			t.Errorf("0 inserted reads as %v, want 0", got)
		}
		again := core.Task{Estimate: &five}
		if err := db.Get(ctx, &again, store.Eq("id", tasks[0].ID)); err != nil || again.Estimate != nil {
			t.Errorf("a row without an estimate, read into one with, keeps %v (%v)", again.Estimate, err)
		}
	})
}
