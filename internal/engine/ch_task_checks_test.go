package engine_test

import (
	"context"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAMemberWhoCannotReadAProjectIsGivenNoWorkInIt: a task of a project a
// member may not read cannot be given to them, wait on them or ask them a
// question, whoever writes it; and they are not told of it when it
// mentions them. In a project they may read, the same is allowed.
func TestAMemberWhoCannotReadAProjectIsGivenNoWorkInIt(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		narrow := w.do(w.owner.ID, "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}}).Ref
		w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Rotate keys"})

		for _, refused := range []struct {
			field, typ string
			args       M
		}{
			{"assignee", "task.create", M{"project": "OPS", "title": "Patch the kernel", "assignee": "@narrow"}},
			{"waiting_on", "task.create", M{"project": "OPS", "title": "Patch the kernel", "waiting_on": "@narrow"}},
			{"assignee", "task.update", M{"id": "OPS-1", "assignee": "@narrow"}},
			{"waiting_on", "task.update", M{"id": "OPS-1", "waiting_on": "@narrow"}},
			{"waiting_on", "comment.create", M{"task": "OPS-1", "body": "Your turn.", "waiting_on": "@narrow"}},
			{"ask", "decision.open", M{"task": "OPS-1", "question": "Which vault?", "options": []M{{"label": "Ours"}, {"label": "Theirs"}}, "ask": "@narrow"}},
		} {
			if e := w.refused(engine.CodeInvalid, w.owner.ID, refused.typ, refused.args); e.Field != refused.field {
				t.Errorf("%s is refused for %q, want %q: %v", refused.typ, e.Field, refused.field, e)
			}
		}
		w.do(w.owner.ID, "comment.create", M{"task": "OPS-1", "body": "@narrow knows the vault."})
		if inbox := w.inbox(narrow); len(inbox) != 0 {
			t.Fatalf("a member is told of a task of a project they may not read: %+v", inbox)
		}
		if t1 := w.task("OPS-1"); t1.AssigneeID != "" || t1.WaitingOnID != "" {
			t.Fatalf("OPS-1 was given to the member after all: %+v", t1)
		}

		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design", "assignee": "@narrow", "waiting_on": "@narrow"})
		w.do(w.owner.ID, "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "options": []M{{"label": "Ring"}, {"label": "Burst"}}, "ask": "@narrow"})
		w.do(w.owner.ID, "comment.create", M{"task": "SVA-1", "body": "@narrow over to you.", "waiting_on": "@narrow"})
		if inbox := w.inbox(narrow); len(inbox) == 0 {
			t.Fatal("a member is not told of work in a project they may read")
		}
	})
}

// TestATaskIsNotMovedAwayFromWhoseWorkItIs: a task cannot be moved to a
// project that the member it is given to, waits on or asks cannot read;
// the refusal names them. Once they are taken off it, it moves.
func TestATaskIsNotMovedAwayFromWhoseWorkItIs(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		w.do(w.owner.ID, "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}})
		w.do(w.owner.ID, "agent.create", M{"name": "Asked", "handle": "asked", "scope": M{"projects": []string{"SVA"}}})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design", "assignee": "@narrow", "waiting_on": "@narrow"})
		decision := w.do(w.owner.ID, "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "options": []M{{"label": "Ring"}, {"label": "Burst"}}, "ask": "@asked"}).Ref

		e := w.refused(engine.CodeInvalid, w.owner.ID, "task.move", M{"id": "SVA-1", "project": "OPS"})
		if e.Field != "project" || !strings.Contains(e.Message, "@narrow") || !strings.Contains(e.Message, "@asked") {
			t.Fatalf("the refusal does not name who cannot read the project: %v", e)
		}
		if got := w.task("SVA-1"); got.Key != "SVA-1" {
			t.Fatalf("the task moved after all: %s", got.Key)
		}

		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "assignee": nil, "waiting_on": nil})
		w.refused(engine.CodeInvalid, w.owner.ID, "task.move", M{"id": "SVA-1", "project": "OPS"})
		w.do(w.owner.ID, "decision.delete", M{"id": decision})
		w.do(w.owner.ID, "task.move", M{"id": "SVA-1", "project": "OPS"})
	})
}

// TestAnAgentsQuestionGoesToItsPersonOnlyWhereTheyMayRead: an agent that
// asks nobody by name asks the person responsible for it, by the same rule
// as naming them: a task of a project that person cannot read is refused,
// saying so.
func TestAnAgentsQuestionGoesToItsPersonOnlyWhereTheyMayRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		mia := core.User{ID: id.New(), Kind: core.KindPerson, Name: "Mia", Email: "mia-" + id.New() + "@example.com", CreatedAt: 1, UpdatedAt: 1}
		if err := st.Insert(context.Background(), mia); err != nil {
			t.Fatal(err)
		}
		w.do(w.owner.ID, "member.add", M{"user": mia.ID, "handle": "mia", "scope": M{"projects": []string{"SVA"}}})
		helper := w.do(w.owner.ID, "agent.create", M{"name": "Helper", "handle": "helper", "responsible": "@mia"}).Ref
		w.do(helper, "task.create", M{"project": "OPS", "title": "Rotate keys"})
		w.do(helper, "task.create", M{"project": "SVA", "title": "Boss design"})
		question := func(task string) M {
			return M{"task": task, "question": "Which one?", "options": []M{{"label": "This"}, {"label": "That"}}}
		}

		e := w.refused(engine.CodeInvalid, helper, "decision.open", question("OPS-1"))
		if e.Field != "ask" || !strings.Contains(e.Message, "@mia") {
			t.Fatalf("the refusal does not say who cannot read the project: %v", e)
		}
		w.do(helper, "decision.open", question("SVA-1"))
		if got := w.task("SVA-1").WaitingOnID; got != mia.ID {
			t.Fatalf("SVA-1 waits on %q, want the responsible person", got)
		}
	})
}
