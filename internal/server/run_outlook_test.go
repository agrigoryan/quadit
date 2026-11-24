package server_test

import (
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// outlook is one agent's outlook as the page reads it.
type outlook struct {
	Agent, Outcome, Machine, Folder, Program, Project, Owner, Since, Until, Running, Reason string
}

// outlookOf asks, as the caller (a browser, or a token), the outlook of a
// task for the agents named.
func (r *aRunner) outlookOf(t *testing.T, hc *http.Client, token, key, agents, cause string) []outlook {
	t.Helper()
	var out struct{ Outlooks []outlook }
	r.call(t, hc, token, "GET", w+"/tasks/"+key+"/run-outlook?agents="+agents+"&cause="+cause, nil, 200, &out)
	return out.Outlooks
}

// TestTheOutlook: what will happen to a comment or an assignment, in the
// order the outcomes are decided, and only of what the caller may read.
func TestTheOutlook(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		r.change(t, r.owner, "", "project.create", M{"key": "ART", "name": "Art"})
		key := r.task(t, nil)
		art := r.change(t, r.owner, "", "task.create", M{"project": "ART", "title": "Sky"})["key"].(string)
		// one is the owner's outlook of a comment on key for @claude.
		one := func(t *testing.T, key, cause string) outlook {
			t.Helper()
			got := r.outlookOf(t, r.owner, "", key, "@claude", cause)
			if len(got) != 1 {
				t.Fatalf("the outlook is %+v", got)
			}
			return got[0]
		}

		t.Run("an agent with no runner, and an unknown one", func(t *testing.T) {
			got := r.outlookOf(t, r.owner, "", key, "@codex,@nobody,@bea", "comment")
			if len(got) != 1 || got[0].Agent != "@codex" || got[0].Outcome != "none" || got[0].Owner != "@aram" || got[0].Project != "SVA" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("no runner for the task's project", func(t *testing.T) {
			if got := one(t, art, "comment"); got.Outcome != "will_not_start" || got.Reason != "no_runner_here" || got.Project != "ART" || got.Machine != "" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("it would refuse another member's words", func(t *testing.T) {
			got := r.outlookOf(t, r.bea, "", key, "@claude", "comment")
			if len(got) != 1 || got[0].Outcome != "will_not_start" || got[0].Reason != "not_responsible" || got[0].Owner != "@aram" || got[0].Machine != "Aram's MacBook Pro" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("it would acknowledge the agent's own words", func(t *testing.T) {
			if got := r.outlookOf(t, nil, r.claude, key, "@claude", "comment"); len(got) != 1 || got[0].Outcome != "none" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("starts now", func(t *testing.T) {
			if got := one(t, key, "comment"); got.Outcome != "starts_now" || got.Machine != "Aram's MacBook Pro" || got.Folder != "~/devel/game" || got.Program != "claude" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("queued behind items waiting", func(t *testing.T) {
			r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "@claude first this"})
			if got := one(t, key, "comment"); got.Outcome != "queued" || got.Running != "" {
				t.Fatalf("the outlook is %+v", got)
			}
			r.drain(t)
		})
		t.Run("queued behind a run in the folder", func(t *testing.T) {
			other := r.task(t, nil)
			r.hold(t, "")
			r.change(t, nil, r.claude, "session.start", M{"task": other, "state": "waiting", "program": "claude", "machine_id": "3f9c0a7d5e21b864",
				"machine_name": "Aram's MacBook Pro", "folder": "~/devel/game", "lease": r.lease, "item_seq": 1})
			if got := one(t, key, "comment"); got.Outcome != "queued" || got.Running != other {
				t.Fatalf("the outlook is %+v", got)
			}
			if _, err := st.Update(context.Background(), "agent_sessions", map[string]any{"state": core.AgentSessionDone}, store.Eq("task_id", r.taskID(t, other))); err != nil {
				t.Fatal(err)
			}
		})
		t.Run("paused", func(t *testing.T) {
			r.hold(t, "&paused=usage_limit&paused_until="+strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10))
			if got := one(t, key, "comment"); got.Outcome != "paused" || got.Reason != "usage_limit" || got.Until == "" {
				t.Fatalf("the outlook is %+v", got)
			}
			r.hold(t, "&paused=not_signed_in")
			if got := one(t, key, "comment"); got.Outcome != "paused" || got.Reason != "not_signed_in" || got.Until != "" {
				t.Fatalf("the outlook is %+v", got)
			}
			r.hold(t, "")
		})
		t.Run("the current assignee is assigned nothing new", func(t *testing.T) {
			if got := one(t, key, "assign"); got.Outcome != "starts_now" {
				t.Fatalf("assigning it is %+v", got)
			}
			r.change(t, r.owner, "", "task.update", M{"id": key, "assignee": "@claude"})
			r.drain(t)
			if got := one(t, key, "assign"); got.Outcome != "none" {
				t.Fatalf("assigning it again is %+v", got)
			}
		})
		t.Run("in a chat", func(t *testing.T) {
			var chat listened
			r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&take=1", nil, 200, &chat)
			if got := one(t, key, "comment"); got.Outcome != "in_chat" {
				t.Fatalf("the outlook is %+v", got)
			}
			runOut(t, st, chat.Lease)
		})
		t.Run("when its machine is back", func(t *testing.T) {
			if got := one(t, key, "comment"); got.Outcome != "when_back" || got.Since == "" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("no responsible person", func(t *testing.T) {
			r.change(t, r.owner, "", "agent.update", M{"id": "@claude", "responsible": r.beaID})
			r.change(t, r.owner, "", "member.update", M{"id": r.beaID, "suspended": true})
			if got := one(t, key, "comment"); got.Outcome != "will_not_start" || got.Reason != "no_responsible" || got.Owner != "" {
				t.Fatalf("the outlook is %+v", got)
			}
		})
		t.Run("nothing of a project the caller may not read", func(t *testing.T) {
			var tok struct{ Token string }
			r.call(t, r.owner, "", "POST", w+"/tokens", M{"user": "me", "projects": []string{"ART"}}, 201, &tok)
			if got := r.outlookOf(t, nil, tok.Token, art, "@claude", "comment"); len(got) != 1 || got[0].Outcome != "none" {
				t.Fatalf("a login kept to ART is told %+v", got)
			}
			r.call(t, nil, tok.Token, "GET", w+"/tasks/"+key+"/run-outlook?agents=@claude&cause=comment", nil, 404, nil)
		})
		t.Run("asked badly", func(t *testing.T) {
			r.call(t, r.owner, "", "GET", w+"/tasks/"+key+"/run-outlook?agents=@claude&cause=wave", nil, 400, nil)
			many := "@claude"
			for range 20 {
				many += "," + id.New()
			}
			r.call(t, r.owner, "", "GET", w+"/tasks/"+key+"/run-outlook?agents="+many+"&cause=comment", nil, 400, nil)
		})
	})
}
