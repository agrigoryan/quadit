package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

var errDiskGone = errors.New("the disk went away")

// faultStore is a store whose reads inside a write fail when fail says so:
// a database that breaks in the middle of a change.
type faultStore struct {
	store.Store
	mu   sync.Mutex
	fail func(dst any, where []store.Cond) bool
}

func (s *faultStore) failWhen(fail func(dst any, where []store.Cond) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fail = fail
}

func (s *faultStore) Write(ctx context.Context, workspaceID string, fn func(store.Tx) error) error {
	return s.Store.Write(ctx, workspaceID, func(tx store.Tx) error { return fn(faultTx{Tx: tx, s: s}) })
}

type faultTx struct {
	store.Tx
	s *faultStore
}

func (tx faultTx) Get(ctx context.Context, dst any, where ...store.Cond) error {
	tx.s.mu.Lock()
	fail := tx.s.fail
	tx.s.mu.Unlock()
	if fail != nil && fail(dst, where) {
		return errDiskGone
	}
	return tx.Tx.Get(ctx, dst, where...)
}

func (tx faultTx) List(ctx context.Context, dst any, q store.Q) error {
	tx.s.mu.Lock()
	fail := tx.s.fail
	tx.s.mu.Unlock()
	if fail != nil && fail(dst, q.Where) {
		return errDiskGone
	}
	return tx.Tx.List(ctx, dst, q)
}

// byID reports whether a read looks a row up by this id alone.
func byID(where []store.Cond, id string) bool {
	return len(where) == 1 && where[0].Col == "id" && where[0].Val == id
}

// TestAFailedReadIsNotTakenForAMissingRow: when the database fails to read
// a row a change needs, the change fails with that error, instead of going
// on as if the row were not there.
func TestAFailedReadIsNotTakenForAMissingRow(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		faulty := &faultStore{Store: st}
		w := newWorld(t, faulty)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Ops"})
		w.do(w.owner.ID, "label.create", M{"name": "everywhere"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion", "labels": []string{"everywhere"}})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Sound"})

		failing := func(t *testing.T, typ string, args any, fail func(dst any, where []store.Cond) bool) {
			t.Helper()
			faulty.failWhen(fail)
			defer faulty.failWhen(nil)
			_, err := w.try(w.owner.ID, typ, args)
			if !errors.Is(err, errDiskGone) {
				t.Fatalf("%s with a failing read: got %v, want the read's error", typ, err)
			}
		}

		t.Run("a task moved with a label it keeps", func(t *testing.T) {
			// Before: the label was taken for deleted and silently dropped.
			failing(t, "task.move", M{"id": "SVA-1", "project": "OPS"}, func(dst any, _ []store.Cond) bool {
				_, label := dst.(*core.Label)
				return label
			})
			if got := w.task("SVA-1"); got.ProjectID == "" || len(got.LabelIDs) != 1 {
				t.Fatalf("the failed move changed the task: %+v", got)
			}
		})

		t.Run("a relation removed", func(t *testing.T) {
			w.do(w.owner.ID, "relation.add", M{"task": "SVA-1", "other": "SVA-2", "type": "blocks"})
			other := w.task("SVA-2").ID
			var rel core.Relation
			if err := w.db().Get(context.Background(), &rel, store.Eq("related_task_id", other)); err != nil {
				t.Fatal(err)
			}
			// Before: the other task was taken for gone, and was not told.
			failing(t, "relation.remove", M{"id": rel.ID}, func(dst any, where []store.Cond) bool {
				_, task := dst.(*core.Task)
				return task && byID(where, other)
			})
		})

		t.Run("a reply", func(t *testing.T) {
			first := w.do(w.owner.ID, "comment.create", M{"task": "SVA-1", "body": "first"}).Ref
			// Before: the parent was taken for deleted, and its author was
			// not told of the reply. Those the reply answers are read as a
			// list of the thread's comments.
			failing(t, "comment.create", M{"parent": first, "body": "a reply"}, func(dst any, _ []store.Cond) bool {
				_, thread := dst.(*[]core.Comment)
				return thread
			})
		})

		t.Run("an approval", func(t *testing.T) {
			// Before: an approval that could not be read was answered with
			// "needs approval", as if it had never been asked for.
			coder := w.agent("coder")
			w.do(w.owner.ID, "agent.update", M{"id": "@coder", "scope": M{"needs_approval": []string{"task.delete"}}})
			d := w.do(coder, "decision.open", M{"task": "SVA-2", "kind": "approval", "action": "task.delete", "args": M{"id": "SVA-2"}, "question": "Delete?", "ask": "@aram"}).Ref
			w.do(w.owner.ID, "decision.pick", M{"id": d, "outcome": "approved"})
			faulty.failWhen(func(dst any, _ []store.Cond) bool {
				_, decision := dst.(*core.Decision)
				return decision
			})
			defer faulty.failWhen(nil)
			_, err := w.e.Apply(context.Background(), w.ws.ID, engine.Actor{UserID: coder},
				engine.Change{ID: id.New(), Type: "task.delete", Args: json.RawMessage(`{"id": "SVA-2"}`), Approval: d})
			if !errors.Is(err, errDiskGone) {
				t.Fatalf("task.delete with an approval that cannot be read: got %v, want the read's error", err)
			}
		})
	})
}
