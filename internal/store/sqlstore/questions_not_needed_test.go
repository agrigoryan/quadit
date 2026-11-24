package sqlstore_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeSettlesWhatHangsOnClosedTasks: version 30 lets a question be
// no longer needed, and makes those open or sent back on a task done or
// canceled so, settled by nobody, with no answer and what sent one back
// kept as the reason; such a task waits on nobody. Questions on open
// tasks, and answered ones, stay as they were, and so does every other
// column of the questions.
func TestUpgradeSettlesWhatHangsOnClosedTasks(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 29)
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
			done := do(owner.ID, "task.create", map[string]any{"project": "SVA", "title": "Boss fight"})
			open := do(owner.ID, "task.create", map[string]any{"project": "SVA", "title": "Arena"})
			ask := func(task string) string {
				return do(coder, "decision.open", map[string]any{"task": task, "question": "Which?", "ask": "@aram", "options": []map[string]any{{"label": "A"}, {"label": "B"}}})
			}
			answered := ask(done)
			do(owner.ID, "decision.pick", map[string]any{"id": answered, "option": 1})
			stillOpen := ask(done)
			sentBack := ask(done)
			do(owner.ID, "decision.pick", map[string]any{"id": sentBack, "outcome": "none", "note": "talk it through"})
			onOpenTask := ask(open)
			// The engine of now reads what a send-back or an answer settles;
			// the database of before read nothing.
			if err := st.Exec(ctx, "UPDATE notifications SET read_at = NULL"); err != nil {
				t.Fatal(err)
			}
			// The database of before: the task went done and still waits on
			// the owner, as a hand-off on a done task left it.
			db := st.In(ws.ID)
			var doneStatus core.Status
			if err := db.Get(ctx, &doneStatus, store.Eq("category", core.CatDone)); err != nil {
				t.Fatal(err)
			}
			if err := st.Exec(ctx, fmt.Sprintf(`UPDATE tasks SET status_id = '%s', waiting_on_id = '%s', waiting_on_note = 'review the result' WHERE id = '%s'`,
				doneStatus.ID, owner.ID, done)); err != nil {
				t.Fatal(err)
			}
			var before core.Decision
			if err := db.Get(ctx, &before, store.Eq("id", sentBack)); err != nil {
				t.Fatal(err)
			}

			upgrade(t, st)
			state := func(ref string) core.Decision {
				t.Helper()
				var got core.Decision
				if err := db.Get(ctx, &got, store.Eq("id", ref)); err != nil {
					t.Fatal(err)
				}
				return got
			}
			for _, ref := range []string{stillOpen, sentBack} {
				if got := state(ref); got.State != core.StateNotNeeded || got.DecidedBy != "" || got.DecidedAt == 0 || got.Outcome != "" {
					t.Errorf("a question left on the done task is %+v", got)
				}
			}
			if got := state(sentBack); got.OutcomeNote != "talk it through" || got.Question != before.Question || got.CreatedSeq != before.CreatedSeq || got.ApproverProjects != nil {
				t.Errorf("the sent-back question lost what it was: %+v, was %+v", got, before)
			}
			if got := state(answered); got.State != core.StatePicked {
				t.Errorf("the answered question is %+v", got)
			}
			if got := state(onOpenTask); got.State != core.StateOpen {
				t.Errorf("the question on the open task is %+v", got)
			}
			var task core.Task
			if err := db.Get(ctx, &task, store.Eq("id", done)); err != nil {
				t.Fatal(err)
			}
			if task.WaitingOnID != "" || task.WaitingOnNote != "" || task.WaitingOutside {
				t.Errorf("the done task still waits: %+v", task)
			}
			if err := db.Get(ctx, &task, store.Eq("id", open)); err != nil || task.WaitingOnID != owner.ID {
				t.Errorf("the open task's waiting changed: %+v (%v)", task, err)
			}
			// The items that asked the settled questions are read; that of the
			// question on the open task is not.
			var items []core.Notification
			if err := db.List(ctx, &items, store.Where(store.Eq("type", core.NoteAsked))); err != nil {
				t.Fatal(err)
			}
			for _, n := range items {
				settled := n.EntityID == stillOpen || n.EntityID == sentBack
				if settled != (n.ReadAt != 0) {
					t.Errorf("the item of question %s reads at %d", n.EntityID, n.ReadAt)
				}
			}
			// The new state is one the table takes.
			do(owner.ID, "decision.close", map[string]any{"id": onOpenTask})
		})
	}
}
