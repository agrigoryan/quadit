package server_test

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// aRunner is a site where Quadit's runner runs @claude, whose responsible
// person is the owner, @aram, for the project SVA; @bea is another member
// and @codex another agent of the owner's.
type aRunner struct {
	*site
	st       store.Store
	claude   string // its token
	claudeID string
	codex    string // its token
	sva      core.Project
	bea      *http.Client
	beaID    string
	lease    string // the runner's lease, from its last hold
}

// runnerOf is what the runner says of itself on every hold.
const runnerOf = "machine_id=3f9c0a7d5e21b864&machine_name=Aram%27s+MacBook+Pro&folder=~/devel/game&program=claude&program_version=2.1.331&by=Quadit%27s+runner"

func newRunner(t *testing.T, st store.Store) *aRunner {
	t.Helper()
	r := beforeTheRunner(t, st)
	r.hold(t, "")
	return r
}

// beforeTheRunner is newRunner's site before its runner's first hold.
func beforeTheRunner(t *testing.T, st store.Store) *aRunner {
	t.Helper()
	s := newSite(t, st)
	r := &aRunner{site: s, st: st, claude: s.agentToken(t, "claude"), codex: s.agentToken(t, "codex")}
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	if err := st.Get(context.Background(), &r.sva, store.Eq("key", "SVA")); err != nil {
		t.Fatal(err)
	}
	var claude core.Member
	if err := st.Get(context.Background(), &claude, store.Eq("handle", "claude")); err != nil {
		t.Fatal(err)
	}
	r.claudeID = claude.UserID
	r.bea, r.beaID = s.invitedPerson(t)
	return r
}

// heldItem is one item a hold hands out.
type heldItem struct {
	Seq  int64
	Line string
	Item struct {
		ID, Type, By, Task, Decision string
		Seq                          int64
	}
	Wake struct{ Do, Why string }
}

// runnerAnswer is GET /listen's answer to a runner.
type runnerAnswer struct {
	Lease, Project string
	heldItem
	Batch []heldItem
}

// hold is one hold of the runner's, with more parameters (start with &).
func (r *aRunner) hold(t *testing.T, more string) runnerAnswer {
	t.Helper()
	var got runnerAnswer
	q := "/listen?wait=0&project=SVA&" + runnerOf + more
	if r.lease != "" {
		q += "&lease=" + r.lease
	}
	r.call(t, nil, r.claude, "GET", w+q, nil, 200, &got)
	r.lease = got.Lease
	return got
}

// ack acknowledges the runner's items up to seq.
func (r *aRunner) ack(t *testing.T, seq int64) {
	t.Helper()
	r.call(t, nil, r.claude, "PUT", w+"/cursors/listen:"+r.sva.ID, M{"seq": seq, "lease": r.lease}, 200, nil)
}

// next is the runner's next item, acknowledged: its wake as "do why", or
// "" when there is none.
func (r *aRunner) next(t *testing.T) string {
	t.Helper()
	got := r.hold(t, "")
	if got.Item.ID == "" {
		return ""
	}
	r.ack(t, got.Seq)
	return got.Wake.Do + " " + got.Wake.Why
}

// drain acknowledges every item there is.
func (r *aRunner) drain(t *testing.T) {
	t.Helper()
	var me struct{ Seq int64 }
	r.call(t, nil, r.claude, "GET", w+"/me", nil, 200, &me)
	r.hold(t, "")
	r.ack(t, me.Seq)
}

// task makes a task of SVA with the fields given and returns its key.
func (r *aRunner) task(t *testing.T, fields M) string {
	t.Helper()
	args := M{"project": "SVA", "title": "Boss fight"}
	maps.Copy(args, fields)
	return r.change(t, r.owner, "", "task.create", args)["key"].(string)
}

// itemOf writes an inbox item for @claude as the engine would, with the
// fields given, made by the rule given ("" for none): for the kinds of item
// no change makes any more (from before items said whether they were
// addressed) or makes only rarely.
func (r *aRunner) itemOf(t *testing.T, note core.Notification, rule string) {
	t.Helper()
	ctx := context.Background()
	var tk core.Task
	if err := r.st.Get(ctx, &tk, store.Eq("id", note.TaskID)); err != nil {
		t.Fatal(err)
	}
	err := r.st.Write(ctx, r.sva.WorkspaceID, func(tx store.Tx) error {
		note.ID, note.WorkspaceID, note.UserID, note.Seq, note.CreatedAt = id.New(), r.sva.WorkspaceID, r.claudeID, tx.NextSeq(), time.Now().UnixMilli()
		note.Title = tk.Key + " " + tk.Title
		if err := tx.Insert(ctx, note); err != nil {
			return err
		}
		data, _ := json.Marshal(core.EventData{Row: note, Rule: rule})
		return tx.Emit(ctx, core.Event{WorkspaceID: note.WorkspaceID, Seq: note.Seq, At: note.CreatedAt, ActorID: note.ActorID, ChangeID: id.New(),
			Type: "notification.created", EntityType: "notification", EntityID: note.ID, ScopeType: "task", ScopeID: tk.ID, ProjectID: tk.ProjectID,
			AudienceID: r.claudeID, Data: data})
	})
	if err != nil {
		t.Fatal(err)
	}
}

// helper makes an agent as a caller (a browser, or a token) with the
// fields given, gives it a token as that caller, and returns the token.
func (r *aRunner) helper(t *testing.T, hc *http.Client, token, handle string, fields M) string {
	t.Helper()
	args := M{"name": handle, "handle": handle}
	maps.Copy(args, fields)
	r.change(t, hc, token, "agent.create", args)
	var tok struct{ Token string }
	r.call(t, hc, token, "POST", w+"/tokens", M{"user": "@" + handle}, 201, &tok)
	return tok.Token
}

// taskID is the id of a task by key.
func (r *aRunner) taskID(t *testing.T, key string) string {
	t.Helper()
	var tk core.Task
	if err := r.st.Get(context.Background(), &tk, store.Eq("key", key)); err != nil {
		t.Fatal(err)
	}
	return tk.ID
}

// TestTheWakeRule: each row of the rule that says what Quadit's runner does
// with an item, in the order the rule applies them.
func TestTheWakeRule(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		owner := r.ownerID(t)
		wakes := func(t *testing.T, want string) {
			t.Helper()
			if got := r.next(t); got != want {
				t.Errorf("the runner was told %q, want %q", got, want)
			}
			if extra := r.next(t); extra != "" {
				t.Errorf("an item more was handed: %q", extra)
			}
		}
		for _, row := range []struct {
			name string
			make func(t *testing.T)
			want string
		}{
			{"an item taken back", func(t *testing.T) {
				key := r.task(t, nil)
				assign := id.New()
				r.call(t, r.owner, "", "POST", w+"/changes", M{"id": assign, "type": "task.update", "args": M{"id": key, "assignee": "@claude"}}, 200, nil)
				r.call(t, r.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.update", "args": M{"id": key, "assignee": nil}, "undoes": assign}, 200, nil)
			}, "ack gone"},
			{"a rule-made item: a teammate's status change sets off the owner's rule", func(t *testing.T) {
				key := r.task(t, nil)
				rule := r.change(t, r.owner, "", "rule.create", M{"name": "tell claude", "match": M{"event_types": []string{"task.updated"}, "actor_id": r.beaID},
					"action": M{"kind": "notify", "user_id": r.claudeID, "message": "look at this"}})["ref"]
				r.change(t, r.bea, "", "task.update", M{"id": key, "priority": 1})
				var got runnerAnswer
				r.call(t, nil, r.claude, "GET", w+"/listen?wait=10&project=SVA&"+runnerOf+"&lease="+r.lease, nil, 200, &got)
				if got.Item.By != "@aram" || got.Wake.Do+" "+got.Wake.Why != "ack rule" {
					t.Errorf("the rule's item by %s was told %+v", got.Item.By, got.Wake)
				}
				r.ack(t, got.Seq)
				r.change(t, r.owner, "", "rule.update", M{"id": rule, "active": false})
			}, ""},
			{"a page item", func(t *testing.T) {
				page := r.change(t, r.owner, "", "doc.create", M{"title": "Design", "project": "SVA"})["ref"]
				r.change(t, r.owner, "", "comment.create", M{"doc": page, "body": "@claude read this"})
			}, "ack page"},
			{"a trashed task", func(t *testing.T) {
				key := r.task(t, M{"assignee": "@claude"})
				r.change(t, r.owner, "", "task.delete", M{"id": key})
			}, "ack gone"},
			{"the agent's own item", func(t *testing.T) {
				r.itemOf(t, core.Notification{Type: core.NoteMentioned, ActorID: r.claudeID, TaskID: r.taskID(t, r.task(t, nil)), Addressed: true}, "")
			}, "ack own"},
			{"a status", func(t *testing.T) {
				key := r.task(t, nil)
				r.change(t, nil, r.claude, "watch.set", M{"subject": key})
				r.change(t, r.owner, "", "task.update", M{"id": key, "status": "Done"})
			}, "ack status"},
			{"a resource's turn", func(t *testing.T) {
				key := r.task(t, nil)
				r.change(t, r.owner, "", "resource.create", M{"name": "gpu"})
				r.change(t, r.owner, "", "resource.acquire", M{"resource": "gpu"})
				r.change(t, nil, r.claude, "resource.acquire", M{"resource": "gpu", "task": key})
				r.change(t, r.owner, "", "resource.release", M{"resource": "gpu"})
			}, "ack resource"},
			{"a question answered since", func(t *testing.T) {
				key := r.task(t, nil)
				question := r.change(t, r.owner, "", "decision.open", M{"task": key, "question": "Which boss?", "options": []M{{"label": "Big"}, {"label": "Small"}}, "ask": "@claude"})["ref"]
				r.change(t, nil, r.claude, "decision.pick", M{"id": question, "option": 1})
			}, "ack answered"},
			{"an unclear answer answered again since", func(t *testing.T) {
				key := r.task(t, nil)
				question := r.change(t, r.owner, "", "decision.open", M{"task": key, "question": "Which boss?", "options": []M{{"label": "Big"}, {"label": "Small"}}, "ask": "@claude"})["ref"]
				r.change(t, nil, r.claude, "decision.pick", M{"id": question, "option": 1})
				r.drain(t)
				r.change(t, r.owner, "", "decision.unclear", M{"id": question, "note": "how big?"})
				r.change(t, nil, r.claude, "decision.pick", M{"id": question, "option": 2})
			}, "ack answered"},
			{"a question asked of it, closed since as no longer needed", func(t *testing.T) {
				key := r.task(t, nil)
				question := r.change(t, r.owner, "", "decision.open", M{"task": key, "question": "Which boss?", "options": []M{{"label": "Big"}, {"label": "Small"}}, "ask": "@claude"})["ref"]
				r.change(t, r.owner, "", "decision.close", M{"id": question})
			}, "ack answered"},
			{"its own question closed by the owner without a note", func(t *testing.T) {
				key := r.task(t, nil)
				question := r.change(t, nil, r.claude, "decision.open", M{"task": key, "question": "Which arena?", "options": []M{{"label": "Day"}, {"label": "Night"}}})["ref"]
				r.drain(t)
				r.change(t, r.owner, "", "decision.close", M{"id": question})
			}, "ack closed"},
			{"its own question closed by the owner with a note", func(t *testing.T) {
				key := r.task(t, nil)
				question := r.change(t, nil, r.claude, "decision.open", M{"task": key, "question": "Which sky?", "options": []M{{"label": "Day"}, {"label": "Night"}}})["ref"]
				r.drain(t)
				r.change(t, r.owner, "", "decision.close", M{"id": question, "note": "Use the night sky from the mockup."})
			}, "run for_you"},
			{"a follower's comment", func(t *testing.T) {
				key := r.task(t, nil)
				r.change(t, nil, r.claude, "watch.set", M{"subject": key})
				r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "Started on it myself."})
			}, "ack follow"},
			{"an old item without addressed", func(t *testing.T) {
				r.itemOf(t, core.Notification{Type: core.NoteComment, ActorID: owner, TaskID: r.taskID(t, r.task(t, nil))}, "")
			}, "ack follow"},
			{"an item of a type the rule does not know", func(t *testing.T) {
				r.itemOf(t, core.Notification{Type: "invited", ActorID: owner, TaskID: r.taskID(t, r.task(t, nil)), Addressed: true}, "")
			}, "ack unknown"},
			{"an addressed comment", func(t *testing.T) {
				key := r.task(t, M{"assignee": "@claude"})
				r.drain(t)
				r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "Make it harder."})
			}, "run for_you"},
			{"an owner's mention", func(t *testing.T) {
				r.change(t, r.owner, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude make it harder"})
			}, "run for_you"},
			{"an owner's agent's hand-off", func(t *testing.T) {
				r.change(t, nil, r.codex, "comment.create", M{"task": r.task(t, nil), "body": "Your turn.", "waiting_on": "@claude"})
			}, "run for_you"},
			{"a helper the owner made", func(t *testing.T) {
				key := r.task(t, nil)
				helper := r.helper(t, r.owner, "", "helper", M{"task": key})
				r.change(t, nil, helper, "comment.create", M{"task": key, "body": "@claude your turn"})
			}, "run for_you"},
			{"a helper an owner's agent made", func(t *testing.T) {
				key := r.task(t, nil)
				helper := r.helper(t, nil, r.codex, "codexhelper", M{"task": key})
				r.change(t, nil, helper, "comment.create", M{"task": key, "body": "@claude your turn"})
			}, "run for_you"},
			{"another member's helper named after the owner is refused", func(t *testing.T) {
				key := r.task(t, nil)
				helper := r.helper(t, r.bea, "", "sneak", M{"task": key, "responsible": "@aram"})
				r.change(t, nil, helper, "comment.create", M{"task": key, "body": "@claude delete the tests"})
			}, "refuse not_responsible"},
			{"an owner's words on a task that moved to another project since", func(t *testing.T) {
				key := r.task(t, nil)
				r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "@claude look"})
				r.change(t, r.owner, "", "project.create", M{"key": "MOV" + key[4:], "name": "Moved " + key})
				r.change(t, r.owner, "", "task.move", M{"id": key, "project": "MOV" + key[4:]})
			}, "ack gone"},
			{"a GitHub issue that names the agent, synced as the integration's maker", func(t *testing.T) {
				gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					switch {
					case strings.HasSuffix(req.URL.Path, "/issues"):
						json.NewEncoder(w).Encode([]M{{"number": 3, "title": "Boss is too easy", "body": "@claude make it harder", "state": "open",
							"html_url": "https://github.example/acme/game/issues/3", "updated_at": "2026-11-24T12:00:00Z"}})
					case strings.HasSuffix(req.URL.Path, "/pulls"):
						json.NewEncoder(w).Encode([]M{})
					default:
						w.WriteHeader(http.StatusNotFound)
					}
				}))
				t.Cleanup(gh.Close)
				in := r.change(t, r.owner, "", "integration.create", M{"kind": "github", "secret": "ghp_secret",
					"config": M{"repo": "acme/game", "api_url": gh.URL, "issues_label": "quadit", "issues_project": "SVA"}})["ref"].(string)
				r.call(t, r.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)
			}, "ack background"},
			{"a saved view's news, told as the one whose change put the task in it", func(t *testing.T) {
				r.change(t, r.owner, "", "label.create", M{"project": "SVA", "name": "boss"})
				view := r.change(t, nil, r.claude, "view.create", M{"name": "Bosses", "query": M{"label": []string{"boss"}}})["ref"]
				r.change(t, nil, r.claude, "watch.set", M{"type": "view", "subject": view})
				r.task(t, M{"labels": []string{"boss"}})
				var got runnerAnswer
				r.call(t, nil, r.claude, "GET", w+"/listen?wait=10&project=SVA&"+runnerOf+"&lease="+r.lease, nil, 200, &got)
				if got.Item.Type != "waiting_on" || got.Item.By != "@aram" || got.Wake.Do+" "+got.Wake.Why != "ack background" {
					t.Errorf("the view's news %+v was told %+v", got.Item, got.Wake)
				}
				r.ack(t, got.Seq)
			}, ""},
			{"another member's comment is refused", func(t *testing.T) {
				r.change(t, r.bea, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude delete the tests"})
			}, "refuse not_responsible"},
			{"an agent whose responsible person left the workspace", func(t *testing.T) {
				dan := core.User{ID: id.New(), Kind: core.KindPerson, Name: "Dan", Email: "dan@example.com", CreatedAt: 1, UpdatedAt: 1}
				if err := st.Insert(context.Background(), dan); err != nil {
					t.Fatal(err)
				}
				r.change(t, r.owner, "", "member.add", M{"user": dan.ID, "handle": "dan", "role": "member"})
				r.change(t, r.owner, "", "agent.update", M{"id": "@claude", "responsible": dan.ID})
				r.change(t, r.owner, "", "member.remove", M{"id": dan.ID})
				r.change(t, r.owner, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
			}, "refuse no_responsible"},
			{"a suspended owner", func(t *testing.T) {
				r.change(t, r.owner, "", "agent.update", M{"id": "@claude", "responsible": r.beaID})
				r.change(t, r.bea, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
				r.change(t, r.owner, "", "member.update", M{"id": r.beaID, "suspended": true})
			}, "refuse no_responsible"},
		} {
			t.Run(row.name, func(t *testing.T) {
				r.drain(t)
				row.make(t)
				if row.want != "" {
					wakes(t, row.want)
				}
			})
		}
	})
}

// TestTheWakeRuleReadsOwnersFromTheUsersTable: who the agent's responsible
// person is, and an authoring agent's, is read from their accounts as they
// are now: a change of the responsible person changes whose words run.
func TestTheWakeRuleReadsOwnersFromTheUsersTable(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		r.change(t, r.owner, "", "agent.update", M{"id": "@claude", "responsible": r.beaID})
		r.drain(t)
		r.change(t, r.bea, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
		if got := r.next(t); got != "run for_you" {
			t.Errorf("the new responsible person's words: %q", got)
		}
		r.change(t, r.owner, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
		if got := r.next(t); got != "refuse not_responsible" {
			t.Errorf("the old responsible person's words: %q", got)
		}
		// The owner's agent is no longer an agent of the agent's owner.
		r.change(t, nil, r.codex, "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
		if got := r.next(t); got != "refuse not_responsible" {
			t.Errorf("the old responsible person's agent's words: %q", got)
		}
		r.change(t, r.owner, "", "agent.update", M{"id": "@codex", "responsible": r.beaID})
		r.change(t, nil, r.codex, "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
		if got := r.next(t); got != "run for_you" {
			t.Errorf("an agent of the same responsible person's words: %q", got)
		}
	})
}

// TestAFailedReadOfTheOwnerHandsNothingOut: when the wake rule cannot read
// whether the item's author is the agent's responsible person, the hold
// fails as any failed read, hands the item to nobody, and hands it again
// once the read works.
func TestAFailedReadOfTheOwnerHandsNothingOut(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := newFaultyStore(plain)
		r := newRunner(t, st)
		owner := r.ownerID(t)
		r.drain(t)
		r.change(t, r.owner, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
		handed := func() int64 {
			var l core.Listener
			if err := plain.Get(context.Background(), &l, store.Eq("lease", r.lease)); err != nil {
				t.Fatal(err)
			}
			return l.HandedSeq
		}
		before := handed()
		st.faults.arm(fault{op: "get", table: "members", match: func(_ map[string]any, where []store.Cond) bool { return whereHas(where, "user_id", owner) }})
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&"+runnerOf+"&lease="+r.lease, nil, 500, nil)
		if after := handed(); after != before {
			t.Fatalf("the failed hold handed the item at %d", after)
		}
		st.faults.clear()
		if got := r.next(t); got != "run for_you" {
			t.Fatalf("the item, once the read works: %q", got)
		}
	})
}

// TestTheWakeRuleReadsBothOwnersAtOnce: whose agents the agent and the
// author are is read in one go, so an admin swapping their responsible
// persons between two reads cannot make them look like one person's.
func TestTheWakeRuleReadsBothOwnersAtOnce(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := newFaultyStore(plain)
		r := newRunner(t, st)
		r.change(t, r.owner, "", "agent.update", M{"id": "@codex", "responsible": r.beaID})
		r.drain(t)
		r.change(t, nil, r.codex, "comment.create", M{"task": r.task(t, nil), "body": "@claude look"})
		var codex core.Member
		if err := plain.Get(context.Background(), &codex, store.Eq("handle", "codex")); err != nil {
			t.Fatal(err)
		}
		owner := r.ownerID(t)
		// The swap happens as the second of the owners is read: @claude
		// becomes Bea's and @codex Aram's.
		swapped := false
		swap := func(_ map[string]any, where []store.Cond) bool {
			if !swapped && (whereHas(where, "id", codex.UserID) || len(where) > 0 && where[0].Op == "in") {
				swapped = true
				ctx := context.Background()
				for who, to := range map[string]string{r.claudeID: r.beaID, codex.UserID: owner} {
					if _, err := plain.Update(ctx, "users", map[string]any{"responsible_id": to}, store.Eq("id", who)); err != nil {
						t.Error(err)
					}
				}
			}
			return false
		}
		st.faults.arm(fault{op: "get", table: "users", match: swap})
		st.faults.arm(fault{op: "list", table: "users", match: swap})
		if got := r.next(t); got != "refuse not_responsible" {
			t.Fatalf("two agents of two people, before and after the swap, were told %q", got)
		}
	})
}
