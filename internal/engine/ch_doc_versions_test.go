package engine_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestKeepingAVersionIsInTheFeed: a version kept by hand is a change of
// the page's state like any other, so it moves the feed and says so, and
// the version is numbered by the event that tells of it.
func TestKeepingAVersionIsInTheFeed(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		page := w.do(w.owner.ID, "doc.create", M{"title": "Handbook", "markdown": "Rule one."}).Ref
		res := w.do(w.owner.ID, "doc.snapshot", M{"doc": page, "label": "first"})
		if len(res.Events) != 1 {
			t.Fatalf("keeping a version wrote %d events: %+v", len(res.Events), res.Events)
		}
		ev := res.Events[0]
		var ver core.DocVersion
		if err := w.db().Get(ctx, &ver, store.Eq("doc_id", page), store.Eq("label", "first")); err != nil {
			t.Fatal(err)
		}
		var data struct{ Row core.DocVersion }
		if err := json.Unmarshal(ev.Data, &data); err != nil {
			t.Fatal(err)
		}
		if ev.Type != "version.created" || ev.EntityID != ver.ID || ev.ScopeType != "doc" || ev.ScopeID != page || ver.Seq != ev.Seq {
			t.Fatalf("event %s %s in %s %s at %d, version %s at %d", ev.Type, ev.EntityID, ev.ScopeType, ev.ScopeID, ev.Seq, ver.ID, ver.Seq)
		}
		if data.Row.ID != ver.ID || data.Row.Label != "first" || len(data.Row.Snapshot) != 0 {
			t.Fatalf("the event's row is %+v; it names the version and leaves the page's content to the version itself", data.Row)
		}
	})
}
