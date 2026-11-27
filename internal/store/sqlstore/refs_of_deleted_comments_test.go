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

// TestUpgradeTakesAwayWhatDeletedCommentsMentioned: before version 32 a
// deleted comment kept what its text mentioned (a task went on listing a
// page only that comment named). The upgrade takes those references away,
// and keeps every other: a live comment's, a task's own.
func TestUpgradeTakesAwayWhatDeletedCommentsMentioned(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 31)
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
			do("project.create", map[string]any{"key": "SVA", "name": "Game"})
			page := do("doc.create", map[string]any{"title": "Handbook", "markdown": "how we work\n"})
			do("task.create", map[string]any{"project": "SVA", "title": "Boss fight", "description": "See doc:" + page})
			kept := do("comment.create", map[string]any{"task": "SVA-1", "body": "Also doc:" + page})
			gone := do("comment.create", map[string]any{"task": "SVA-1", "body": "And doc:" + page})
			// Deleted as the engine of before deleted it: the comment in the trash, its references left.
			db := st.In(ws.ID)
			if _, err := db.Update(ctx, "comments", map[string]any{"deleted_at": 5}, store.Eq("id", gone)); err != nil {
				t.Fatal(err)
			}
			mentions := func(fromID string) int {
				t.Helper()
				var refs []core.Ref
				if err := db.List(ctx, &refs, store.Where(store.Eq("from_id", fromID))); err != nil {
					t.Fatal(err)
				}
				return len(refs)
			}
			if mentions(gone) == 0 {
				t.Fatal("the deleted comment mentions nothing before the upgrade")
			}
			task := do("task.update", map[string]any{"id": "SVA-1", "title": "Boss fight, again"})

			upgrade(t, st)
			if n := mentions(gone); n != 0 {
				t.Errorf("the deleted comment still mentions %d things", n)
			}
			if mentions(kept) != 1 || mentions(task) != 1 {
				t.Errorf("the upgrade took away what a live comment (%d) or the task (%d) mentions", mentions(kept), mentions(task))
			}
		})
	}
}
