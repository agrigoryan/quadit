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
