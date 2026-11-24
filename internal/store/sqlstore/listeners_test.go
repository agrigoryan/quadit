package sqlstore_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeMakesAMembersLeaseTheListenerOfEverything: the lease a
// member's row held before version 25 was its one listener's, which
// listened to everything: the upgrade makes it the listener of everything,
// with its id, its end, what held it and when it was last heard, so the
// session that holds it goes on acknowledging with it.
func TestUpgradeMakesAMembersLeaseTheListenerOfEverything(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 24)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(map[string]any{"name": "Coder", "handle": "coder"})
			res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "agent.create", Args: raw})
			if err != nil {
				t.Fatal(err)
			}
			coder := res.Ref
			until, heard := time.Now().Add(time.Minute).UnixMilli(), time.Now().UnixMilli()
			if err := st.Exec(ctx, fmt.Sprintf(`UPDATE members SET listen_lease = 'KQ7MX4PA', listening_until = %d, listen_heard_at = %d, listen_by = 'a companion' WHERE user_id = '%s'`,
				until, heard, coder)); err != nil {
				t.Fatal(err)
			}

			upgrade(t, st)
			db := st.In(ws.ID)
			var listeners []core.Listener
			if err := db.List(ctx, &listeners, store.Q{}); err != nil {
				t.Fatal(err)
			}
			want := core.Listener{WorkspaceID: ws.ID, AgentID: coder, Lease: "KQ7MX4PA", LeaseUntil: until, HeardAt: heard, HeldBy: "a companion"}
			if len(listeners) != 1 || listeners[0] != want {
				t.Fatalf("after the upgrade the listeners are %+v, want only %+v", listeners, want)
			}
			var m core.Member
			if err := db.Get(ctx, &m, store.Eq("user_id", coder)); err != nil {
				t.Fatal(err)
			}
			if m.ListeningUntil != until {
				t.Fatalf("the member listens until %d, want %d", m.ListeningUntil, until)
			}
		})
	}
}
