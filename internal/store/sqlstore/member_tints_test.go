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

// TestUpgradeGivesMembersTintsInTheOrderTheyJoined: members from before
// version 23 get their tints by the rule new members get theirs: the
// current members one after another through the palette in the order they
// joined, so a workspace of a person and one agent has two colors; the
// removed members likewise, apart.
func TestUpgradeGivesMembersTintsInTheOrderTheyJoined(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 22)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			do := func(typ string, args map[string]any) string {
				t.Helper()
				raw, _ := json.Marshal(args)
				res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: typ, Args: raw})
				if err != nil {
					t.Fatalf("%s: %v", typ, err)
				}
				return res.Ref
			}
			var agents []string
			for i := range 9 {
				agents = append(agents, do("agent.create", map[string]any{"name": fmt.Sprintf("Bot %d", i), "handle": fmt.Sprintf("bot%d", i)}))
			}
			do("member.remove", map[string]any{"id": agents[8]})
			db := st.In(ws.ID)
			// As the version before left them: no tint, and joined one after another.
			for i, who := range append([]string{owner.ID}, agents...) {
				if _, err := db.Update(ctx, "members", map[string]any{"created_at": time.UnixMilli(1_700_000_000_000).Add(time.Duration(i) * time.Minute).UnixMilli()},
					store.Eq("user_id", who)); err != nil {
					t.Fatal(err)
				}
			}

			upgrade(t, st)
			want := map[string]int{owner.ID: 1, agents[0]: 2, agents[6]: 8, agents[7]: 1, agents[8]: 1}
			for who, tint := range want {
				var m core.Member
				if err := db.Get(ctx, &m, store.Eq("user_id", who)); err != nil {
					t.Fatal(err)
				}
				if m.Tint != tint {
					t.Errorf("@%s has tint %d, want %d", m.Handle, m.Tint, tint)
				}
			}
		})
	}
}
