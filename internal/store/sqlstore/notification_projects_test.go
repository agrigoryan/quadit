package sqlstore_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradePutsInboxEventsInTheProjectOfWhatTheyAreAbout: until version
// 10 the event of an inbox item belonged to no project, so a feed kept to
// some projects gave its reader the items about tasks of others. The
// upgrade puts each in the project of its task; one about nothing in a
// project stays the workspace's.
func TestUpgradePutsInboxEventsInTheProjectOfWhatTheyAreAbout(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openAtVersion(t, d, 9)
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
			ops := do(owner.ID, "project.create", map[string]any{"key": "OPS", "name": "Operations"})
			bot := do(owner.ID, "agent.create", map[string]any{"name": "Ops bot", "handle": "ops"})
			do(bot, "task.create", map[string]any{"project": "OPS", "title": "Rotate keys", "assignee": "@aram"})
			do(bot, "notify", map[string]any{"user": "@aram", "message": "about nothing in a project"})
			db := st.In(ws.ID)
			// What the version before wrote: the item's event in no project.
			if _, err := db.Update(ctx, "events", map[string]any{"project_id": nil}, store.Eq("type", "notification.created")); err != nil {
				t.Fatal(err)
			}

			if err := st.MigrateTo(ctx, 0); err != nil {
				t.Fatal(err)
			}
			evs, err := db.Events(ctx, store.EventFilter{Types: []string{"notification.created"}, Limit: 10})
			if err != nil {
				t.Fatal(err)
			}
			if len(evs) != 2 {
				t.Fatalf("%d inbox events, want 2", len(evs))
			}
			for _, ev := range evs {
				want := ""
				if ev.ScopeType == "task" {
					want = ops
				}
				if ev.ProjectID != want {
					t.Errorf("the inbox event in the %s's timeline belongs to project %q, want %q", ev.ScopeType, ev.ProjectID, want)
				}
			}
		})
	}
}
