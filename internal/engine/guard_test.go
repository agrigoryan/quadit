package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestGuardRails(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		boss := w.do(w.owner.ID, "agent.create", M{"name": "Boss", "handle": "boss", "role": "admin"}).Ref
		a, b := w.agent("alpha"), w.agent("beta")
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Hot potato"})

		// A shared admin agent asked by a plain member cannot do for them
		// what they could not do themselves.
		raw, _ := json.Marshal(M{"key": "NEW", "name": "New project"})
		_, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: boss}, engine.Change{ID: id.New(), Type: "project.create", Args: raw, For: "@alpha"})
		var ee *engine.Error
		if !errors.As(err, &ee) || ee.Code != engine.CodeForbidden || !strings.Contains(ee.Message, "@alpha") {
			t.Fatalf("on behalf of a member: %v", err)
		}
		if _, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: boss}, engine.Change{ID: id.New(), Type: "project.create", Args: raw, For: "@aram"}); err != nil {
			t.Fatalf("on behalf of the owner: %v", err)
		}

		// Agents cannot pass a task between themselves for ever.
		holder := a
		var last error
		for i := 0; i < 8 && last == nil; i++ {
			next := "@beta"
			if holder == b {
				next = "@alpha"
			}
			_, last = w.try(holder, "task.update", M{"id": "SVA-1", "assignee": next})
			if holder == a {
				holder = b
			} else {
				holder = a
			}
		}
		if !errors.As(last, &ee) || ee.Code != engine.CodeConflict || !strings.Contains(ee.Message, "hand it to a person") {
			t.Fatalf("hand-offs were never stopped: %v", last)
		}
		// A person steps in and the count starts over.
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "assignee": "@alpha"})
		w.do(a, "task.update", M{"id": "SVA-1", "assignee": "@beta"})

		// A task's own budget stops new runs on it.
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "budget": M{"cost_micros": 1_000_000}})
		run := w.do(b, "session.start", M{"task": "SVA-1", "title": "first run"})
		w.do(b, "session.update", M{"id": run.Ref, "cost_micros": 1_200_000, "state": "done", "add_steps": []M{{"did": "drew the sprite"}}})
		w.refused(engine.CodeBudget, b, "session.start", M{"task": "SVA-1"})

		// Watching an epic is watching its tasks.
		epic := w.do(w.owner.ID, "epic.create", M{"project": "SVA", "name": "Boss fight"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "In the epic", "epic": "Boss fight"})
		w.do(a, "watch.set", M{"type": "epic", "subject": epic.Ref})
		before := len(w.inbox(a))
		w.do(w.owner.ID, "comment.create", M{"task": "SVA-2", "body": "news in the epic"})
		if in := w.inbox(a); len(in) != before+1 || in[len(in)-1].Type != core.NoteComment {
			t.Fatalf("the epic's watcher was not told: %+v", in)
		}
	})
}
