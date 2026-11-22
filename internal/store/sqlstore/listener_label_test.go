package sqlstore_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeSaysSinceWhenALeaseWasHeld: a lease held before version 24
// has held it at least since its holder last waited.
func TestUpgradeSaysSinceWhenALeaseWasHeld(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 23)
			ws, owner, err := engine.New(st, nil).Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			db := st.In(ws.ID)
			if _, err := db.Update(ctx, "members", map[string]any{"listen_lease": "KQ7MX4PA", "listen_heard_at": int64(1_700_000_000_000)}, store.Eq("user_id", owner.ID)); err != nil {
				t.Fatal(err)
			}
			upgrade(t, st)
			var m core.Member
			if err := db.Get(ctx, &m, store.Eq("user_id", owner.ID)); err != nil {
				t.Fatal(err)
			}
			if m.ListenSince != 1_700_000_000_000 {
				t.Fatalf("the lease is held since %d", m.ListenSince)
			}
		})
	}
}
