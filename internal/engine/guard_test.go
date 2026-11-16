package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
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

// TestAskedBy checks that work a member gives to an agent runs with that
// member's access, without the agent having to say whom it works for.
func TestAskedBy(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		a, b := w.agent("alpha"), w.agent("beta")
		mia := core.User{ID: id.New(), Kind: core.KindPerson, Name: "Mia", Email: "mia-" + id.New() + "@example.com", CreatedAt: 1, UpdatedAt: 1}
		if err := st.Insert(ctx, mia); err != nil {
			t.Fatal(err)
		}
		w.do(w.owner.ID, "member.add", M{"user": mia.ID, "handle": "mia"})

		// A person gives a task to an agent: it is worked for them.
		w.do(mia.ID, "task.create", M{"project": "SVA", "title": "Draw the boss", "assignee": "@alpha"})
		if got := w.task("SVA-1").AskedBy; got != mia.ID {
			t.Fatalf("asked_by after a person assigned it: %q", got)
		}
		// The agent passes it on: still for the same person.
		w.do(a, "task.update", M{"id": "SVA-1", "assignee": "@beta"})
		if got := w.task("SVA-1").AskedBy; got != mia.ID {
			t.Fatalf("asked_by after an agent passed it on: %q", got)
		}
		w.do(b, "comment.create", M{"task": "SVA-1", "body": "On it."})

		// The person loses access: agents can no longer work on it for them,
		// whatever they do to the task.
		w.do(w.owner.ID, "member.update", M{"id": "@mia", "suspended": true})
		for typ, args := range map[string]M{
			"comment.create": {"task": "SVA-1", "body": "Still here."},
			"task.update":    {"id": "SVA-1", "title": "Draw the big boss"},
			"decision.open":  {"task": "SVA-1", "question": "Which?", "options": []M{{"label": "A"}, {"label": "B"}}},
		} {
			if e := w.refused(engine.CodeForbidden, b, typ, args); !strings.Contains(e.Message, "no longer has access") {
				t.Fatalf("%s for a suspended asker: %v", typ, e)
			}
		}
		if got := w.task("SVA-1").Title; got != "Draw the boss" {
			t.Fatalf("a refused change still changed the task: %q", got)
		}
		// Another person assigns it again: it is worked for them now.
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "assignee": "@alpha"})
		if got := w.task("SVA-1").AskedBy; got != w.owner.ID {
			t.Fatalf("asked_by after it was assigned again: %q", got)
		}
		w.do(a, "comment.create", M{"task": "SVA-1", "body": "Back on it."})
		// A person holding the task works for nobody else.
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "assignee": "@aram"})
		if got := w.task("SVA-1").AskedBy; got != "" {
			t.Fatalf("asked_by on a task a person holds: %q", got)
		}
		// An agent's own task, given by no person, runs with the agent's access.
		w.do(a, "task.create", M{"project": "SVA", "title": "Tidy up", "assignee": "@beta"})
		if got := w.task("SVA-2").AskedBy; got != "" {
			t.Fatalf("asked_by on an agent's own task: %q", got)
		}
		w.do(b, "task.update", M{"id": "SVA-2", "title": "Tidy up the sprites"})
	})
}

// TestBatchSeesItsOwnWrites checks that what a batch remembers of statuses,
// labels and members never hides what an earlier change of the same batch did.
func TestBatchSeesItsOwnWrites(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.agent("alpha")
		ch := func(typ string, args M) engine.Change {
			raw, _ := json.Marshal(args)
			return engine.Change{ID: id.New(), Type: typ, Args: raw}
		}
		polish := id.New()
		batch := []engine.Change{
			ch("task.create", M{"project": "SVA", "title": "One", "assignee": "@alpha"}),
			// A label and a status made here are found by the next changes.
			ch("label.create", M{"project": "SVA", "name": "fresh"}),
			ch("status.create", M{"id": polish, "project": "SVA", "name": "Polish", "category": "started"}),
			ch("task.create", M{"project": "SVA", "title": "Two", "assignee": "@alpha", "labels": []string{"fresh"}, "status": "Polish"}),
			// A renamed status and a renamed member answer to the new name only.
			ch("status.update", M{"id": polish, "name": "Final polish"}),
			ch("member.update", M{"id": "@alpha", "handle": "omega"}),
			ch("task.create", M{"project": "SVA", "title": "Three", "assignee": "@omega", "status": "Final polish"}),
		}
		if _, err := w.e.Batch(context.Background(), w.ws.ID, engine.Actor{UserID: w.owner.ID}, batch, false); err != nil {
			t.Fatal(err)
		}
		two, three := w.task("SVA-2"), w.task("SVA-3")
		if len(two.LabelIDs) != 1 || two.StatusID == "" || two.StatusID != three.StatusID || three.AssigneeID != two.AssigneeID || three.AssigneeID == "" {
			t.Fatalf("tasks made after changes in the same batch: %+v / %+v", two, three)
		}
		// The old names are gone within the batch too.
		for _, bad := range []engine.Change{
			ch("task.create", M{"project": "SVA", "title": "Four", "assignee": "@alpha"}),
			ch("task.create", M{"project": "SVA", "title": "Four", "status": "Polish"}),
		} {
			stale := []engine.Change{ch("task.create", M{"project": "SVA", "title": "Warm up", "assignee": "@omega", "status": "Final polish"}),
				ch("member.update", M{"id": "@omega", "handle": "omega2"}), ch("status.update", M{"id": polish, "name": "Done-ish"}), bad}
			if _, err := w.e.Batch(context.Background(), w.ws.ID, engine.Actor{UserID: w.owner.ID}, stale, false); err == nil {
				t.Fatalf("a batch used a name an earlier change in it had taken away: %s", bad.Args)
			}
		}
	})
}

// TestNewAgentsAskFirst checks the default: a new agent needs approval for
// what cannot be taken back or reaches outside, unless its maker says not.
func TestNewAgentsAskFirst(t *testing.T) {
	for _, typ := range engine.AsksFirst {
		if !slices.Contains(engine.ChangeTypes(), typ) {
			t.Errorf("%s is not a change type", typ)
		}
	}
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		careful := w.do(w.owner.ID, "agent.create", M{"name": "Careful", "handle": "careful", "role": "admin"}).Ref
		trusted := w.do(w.owner.ID, "agent.create", M{"name": "Trusted", "handle": "trusted", "role": "admin", "scope": M{"needs_approval": []string{}}}).Ref
		hook := M{"name": "out", "url": "https://example.com/hook"}
		if e := w.refused(engine.CodeNeedsApproval, careful, "webhook.create", hook); !strings.Contains(e.Message, "needs approval") {
			t.Fatalf("a new agent reached outside without asking: %v", e)
		}
		w.do(careful, "task.create", M{"project": "SVA", "title": "ordinary work needs no approval"})
		w.do(trusted, "webhook.create", hook)
	})
}

// TestBudgets checks the warnings before a limit and the clean stop at it,
// for a task's own budget and for hand-offs.
func TestBudgets(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		a, b := w.agent("alpha"), w.agent("beta")
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Draw the boss", "assignee": "@alpha", "budget": M{"cost_micros": 1_000_000}})
		inbox := func() string {
			var ns []core.Notification
			st.In(w.ws.ID).List(context.Background(), &ns, store.Q{Where: []store.Cond{store.Eq("user_id", w.owner.ID), store.Eq("type", core.NoteBudget)}, Order: "seq"})
			var out []string
			for _, n := range ns {
				out = append(out, n.Title)
			}
			return strings.Join(out, " | ")
		}
		run := w.do(a, "session.start", M{"task": "SVA-1"}).Ref
		w.do(a, "session.update", M{"id": run, "cost_micros": 500_000})
		if got := inbox(); got != "" {
			t.Fatalf("a warning at half the budget: %s", got)
		}
		w.do(a, "session.update", M{"id": run, "cost_micros": 850_000})
		w.do(a, "session.update", M{"id": run, "cost_micros": 900_000})
		if got := inbox(); got != "SVA-1 has used 80% of its budget" {
			t.Fatalf("warnings at 85%% and 90%%: %q", got)
		}
		w.do(a, "session.update", M{"id": run, "cost_micros": 1_200_000, "state": "done"})
		if got := inbox(); !strings.HasSuffix(got, "SVA-1 has used up its budget") {
			t.Fatalf("the budget ran out: %q", got)
		}
		// A clean stop: no new run and no taking it, but it can be said and handed back.
		w.refused(engine.CodeBudget, a, "session.start", M{"task": "SVA-1"})
		w.refused(engine.CodeBudget, b, "task.take", M{"id": "SVA-1"})
		w.do(a, "comment.create", M{"task": "SVA-1", "body": "Out of budget; half done.", "waiting_on": "@aram"})

		// Hand-offs count against an agent's budget.
		w.do(w.owner.ID, "agent.update", M{"id": "@alpha", "budget": M{"handoffs": 2}})
		for i := range 2 {
			w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Pass along", "assignee": "@alpha"})
			w.do(a, "task.update", M{"id": fmt.Sprintf("SVA-%d", i+2), "assignee": "@beta"})
		}
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "One too many", "assignee": "@alpha"})
		if e := w.refused(engine.CodeBudget, a, "task.update", M{"id": "SVA-4", "assignee": "@beta"}); !strings.Contains(e.Message, "hand the task to a person") {
			t.Fatalf("a third hand-off: %v", e)
		}
		w.do(a, "task.update", M{"id": "SVA-4", "assignee": "@aram"})
	})
}
