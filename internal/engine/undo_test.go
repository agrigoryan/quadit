package engine_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// undo applies a change that says it takes back the change undone.
func (w *world) undo(userID, undone, typ string, args any) *engine.Result {
	w.t.Helper()
	raw, _ := json.Marshal(args)
	res, err := w.e.Batch(context.Background(), w.ws.ID, engine.Actor{UserID: userID},
		[]engine.Change{{ID: id.New(), Type: typ, Args: raw, Undoes: undone}}, false)
	if err != nil {
		w.t.Fatalf("%s: %v", typ, err)
	}
	return res[0]
}

// A mistake put right at once is news to nobody: the undo of a change made
// a moment ago takes the unread inbox items of that change out again and
// makes none of its own.
func TestUndoTakesItsNewsBack(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		artist := w.agent("artist")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design"})
		assign := func() *engine.Result {
			return w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "assignee": "@artist"})
		}
		unassign := M{"id": "SVA-1", "assignee": nil}

		t.Run("an undo at once removes the unread item and says so to its owner alone", func(t *testing.T) {
			given := assign()
			if got := w.inbox(artist); len(got) != 1 {
				t.Fatalf("inbox after assigning = %+v", got)
			}
			res := w.undo(w.owner.ID, given.ChangeID, "task.update", unassign)
			if got := w.inbox(artist); len(got) != 0 {
				t.Fatalf("inbox after the undo = %+v", got)
			}
			var gone, updated *core.Event
			for i, ev := range res.Events {
				switch ev.Type {
				case "notification.deleted":
					gone = &res.Events[i]
				case "task.updated":
					updated = &res.Events[i]
				case "notification.created":
					t.Fatalf("the undo made an inbox item: %s", ev.Data)
				}
			}
			if gone == nil || gone.AudienceID != artist {
				t.Fatalf("no notification.deleted for the artist in %+v", res.Events)
			}
			var data core.EventData
			if err := json.Unmarshal(updated.Data, &data); err != nil || data.Undoes != given.ChangeID {
				t.Fatalf("the undo's event does not name what it undoes: %s (%v)", updated.Data, err)
			}
		})

		t.Run("an item already read stays", func(t *testing.T) {
			given := assign()
			item := w.inbox(artist)[0]
			w.do(artist, "notification.read", M{"ids": []string{item.ID}})
			w.undo(w.owner.ID, given.ChangeID, "task.update", unassign)
			if got := w.inbox(artist); len(got) != 1 || got[0].ID != item.ID {
				t.Fatalf("inbox = %+v", got)
			}
			w.do(artist, "notification.read", M{"ids": []string{item.ID}, "archive": true})
		})

		t.Run("someone else's change is not taken back by naming it", func(t *testing.T) {
			lead := w.agent("lead")
			given := assign()
			before := len(w.inbox(artist))
			w.undo(lead, given.ChangeID, "task.update", unassign)
			if got := w.inbox(artist); len(got) < before {
				t.Fatalf("the item is gone: %+v", got)
			}
		})

		t.Run("later than five minutes the undo is a change like any other", func(t *testing.T) {
			given := assign()
			before := len(w.inbox(artist))
			long := time.Now().Add(-6 * time.Minute).UnixMilli()
			if _, err := w.db().Update(context.Background(), "changes", map[string]any{"created_at": long}, store.Eq("id", given.ChangeID)); err != nil {
				t.Fatal(err)
			}
			w.undo(w.owner.ID, given.ChangeID, "task.update", unassign)
			if got := w.inbox(artist); len(got) < before {
				t.Fatalf("the item is gone: %+v", got)
			}
		})
	})
}
