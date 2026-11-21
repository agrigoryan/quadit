package sqlstore_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeCountsAnAgentThatMadeAChangeAsConnected: an agent that made a
// change before version 22 had reached Quadit from its tool, so the upgrade
// counts it as connected since its first change. One that never made a
// change is not connected yet, and a person is neither. What a wait on the
// feed marked as listening before is not a listener's lease, and goes.
func TestUpgradeCountsAnAgentThatMadeAChangeAsConnected(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 21)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			do := func(actor string, typ string, args map[string]any) string {
				t.Helper()
				raw, _ := json.Marshal(args)
				res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: actor}, engine.Change{ID: id.New(), Type: typ, Args: raw})
				if err != nil {
					t.Fatalf("%s: %v", typ, err)
				}
				return res.Ref
			}
			do(owner.ID, "project.create", map[string]any{"key": "OPS", "name": "Operations"})
			worker := do(owner.ID, "agent.create", map[string]any{"name": "Worker", "handle": "worker"})
			idle := do(owner.ID, "agent.create", map[string]any{"name": "Idle", "handle": "idle"})
			do(worker, "task.create", map[string]any{"project": "OPS", "title": "Rotate keys"})
			db := st.In(ws.ID)
			if _, err := db.Update(ctx, "members", map[string]any{"listening_until": time.Now().Add(time.Hour).UnixMilli()}, store.Eq("user_id", worker)); err != nil {
				t.Fatal(err)
			}
			var first core.AppliedChange
			if err := db.Get(ctx, &first, store.Eq("actor_id", worker)); err != nil {
				t.Fatal(err)
			}

			upgrade(t, st)
			for who, want := range map[string]int64{worker: first.CreatedAt, idle: 0, owner.ID: 0} {
				var m core.Member
				if err := db.Get(ctx, &m, store.Eq("user_id", who)); err != nil {
					t.Fatal(err)
				}
				if m.ConnectedAt != want {
					t.Errorf("@%s is connected at %d, want %d", m.Handle, m.ConnectedAt, want)
				}
				if m.ListeningUntil != 0 {
					t.Errorf("@%s is still marked listening until %d", m.Handle, m.ListeningUntil)
				}
			}
		})
	}
}
