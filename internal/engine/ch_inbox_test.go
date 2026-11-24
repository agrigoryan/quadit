package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestInboxItemTakenOutCanBePutBack(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		artist := w.agent("artist")
		w.do(w.owner.ID, "notify", M{"user": "@artist", "message": "one"})
		w.do(w.owner.ID, "notify", M{"user": "@artist", "message": "two"})
		items := w.inbox(artist)
		if len(items) != 2 {
			t.Fatalf("inbox = %+v", items)
		}
		first := items[0].ID

		t.Run("archive and unarchive together are refused", func(t *testing.T) {
			w.refused(engine.CodeInvalid, artist, "notification.read", M{"ids": []string{first}, "archive": true, "unarchive": true})
		})

		t.Run("unarchive brings back what was archived, still read", func(t *testing.T) {
			w.do(artist, "notification.read", M{"ids": []string{first}, "archive": true})
			archived := w.inbox(artist)[0]
			if archived.ArchivedAt == 0 || archived.ReadAt == 0 {
				t.Fatalf("archived item = %+v", archived)
			}
			res := w.do(artist, "notification.read", M{"ids": []string{first}, "unarchive": true})
			back := w.inbox(artist)[0]
			if back.ArchivedAt != 0 || back.ReadAt != archived.ReadAt {
				t.Fatalf("unarchived item = %+v, read_at was %d", back, archived.ReadAt)
			}
			if len(res.Events) != 1 {
				t.Fatalf("events = %+v", res.Events)
			}
			ev := res.Events[0]
			d, err := ev.Payload()
			if err != nil {
				t.Fatal(err)
			}
			if ev.Type != "notification.updated" || ev.AudienceID != artist || len(d.IDs) != 1 || d.IDs[0] != first {
				t.Fatalf("event = %+v, data %+v", ev, d)
			}
			if ch, ok := d.Changes["archived_at"]; !ok || len(d.Changes) != 1 || ch.To != float64(0) {
				t.Fatalf("changes = %+v", d.Changes)
			}
		})

		t.Run("unarchive leaves items that are not archived alone", func(t *testing.T) {
			res := w.do(artist, "notification.read", M{"all": true, "unarchive": true})
			if len(res.Events) != 0 {
				t.Fatalf("events = %+v", res.Events)
			}
		})

		t.Run("only the caller's own items come back", func(t *testing.T) {
			w.do(artist, "notification.read", M{"ids": []string{first}, "archive": true})
			w.do(w.owner.ID, "notification.read", M{"ids": []string{first}, "unarchive": true})
			var n core.Notification
			if err := w.db().Get(context.Background(), &n, store.Eq("id", first)); err != nil {
				t.Fatal(err)
			}
			if n.ArchivedAt == 0 {
				t.Fatal("another member took the item out of the archive")
			}
		})
	})
}

// unreadOf is a member's unread inbox items, of the task given ("" for
// any), by type.
func (w *world) unreadOf(userID, taskID string) []string {
	w.t.Helper()
	var out []string
	for _, n := range w.inbox(userID) {
		if n.ReadAt == 0 && (taskID == "" || n.TaskID == taskID) {
			out = append(out, n.Type)
		}
	}
	return out
}

// readEvent is the notification.updated a change's result told userID,
// with the items it read; none when it told nothing.
func readEvent(t *testing.T, res *engine.Result, userID string) []string {
	t.Helper()
	for _, ev := range res.Events {
		if ev.Type != "notification.updated" || ev.AudienceID != userID {
			continue
		}
		d, err := ev.Payload()
		if err != nil {
			t.Fatal(err)
		}
		if ch, ok := d.Changes["read_at"]; !ok || len(d.Changes) != 1 || ch.To == nil || ev.ScopeType != "workspace" {
			t.Fatalf("the event that reads items is %+v, %+v", ev, d)
		}
		return d.IDs
	}
	return nil
}

// TestWritingOnATaskReadsYourItemsOfIt: a comment, a reply, a result or
// an answer on a task, by a person or an agent in person, marks read their
// own items of that task from before it, tells them so as notification.read
// does, and leaves alone their items of other tasks, those that come
// after, and what a write the engine makes in their name would.
func TestWritingOnATaskReadsYourItemsOfIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		artist := w.agent("artist")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		mine := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss", "assignee": "@artist"}).Key
		other := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Arena", "assignee": "@artist"}).Key
		first := w.do(w.owner.ID, "comment.create", M{"task": mine, "body": "Make it harder."}).Ref
		w.do(w.owner.ID, "comment.create", M{"task": other, "body": "Bigger."})
		mineID, otherID := w.task(mine).ID, w.task(other).ID

		t.Run("a write in the agent's name that it did not make in person reads nothing", func(t *testing.T) {
			err := w.e.System(context.Background(), w.ws.ID, artist, func(sys *engine.Sys) error {
				return sys.Do("comment.create", M{"task": mine, "body": "Posted by a rule."})
			})
			if err != nil {
				t.Fatal(err)
			}
			if got := w.unreadOf(artist, mineID); len(got) != 2 {
				t.Fatalf("after a write made in its name the agent's unread items of %s are %q", mine, got)
			}
		})
		t.Run("an agent's comment reads its items of that task", func(t *testing.T) {
			res := w.do(artist, "comment.create", M{"task": mine, "body": "On it."})
			if got := w.unreadOf(artist, mineID); len(got) != 0 {
				t.Fatalf("after its comment the agent's unread items of %s are %q", mine, got)
			}
			if got := readEvent(t, res, artist); len(got) != 2 {
				t.Fatalf("the agent was told of %d items read", len(got))
			}
			if got := w.unreadOf(artist, otherID); len(got) != 2 {
				t.Fatalf("the agent's items of %s are %q: another task's were read", other, got)
			}
		})
		t.Run("what comes after the write stays unread, until a reply reads it", func(t *testing.T) {
			w.do(w.owner.ID, "comment.create", M{"task": mine, "body": "And the music."})
			if got := w.unreadOf(artist, mineID); len(got) != 1 {
				t.Fatalf("the item after the comment is %q", got)
			}
			w.do(artist, "comment.create", M{"task": mine, "parent": first, "body": "Harder it is."})
			if got := w.unreadOf(artist, mineID); len(got) != 0 {
				t.Fatalf("after its reply the agent's unread items of %s are %q", mine, got)
			}
		})
		t.Run("a result reads them too", func(t *testing.T) {
			w.do(artist, "comment.create", M{"task": other, "kind": "result", "body": "Bigger now."})
			if got := w.unreadOf(artist, otherID); len(got) != 0 {
				t.Fatalf("after its result the agent's unread items of %s are %q", other, got)
			}
		})
		t.Run("a person's comment reads theirs", func(t *testing.T) {
			if got := w.unreadOf(w.owner.ID, otherID); len(got) == 0 {
				t.Fatal("the owner has no item of the agent's result")
			}
			res := w.do(w.owner.ID, "comment.create", M{"task": other, "body": "Looks good."})
			if got := w.unreadOf(w.owner.ID, otherID); len(got) != 0 {
				t.Fatalf("after their comment the owner's unread items of %s are %q", other, got)
			}
			if got := readEvent(t, res, w.owner.ID); len(got) == 0 {
				t.Fatal("the owner was not told of the items read")
			}
		})
	})
}

// TestAQuestionNoLongerOpenReadsItsItems: a question answered, or taken
// back, marks read the items that asked it of someone (decision_asked,
// unclear), whoever answers, and tells them; the asker's item of the
// answer stays unread until the asker writes on the task.
func TestAQuestionNoLongerOpenReadsItsItems(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		artist := w.agent("artist")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		key := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss", "assignee": "@artist"}).Key
		taskID := w.task(key).ID
		ask := func(by, of, question string) string {
			return w.do(by, "decision.open", M{"task": key, "question": question, "ask": of, "options": []M{{"label": "Big"}, {"label": "Small"}}}).Ref
		}
		unread := func(userID, typ string) int {
			n := 0
			for _, got := range w.unreadOf(userID, taskID) {
				if got == typ {
					n++
				}
			}
			return n
		}

		t.Run("answered: the one asked has read it; the asker has the answer to read", func(t *testing.T) {
			d := ask(artist, "@aram", "Which boss?")
			res := w.do(w.owner.ID, "decision.pick", M{"id": d, "option": 1})
			if unread(w.owner.ID, core.NoteAsked) != 0 || unread(artist, core.NotePicked) != 1 {
				t.Fatalf("after the answer the owner has %q unread, the agent %q", w.unreadOf(w.owner.ID, taskID), w.unreadOf(artist, taskID))
			}
			if got := readEvent(t, res, w.owner.ID); len(got) == 0 {
				t.Fatal("the owner was not told of the question read")
			}
			t.Run("found unclear: the asker's writing reads the answer; answered again, the one asked has read it", func(t *testing.T) {
				w.do(artist, "decision.unclear", M{"id": d, "note": "how big?"})
				if unread(artist, core.NotePicked) != 0 || unread(w.owner.ID, core.NoteUnclear) != 1 {
					t.Fatalf("after unclear the agent has %q unread, the owner %q", w.unreadOf(artist, taskID), w.unreadOf(w.owner.ID, taskID))
				}
				w.do(w.owner.ID, "decision.pick", M{"id": d, "option": 2})
				if unread(w.owner.ID, core.NoteUnclear) != 0 {
					t.Fatalf("answered again, the owner has %q unread", w.unreadOf(w.owner.ID, taskID))
				}
			})
		})
		t.Run("an agent asked answers: its item is read", func(t *testing.T) {
			d := ask(w.owner.ID, "@artist", "Which arena?")
			w.do(artist, "decision.pick", M{"id": d, "option": 1})
			if unread(artist, core.NoteAsked) != 0 {
				t.Fatalf("after its answer the agent has %q unread", w.unreadOf(artist, taskID))
			}
		})
		t.Run("taken back: the one asked has nothing to answer", func(t *testing.T) {
			d := ask(artist, "@aram", "Which music?")
			res := w.do(artist, "decision.delete", M{"id": d})
			if unread(w.owner.ID, core.NoteAsked) != 0 {
				t.Fatalf("after the question went, the owner has %q unread", w.unreadOf(w.owner.ID, taskID))
			}
			if got := readEvent(t, res, w.owner.ID); len(got) != 1 {
				t.Fatalf("the owner was told of %d items read", len(got))
			}
		})
		t.Run("a question still open stays unread", func(t *testing.T) {
			ask(artist, "@aram", "Which sky?")
			if unread(w.owner.ID, core.NoteAsked) != 1 {
				t.Fatalf("the owner has %q unread", w.unreadOf(w.owner.ID, taskID))
			}
		})
	})
}
