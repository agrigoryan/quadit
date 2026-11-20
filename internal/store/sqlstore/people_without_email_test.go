package sqlstore_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeLetsAPersonHaveNoEmail: until version 20 a person needed an
// email address. The upgrade lets one have none, as an agent has none, and
// keeps every account as it was, with what points at it; an address is
// still one account's only.
func TestUpgradeLetsAPersonHaveNoEmail(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 19)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(map[string]any{"name": "Ops bot", "handle": "ops"})
			res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: owner.ID}, engine.Change{ID: id.New(), Type: "agent.create", Args: raw})
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Bea", WorkspaceSlug: "bea", WorkspaceName: "Bea"}); err == nil {
				t.Fatal("version 19 took a person with no email")
			}

			upgrade(t, st)
			var before core.User
			if err := st.Get(ctx, &before, store.Eq("id", owner.ID)); err != nil || before.Email != "aram@example.com" || !before.IsAdmin {
				t.Fatalf("the owner after the upgrade: %+v (%v)", before, err)
			}
			var bot core.User
			if err := st.Get(ctx, &bot, store.Eq("id", res.Ref)); err != nil || bot.ResponsibleID != owner.ID {
				t.Fatalf("the agent after the upgrade: %+v (%v)", bot, err)
			}
			if n, err := st.In(ws.ID).Count(ctx, "members", store.Eq("user_id", owner.ID)); err != nil || n != 1 {
				t.Fatalf("the owner's membership after the upgrade: %d (%v)", n, err)
			}

			_, bea, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Bea", WorkspaceSlug: "bea", WorkspaceName: "Bea"})
			if err != nil || bea.Email != "" {
				t.Fatalf("a person with no email: %+v (%v)", bea, err)
			}
			taken := core.User{ID: id.New(), Kind: core.KindPerson, Name: "Not Aram", Email: "aram@example.com", CreatedAt: 1, UpdatedAt: 1}
			if err := st.Insert(ctx, taken); err == nil {
				t.Fatal("a second account took aram@example.com")
			}
			stray := core.Member{WorkspaceID: ws.ID, UserID: id.New(), Role: core.RoleMember, Handle: "nobody", Kind: core.KindPerson, Name: "Nobody", CreatedAt: 1}
			if err := st.Insert(ctx, stray); err == nil {
				t.Fatal("a member of no account was taken: the pointers to users are not checked any more")
			}
		})
	}
}
