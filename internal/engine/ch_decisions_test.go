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

// TestAnApprovalIsGivenByOneWhoCouldMakeTheChange: an approval for a change
// is answered by the person it was asked of, when it names one, and only
// by someone who could make that change themselves: of the role it needs,
// and, when it is used, reaching what it touches, through the membership
// and the credential they answered with.
func TestAnApprovalIsGivenByOneWhoCouldMakeTheChange(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		me := w.owner.ID
		sva := w.do(me, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
		w.do(me, "project.create", M{"key": "OPS", "name": "Operations"})
		w.do(me, "task.create", M{"project": "SVA", "title": "Boss design"})
		w.do(me, "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		w.do(me, "task.create", M{"project": "OPS", "title": "Renew the certificates"})
		person := func(handle, role string, scope any) string {
			u := core.User{ID: id.New(), Kind: core.KindPerson, Name: handle, Email: handle + "-" + id.New() + "@example.com", CreatedAt: 1, UpdatedAt: 1}
			if err := st.Insert(ctx, u); err != nil {
				t.Fatal(err)
			}
			w.do(me, "member.add", M{"user": u.ID, "handle": handle, "role": role, "scope": scope})
			return u.ID
		}
		mia := person("mia", "member", nil)
		ops := person("ops", "admin", M{"projects": []string{"OPS"}})
		bot := w.do(me, "agent.create", M{"name": "Bot", "handle": "bot", "role": "admin",
			"scope": M{"needs_approval": []string{"webhook.create", "task.delete"}}}).Ref
		hook := M{"name": "out", "url": "https://example.com/hook"}
		ask := func(task, action string, args M, of string) string {
			a := M{"task": task, "kind": "approval", "action": action, "args": args, "question": "May I?"}
			if of != "" {
				a["ask"] = of
			}
			return w.do(bot, "decision.open", a).Ref
		}
		use := func(typ string, args M, approval string) error {
			raw, _ := json.Marshal(args)
			_, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: bot}, engine.Change{ID: id.New(), Type: typ, Args: raw, Approval: approval})
			return err
		}

		// Mia is a member: webhooks are an admin's to add, so not hers to allow.
		d := ask("SVA-1", "webhook.create", hook, "@mia")
		w.refused(engine.CodeForbidden, mia, "decision.pick", M{"id": d, "outcome": "approved"})
		// Asked of Mia, it is hers to answer: the owner may not answer for her.
		w.refused(engine.CodeForbidden, me, "decision.pick", M{"id": d, "outcome": "approved"})

		// One who reaches only OPS approves a change: it may touch OPS alone.
		d = ask("OPS-1", "task.delete", M{"id": "SVA-1"}, "@ops")
		w.do(ops, "decision.pick", M{"id": d, "outcome": "approved"})
		if err := use("task.delete", M{"id": "SVA-1"}, d); err == nil {
			t.Fatal("an approval by someone who reaches only OPS deleted an SVA task")
		}
		d = ask("OPS-1", "task.delete", M{"id": "OPS-1"}, "@ops")
		w.do(ops, "decision.pick", M{"id": d, "outcome": "approved"})
		if err := use("task.delete", M{"id": "OPS-1"}, d); err != nil {
			t.Fatalf("an approval within the approver's reach: %v", err)
		}

		// The owner reaches every project, but answers with a credential
		// limited to SVA: the approval reaches SVA alone.
		d = ask("SVA-1", "task.delete", M{"id": "OPS-2"}, "@aram")
		raw, _ := json.Marshal(M{"id": d, "outcome": "approved"})
		if _, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: me, Projects: []string{sva}}, engine.Change{ID: id.New(), Type: "decision.pick", Args: raw}); err != nil {
			t.Fatal(err)
		}
		if err := use("task.delete", M{"id": "OPS-2"}, d); err == nil || w.task("OPS-2").DeletedAt != 0 {
			t.Fatalf("an approval given with a credential limited to SVA, used to delete an OPS task: %v", err)
		}

		// An answer from before approvals kept what their giver reached says
		// nothing of the credential it came with: it is asked again, not
		// taken to reach every project.
		d = ask("SVA-1", "task.delete", M{"id": "OPS-2"}, "@aram")
		w.do(me, "decision.pick", M{"id": d, "outcome": "approved"})
		if _, err := st.Update(ctx, "decisions", M{"approver_projects": nil}, store.Eq("id", d)); err != nil {
			t.Fatal(err)
		}
		err := use("task.delete", M{"id": "OPS-2"}, d)
		if refusal, ok := errors.AsType[*engine.Error](err); !ok || refusal.Code != engine.CodeNeedsApproval || !strings.Contains(refusal.Message, "ask again") || w.task("OPS-2").DeletedAt != 0 {
			t.Fatalf("an approval answered before it kept its giver's reach, used: %v", err)
		}

		// Asked of nobody in particular, any person who could make it may answer.
		d = ask("SVA-1", "webhook.create", hook, "")
		w.do(me, "decision.pick", M{"id": d, "outcome": "approved"})
		if err := use("webhook.create", hook, d); err != nil {
			t.Fatalf("an approval by the owner: %v", err)
		}
	})
}
