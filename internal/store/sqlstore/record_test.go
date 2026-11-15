package sqlstore

import (
	"context"
	"errors"
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
