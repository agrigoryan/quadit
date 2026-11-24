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

// TestUpgradeEndsTheFollowsAgentsGotByThemselves: before version 26 an
// agent followed every task, epic and page it touched or was given, and
// those rows cannot be told apart from ones it chose. The upgrade ends an
// agent's follows of those three kinds, so it behaves as on a new install;
// what only a choice ever followed (a project, a view) stays, and so does
// every follow of a person.
func TestUpgradeEndsTheFollowsAgentsGotByThemselves(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 25)
			e := engine.New(st, nil)
			ws, owner, err := e.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: "Aram", OwnerEmail: "aram@example.com", OwnerHandle: "aram", WorkspaceSlug: "games", WorkspaceName: "Games"})
			if err != nil {
				t.Fatal(err)
			}
			do := func(actor, typ string, args map[string]any) string {
				t.Helper()
				raw, _ := json.Marshal(args)
				res, err := e.Apply(ctx, ws.ID, engine.Actor{UserID: actor}, engine.Change{ID: id.New(), Type: typ, Args: raw})
				if err != nil {
					t.Fatalf("%s: %v", typ, err)
				}
				return res.Ref
			}
			do(owner.ID, "project.create", map[string]any{"key": "OPS", "name": "Operations"})
			bot := do(owner.ID, "agent.create", map[string]any{"name": "Bot", "handle": "bot"})
			subjects := map[string]string{
				"task":    do(owner.ID, "task.create", map[string]any{"project": "OPS", "title": "Rotate keys"}),
				"epic":    do(owner.ID, "epic.create", map[string]any{"project": "OPS", "name": "Hardening"}),
				"doc":     do(owner.ID, "doc.create", map[string]any{"title": "Runbook"}),
				"project": "OPS",
				"view":    do(owner.ID, "view.create", map[string]any{"name": "Ops board", "project": "OPS"}),
			}
			yes := true
			for kind, subject := range subjects {
				for _, who := range []string{owner.ID, bot} {
					do(who, "watch.set", map[string]any{"type": kind, "subject": subject, "watching": &yes})
				}
			}
			db := st.In(ws.ID)
			follows := func(who, kind string) bool {
				t.Helper()
				n, err := db.Count(ctx, "watchers", store.Eq("user_id", who), store.Eq("subject_type", kind))
				if err != nil {
					t.Fatal(err)
				}
				return n > 0
			}

			upgrade(t, st)
			for kind := range subjects {
				if !follows(owner.ID, kind) {
					t.Errorf("the person no longer follows the %s", kind)
				}
				want := kind == "project" || kind == "view"
				if got := follows(bot, kind); got != want {
					t.Errorf("after the upgrade the agent follows the %s: %v, want %v", kind, got, want)
				}
			}
		})
	}
}
