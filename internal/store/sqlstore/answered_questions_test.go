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

// TestUpgradeReadsTheItemsOfQuestionsNoLongerOpen: version 29 marks read
// the items that asked a member a question since answered (at the time
// of the answer) or taken back (at the upgrade's), and nothing else: the
// item of a question still open, and the asker's item of the answer, stay
// unread.
func TestUpgradeReadsTheItemsOfQuestionsNoLongerOpen(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 28)
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
			do(owner.ID, "project.create", map[string]any{"key": "SVA", "name": "Game"})
			coder := do(owner.ID, "agent.create", map[string]any{"name": "Coder", "handle": "coder"})
			task := do(owner.ID, "task.create", map[string]any{"project": "SVA", "title": "Boss fight"})
			ask := func(question string) string {
				return do(coder, "decision.open", map[string]any{"task": task, "question": question, "ask": "@aram",
					"options": []map[string]any{{"label": "Big"}, {"label": "Small"}}})
			}
			answered, open, withdrawn := ask("Which boss?"), ask("Which arena?"), ask("Which music?")
			do(owner.ID, "decision.pick", map[string]any{"id": answered, "option": 1})
			do(coder, "decision.delete", map[string]any{"id": withdrawn})
			// The engine of now reads them at once; the database of before did not.
			if err := st.Exec(ctx, "UPDATE notifications SET read_at = NULL"); err != nil {
				t.Fatal(err)
			}

			upgrade(t, st)
			db := st.In(ws.ID)
			var decided core.Decision
			if err := db.Get(ctx, &decided, store.Eq("id", answered)); err != nil {
				t.Fatal(err)
			}
			readAt := func(typ, decision string) int64 {
				t.Helper()
				var n core.Notification
				if err := db.Get(ctx, &n, store.Eq("type", typ), store.Eq("entity_id", decision)); err != nil {
					t.Fatal(err)
				}
				return n.ReadAt
			}
			if got := readAt(core.NoteAsked, answered); got == 0 || got != decided.DecidedAt {
				t.Errorf("the answered question's item reads at %d, want its answer's time %d", got, decided.DecidedAt)
			}
			if got := readAt(core.NoteAsked, withdrawn); got == 0 {
				t.Error("the item of the question taken back is still unread")
			}
			if got := readAt(core.NoteAsked, open); got != 0 {
				t.Errorf("the item of the open question was read at %d", got)
			}
			if got := readAt(core.NotePicked, answered); got != 0 {
				t.Errorf("the asker's item of the answer was read at %d", got)
			}
		})
	}
}
