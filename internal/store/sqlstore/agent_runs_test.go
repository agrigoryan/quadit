package sqlstore_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/sqlstore"
)

// TestUpgradeKeepsSessionsListenersCommentsAndInboxItemsAsTheyWere:
// version 27 only adds what a runner records and whether an item was
// addressed, so the rows of before read as they were, with nothing of a
// runner on them: a session recorded by hand, a listener no runner holds, a
// comment no run posted; and an inbox item is addressed when its type is
// made only for its member (an assignment, version 28), not when a
// follower hears it too (a comment).
func TestUpgradeKeepsSessionsListenersCommentsAndInboxItemsAsTheyWere(t *testing.T) {
	for _, d := range []sqlstore.Dialect{sqlstore.SQLite, sqlstore.Postgres} {
		t.Run(d.Name, func(t *testing.T) {
			ctx := context.Background()
			st := openWritableAt(t, d, 26)
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
			project := do(owner.ID, "project.create", map[string]any{"key": "SVA", "name": "Game"})
			coder := do(owner.ID, "agent.create", map[string]any{"name": "Coder", "handle": "coder"})
			task := do(owner.ID, "task.create", map[string]any{"project": "SVA", "title": "Boss fight"})
			session := do(coder, "session.start", map[string]any{"task": task, "instructions": "Make the boss fight"})
			do(coder, "session.update", map[string]any{"id": session, "state": core.AgentSessionDone, "summary": "The boss fights"})
			do(owner.ID, "task.update", map[string]any{"id": task, "assignee": coder})
			comment := do(coder, "comment.create", map[string]any{"task": task, "body": "Done: the boss fights back"})
			until, heard := time.Now().Add(time.Minute).UnixMilli(), time.Now().UnixMilli()
			if err := st.Exec(ctx, fmt.Sprintf(`INSERT INTO listeners (workspace_id, agent_id, project_id, lease, lease_until, heard_at, held_by, handed_seq)
				VALUES ('%s', '%s', '%s', 'KQ7MX4PA', %d, %d, 'a chat', 7)`, ws.ID, coder, project, until, heard)); err != nil {
				t.Fatal(err)
			}
			db := st.In(ws.ID)
			var sessionBefore core.AgentSession
			var commentBefore core.Comment
			if err := db.Get(ctx, &sessionBefore, store.Eq("id", session)); err != nil {
				t.Fatal(err)
			}
			if err := db.Get(ctx, &commentBefore, store.Eq("id", comment)); err != nil {
				t.Fatal(err)
			}
			var notesBefore []core.Notification
			if err := db.List(ctx, &notesBefore, store.Q{Order: "seq"}); err != nil {
				t.Fatal(err)
			}
			if len(notesBefore) == 0 {
				t.Fatal("the workspace has no inbox items to upgrade")
			}
			// What the engine of now says of them is in a column the database
			// of before has not: after the upgrade it reads true for the
			// types made only for their member (version 28), false for the
			// rest, which a follower hears too.
			byNature := []string{core.NoteAssigned, core.NoteMentioned, core.NoteWaitingOn, core.NoteAsked, core.NotePicked, core.NoteUnclear, core.NoteReplied}
			kinds := map[bool]int{}
			for i, n := range notesBefore {
				notesBefore[i].Addressed = slices.Contains(byNature, n.Type)
				kinds[notesBefore[i].Addressed]++
			}
			if kinds[true] == 0 || kinds[false] == 0 {
				t.Fatalf("the workspace's inbox items are not of both kinds: %+v", notesBefore)
			}

			upgrade(t, st)
			var sessionAfter core.AgentSession
			if err := db.Get(ctx, &sessionAfter, store.Eq("id", session)); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(sessionAfter, sessionBefore) {
				t.Errorf("after the upgrade the session is %+v, want %+v", sessionAfter, sessionBefore)
			}
			var commentAfter core.Comment
			if err := db.Get(ctx, &commentAfter, store.Eq("id", comment)); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(commentAfter, commentBefore) {
				t.Errorf("after the upgrade the comment is %+v, want %+v", commentAfter, commentBefore)
			}
			var notesAfter []core.Notification
			if err := db.List(ctx, &notesAfter, store.Q{Order: "seq"}); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(notesAfter, notesBefore) {
				t.Errorf("after the upgrade the inbox items are %+v, want %+v", notesAfter, notesBefore)
			}
			var listeners []core.Listener
			if err := db.List(ctx, &listeners, store.Q{}); err != nil {
				t.Fatal(err)
			}
			want := core.Listener{WorkspaceID: ws.ID, AgentID: coder, ProjectID: project, Lease: "KQ7MX4PA", LeaseUntil: until, HeardAt: heard, HeldBy: "a chat", HandedSeq: 7}
			if len(listeners) != 1 || listeners[0] != want {
				t.Errorf("after the upgrade the listeners are %+v, want only %+v", listeners, want)
			}
		})
	}
}
