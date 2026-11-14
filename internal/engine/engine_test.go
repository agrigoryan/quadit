package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// world is a workspace with an owner, for tests.
type world struct {
	t     *testing.T
	e     *engine.Engine
	st    store.Store
	ws    core.Workspace
	owner core.User
}

var slugN int

func newWorld(t *testing.T, st store.Store) *world {
	t.Helper()
	e := engine.New(st)
	slugN++
	ws, owner, err := e.Bootstrap(context.Background(), engine.BootstrapArgs{
		OwnerName: "Aram", OwnerEmail: fmt.Sprintf("aram%d@example.com", slugN), OwnerHandle: "aram",
		WorkspaceSlug: fmt.Sprintf("games-%d", slugN), WorkspaceName: "Games"})
	if err != nil {
		t.Fatal(err)
	}
	return &world{t: t, e: e, st: st, ws: ws, owner: owner}
}

// do applies one change as userID and fails the test if it is refused.
func (w *world) do(userID, typ string, args any) *engine.Result {
	w.t.Helper()
	res, err := w.try(userID, typ, args)
	if err != nil {
		w.t.Fatalf("%s: %v", typ, err)
	}
	return res
}

func (w *world) try(userID, typ string, args any) (*engine.Result, error) {
	raw, _ := json.Marshal(args)
	return w.e.Apply(context.Background(), w.ws.ID, engine.Actor{UserID: userID}, engine.Change{ID: id.New(), Type: typ, Args: raw})
}

// refused checks that a change is refused with the given code.
func (w *world) refused(code, userID, typ string, args any) *engine.Error {
	w.t.Helper()
	_, err := w.try(userID, typ, args)
	var ee *engine.Error
	if !errors.As(err, &ee) {
		w.t.Fatalf("%s: want refusal %q, got %v", typ, code, err)
	}
	if ee.Code != code {
		w.t.Fatalf("%s: want refusal %q, got %v", typ, code, ee)
	}
	return ee
}

func (w *world) db() store.DB { return w.st.In(w.ws.ID) }

func (w *world) task(ref string) core.Task {
	w.t.Helper()
	var t core.Task
	cond := store.Eq("key", ref)
	if len(ref) == 36 {
		cond = store.Eq("id", ref)
	}
	if err := w.db().Get(context.Background(), &t, cond); err != nil {
		w.t.Fatalf("task %s: %v", ref, err)
	}
	return t
}

func (w *world) inbox(userID string) []core.Notification {
	w.t.Helper()
	var ns []core.Notification
	if err := w.db().List(context.Background(), &ns, store.Q{Where: []store.Cond{store.Eq("user_id", userID)}, Order: "seq"}); err != nil {
		w.t.Fatal(err)
	}
	return ns
}

type M = map[string]any

// agent makes an agent and returns its user id.
func (w *world) agent(handle string) string {
	w.t.Helper()
	return w.do(w.owner.ID, "agent.create", M{"name": strings.ToUpper(handle[:1]) + handle[1:], "handle": handle}).Ref
}

// TestReviewLoop is the loop the product exists for: an agent asks, the
// owner comments on an option and picks with changes, and the task moves
// between them by itself, with nothing missed.
func TestReviewLoop(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		artist := w.agent("artist")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "label.create", M{"name": "art", "project": "SVA"})

		created := w.do(w.owner.ID, "task.create", M{"project": "sva", "title": "Explosion effect", "assignee": "@artist", "labels": []string{"art"}})
		if created.Key != "SVA-1" {
			t.Fatalf("key = %q", created.Key)
		}
		if n := w.inbox(artist); len(n) != 1 || n[0].Type != core.NoteAssigned {
			t.Fatalf("artist inbox after assign = %+v", n)
		}

		// The agent takes the task and asks; nobody named, so its
		// responsible person is asked.
		w.do(artist, "task.take", M{"id": "SVA-1"})
		if got := w.task("SVA-1"); got.LeaseHolderID != artist || got.StartedAt == 0 {
			t.Fatalf("take did not lease and start: %+v", got)
		}
		opened := w.do(artist, "decision.open", M{"task": "SVA-1", "question": "Which explosion?", "recommended": 2,
			"recommendation": "B reads best at small size",
			"options":        []M{{"label": "A: ring"}, {"label": "B: burst"}, {"label": "C: smoke"}}})
		task := w.task("SVA-1")
		if task.WaitingOnID != w.owner.ID {
			t.Fatalf("task should wait on the owner, waits on %q", task.WaitingOnID)
		}
		var d core.Decision
		if err := w.db().Get(ctx, &d, store.Eq("id", opened.Ref)); err != nil {
			t.Fatal(err)
		}
		var opts []core.Option
		if err := w.db().List(ctx, &opts, store.Q{Where: []store.Cond{store.Eq("decision_id", d.ID)}, Order: "rank"}); err != nil {
			t.Fatal(err)
		}
		if len(opts) != 3 || d.RecommendedOptionID != opts[1].ID || d.AskedID != w.owner.ID {
			t.Fatalf("decision = %+v, options = %+v", d, opts)
		}
		if n := w.inbox(w.owner.ID); len(n) != 1 || n[0].Type != core.NoteAsked {
			t.Fatalf("owner inbox = %+v", n)
		}

		// The asker cannot answer its own question.
		w.refused(engine.CodeForbidden, artist, "decision.pick", M{"id": d.ID, "option": 2})

		// The owner comments on one option; the agent is told, and the
		// comment counts as activity on the task.
		seqBefore := w.task("SVA-1").ActivitySeq
		w.do(w.owner.ID, "comment.create", M{"option": opts[0].ID, "body": "No rings as the main shape."})
		if got := w.task("SVA-1").ActivitySeq; got <= seqBefore {
			t.Fatalf("comment did not move activity_seq: %d -> %d", seqBefore, got)
		}
		inbox := w.inbox(artist)
		if last := inbox[len(inbox)-1]; last.Type != core.NoteComment {
			t.Fatalf("artist was not told of the comment: %+v", inbox)
		}

		// "With changes" needs a note; picking by label works.
		w.refused(engine.CodeInvalid, w.owner.ID, "decision.pick", M{"id": d.ID, "option": 2, "outcome": "with_changes"})
		w.do(w.owner.ID, "decision.pick", M{"id": d.ID, "option": "b: burst", "note": "Make it 20% larger."})
		task = w.task("SVA-1")
		if task.WaitingOnID != artist {
			t.Fatalf("after the pick the task should wait on the agent, waits on %q", task.WaitingOnID)
		}
		inbox = w.inbox(artist)
		if last := inbox[len(inbox)-1]; last.Type != core.NotePicked || !strings.Contains(last.Snippet, "20% larger") {
			t.Fatalf("artist was not told of the pick: %+v", last)
		}
		// The first answer stands.
		w.refused(engine.CodeConflict, w.owner.ID, "decision.pick", M{"id": d.ID, "option": 1})

		// The agent posts its result with evidence; the task goes back.
		w.do(artist, "comment.create", M{"task": "SVA-1", "body": "Burst is 20% larger.",
			"evidence": M{"checked": "in game at 1x and 2x", "not_verified": "on a phone"}})
		if got := w.task("SVA-1"); got.WaitingOnID != w.owner.ID {
			t.Fatalf("after the result the task should wait on the owner, waits on %q", got.WaitingOnID)
		}

		// "What is new on my tasks since X" sees all of it in one query.
		evs, err := w.db().Events(ctx, store.EventFilter{After: created.Seq, Viewer: artist,
			Tasks: &store.TaskFilter{AssigneeIDs: []string{artist}}})
		if err != nil {
			t.Fatal(err)
		}
		var types []string
		for _, ev := range evs {
			types = append(types, ev.Type)
		}
		got := strings.Join(types, " ")
		for _, want := range []string{"decision.opened", "comment.created", "decision.picked"} {
			if !strings.Contains(got, want) {
				t.Errorf("feed misses %s: %s", want, got)
			}
		}
		// The owner's private inbox events are not in the agent's feed.
		for _, ev := range evs {
			if ev.AudienceID != "" && ev.AudienceID != artist {
				t.Errorf("agent saw an event addressed to someone else: %+v", ev)
			}
		}

		// Search finds the task, the decision and the comment.
		hits, err := w.db().Search(ctx, store.SearchQuery{Text: "explos", Viewer: artist})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) < 2 {
			t.Fatalf("search hits = %+v", hits)
		}
	})
}

func TestTaskUpdate(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		res := w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Jump"})
		base := res.Seq

		// Names instead of ids; a wrong name lists the right ones.
		upd := w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "status": "in progress", "priority": 2})
		if len(upd.Events) != 1 {
			t.Fatalf("events = %d", len(upd.Events))
		}
		e := w.refused(engine.CodeInvalid, w.owner.ID, "task.update", M{"id": "SVA-1", "status": "Dne"})
		if e.Nearest != "Done" || len(e.Allowed) != 6 {
			t.Fatalf("refusal should suggest Done: %+v", e)
		}
		e = w.refused(engine.CodeInvalid, w.owner.ID, "task.update", M{"id": "SVA-1", "titel": "x"})
		if e.Nearest != "title" {
			t.Fatalf("misspelt field should suggest title: %+v", e)
		}
		// An update on an old version is refused and says what changed.
		e = w.refused(engine.CodeStale, w.owner.ID, "task.update", M{"id": "SVA-1", "base_seq": base, "title": "Double jump"})
		sort.Strings(e.Allowed)
		if !strings.Contains(strings.Join(e.Allowed, ","), "priority") {
			t.Fatalf("stale refusal should list changed fields: %+v", e)
		}
		// Nothing to change: no event.
		if same := w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "priority": 2}); len(same.Events) != 0 {
			t.Fatalf("no-op update emitted %d events", len(same.Events))
		}
		// Done stamps the time and clears who it waits on.
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "waiting_on": "me"})
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "status": "done"})
		if got := w.task("SVA-1"); got.CompletedAt == 0 || got.WaitingOnID != "" {
			t.Fatalf("done task = %+v", got)
		}
		// Trash and restore.
		w.do(w.owner.ID, "task.delete", M{"id": "SVA-1"})
		w.refused(engine.CodeConflict, w.owner.ID, "task.update", M{"id": "SVA-1", "title": "x"})
		w.do(w.owner.ID, "task.restore", M{"id": "SVA-1"})
		if got := w.task("SVA-1"); got.DeletedAt != 0 {
			t.Fatal("restore left the task in the trash")
		}
		// Sub-tasks cannot loop.
		w.do(w.owner.ID, "task.create", M{"parent": "SVA-1", "title": "Child"})
		w.refused(engine.CodeInvalid, w.owner.ID, "task.update", M{"id": "SVA-1", "parent": "SVA-2"})
	})
}

func TestBatchDryRunAndResend(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		actor := engine.Actor{UserID: w.owner.ID}
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		mk := func(typ string, args any) engine.Change {
			raw, _ := json.Marshal(args)
			return engine.Change{ID: id.New(), Type: typ, Args: raw}
		}
		// A batch is all or nothing.
		batch := []engine.Change{mk("task.create", M{"project": "SVA", "title": "One"}), mk("task.create", M{"project": "NOPE", "title": "Two"})}
		_, err := w.e.Batch(ctx, w.ws.ID, actor, batch, false)
		var ee *engine.Error
		if !errors.As(err, &ee) || ee.Index != 1 || ee.Code != engine.CodeNotFound || ee.Nearest != "" && ee.Nearest != "SVA" {
			t.Fatalf("batch refusal = %v", err)
		}
		if n, _ := w.db().CountTasks(ctx, store.TaskFilter{}); n != 0 {
			t.Fatalf("failed batch left %d tasks", n)
		}
		// A dry run reports and keeps nothing.
		res, err := w.e.Batch(ctx, w.ws.ID, actor, batch[:1], true)
		if err != nil || len(res[0].Events) == 0 {
			t.Fatalf("dry run = %+v, %v", res, err)
		}
		if n, _ := w.db().CountTasks(ctx, store.TaskFilter{}); n != 0 {
			t.Fatalf("dry run left %d tasks", n)
		}
		// Sending a change twice applies it once.
		first, err := w.e.Apply(ctx, w.ws.ID, actor, batch[0])
		if err != nil {
			t.Fatal(err)
		}
		again, err := w.e.Apply(ctx, w.ws.ID, actor, batch[0])
		if err != nil || !again.Duplicate || again.Seq != first.Seq {
			t.Fatalf("resend = %+v, %v", again, err)
		}
		if n, _ := w.db().CountTasks(ctx, store.TaskFilter{}); n != 1 {
			t.Fatalf("resend made %d tasks", n)
		}
		// The same id for a different change is refused.
		other := batch[0]
		other.Args, _ = json.Marshal(M{"project": "SVA", "title": "Different"})
		if _, err := w.e.Apply(ctx, w.ws.ID, actor, other); !errors.As(err, &ee) || ee.Code != engine.CodeConflict {
			t.Fatalf("reused id = %v", err)
		}
	})
}

func TestRolesScopesAndWalls(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		coder := w.agent("coder")

		// A member cannot manage; an agent cannot be an owner.
		w.refused(engine.CodeForbidden, coder, "project.create", M{"key": "X1", "name": "x"})
		w.refused(engine.CodeInvalid, w.owner.ID, "agent.create", M{"name": "Boss", "handle": "boss", "role": "owner"})

		// An admin agent can make agents, which answer to the same person.
		lead := w.do(w.owner.ID, "agent.create", M{"name": "Lead", "handle": "lead", "role": "admin"}).Ref
		sub := w.do(lead, "agent.create", M{"name": "Sub", "handle": "sub"}).Ref
		var u core.User
		if err := st.Get(ctx, &u, store.Eq("id", sub)); err != nil || u.ResponsibleID != w.owner.ID {
			t.Fatalf("sub-agent responsible = %q, %v", u.ResponsibleID, err)
		}

		// A scope narrows an agent to its projects.
		w.do(w.owner.ID, "agent.update", M{"id": "@coder", "scope": M{"projects": []string{"SVA"}}})
		w.do(coder, "task.create", M{"project": "SVA", "title": "ok"})
		w.refused(engine.CodeForbidden, coder, "task.create", M{"project": "OPS", "title": "no"})

		// A change that needs approval is refused until one is given.
		w.do(w.owner.ID, "agent.update", M{"id": "@coder", "scope": M{"projects": []string{"SVA"}, "needs_approval": []string{"task.delete"}}})
		w.refused(engine.CodeNeedsApproval, coder, "task.delete", M{"id": "SVA-1"})
		ask := w.do(coder, "decision.open", M{"task": "SVA-1", "kind": "approval", "action": "task.delete", "question": "Delete the duplicate?"})
		raw, _ := json.Marshal(M{"id": "SVA-1"})
		del := engine.Change{ID: id.New(), Type: "task.delete", Args: raw, Approval: ask.Ref}
		if _, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: coder}, del); err == nil {
			t.Fatal("unanswered approval was accepted")
		}
		w.do(w.owner.ID, "decision.pick", M{"id": ask.Ref, "outcome": "approved"})
		if _, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: coder}, del); err != nil {
			t.Fatalf("approved delete refused: %v", err)
		}

		// A read-only credential cannot write.
		raw, _ = json.Marshal(M{"project": "SVA", "title": "x"})
		_, err := w.e.Apply(ctx, w.ws.ID, engine.Actor{UserID: w.owner.ID, ReadOnly: true}, engine.Change{ID: id.New(), Type: "task.create", Args: raw})
		var ee *engine.Error
		if !errors.As(err, &ee) || ee.Code != engine.CodeForbidden {
			t.Fatalf("read-only write = %v", err)
		}

		// Another workspace is a wall: its rows do not exist from here.
		other := newWorld(t, st)
		other.do(other.owner.ID, "project.create", M{"key": "SVA", "name": "Theirs"})
		theirs := other.do(other.owner.ID, "task.create", M{"project": "SVA", "title": "Secret"})
		w.refused(engine.CodeNotFound, w.owner.ID, "task.update", M{"id": theirs.Ref, "title": "mine now"})
		w.refused(engine.CodeForbidden, other.owner.ID, "task.create", M{"project": "SVA", "title": "intruder"})

		// The last owner cannot leave; a removed member loses the room.
		w.refused(engine.CodeConflict, w.owner.ID, "member.remove", M{"id": "@aram"})
		w.do(w.owner.ID, "member.remove", M{"id": "@sub"})
		w.refused(engine.CodeForbidden, sub, "task.create", M{"project": "SVA", "title": "ghost"})
	})
}

func TestConcurrentWrites(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		start, _ := w.db().Events(ctx, store.EventFilter{Limit: 2000})
		const n = 40
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				if _, err := w.try(w.owner.ID, "task.create", M{"project": "SVA", "title": fmt.Sprintf("Task %d", i)}); err != nil {
					errs <- err
				}
			}(i)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
		tasks, err := w.db().Tasks(ctx, store.TaskFilter{Sort: "key", Limit: 500})
		if err != nil {
			t.Fatal(err)
		}
		if len(tasks) != n {
			t.Fatalf("tasks = %d", len(tasks))
		}
		for i, tk := range tasks {
			if tk.Number != i+1 {
				t.Fatalf("task numbers have a gap or repeat at %d: %d", i, tk.Number)
			}
		}
		evs, _ := w.db().Events(ctx, store.EventFilter{Limit: 2000})
		for i, ev := range evs {
			if ev.Seq != int64(i+1) {
				t.Fatalf("event numbers have a gap at %d: %d", i, ev.Seq)
			}
		}
		if len(evs)-len(start) != n {
			t.Fatalf("events = %d", len(evs)-len(start))
		}
	})
}

func TestPlanning(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien", "settings": M{"cycles": true, "cycle_days": 7}})
		epic := w.do(w.owner.ID, "epic.create", M{"project": "SVA", "name": "Boss fight", "target_on": "2027-01-15"})
		ms := w.do(w.owner.ID, "milestone.create", M{"epic": epic.Ref, "name": "Art"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss sprite", "epic": "boss fight", "milestone": ms.Ref, "estimate": 3})
		if got := w.task("SVA-1"); got.EpicID != epic.Ref || got.MilestoneID != ms.Ref || got.Estimate != 3 {
			t.Fatalf("task = %+v", got)
		}
		// Cycles are made as needed, and a task goes in "current".
		if err := w.e.RollCycles(ctx); err != nil {
			t.Fatal(err)
		}
		var cycles []core.Cycle
		if err := w.db().List(ctx, &cycles, store.Q{Where: []store.Cond{store.Live}, Order: "starts_on"}); err != nil || len(cycles) < 2 {
			t.Fatalf("cycles = %+v, %v", cycles, err)
		}
		w.do(w.owner.ID, "task.update", M{"id": "SVA-1", "cycle": "current"})
		if got := w.task("SVA-1"); got.CycleID != cycles[0].ID {
			t.Fatalf("cycle = %q, want %q", got.CycleID, cycles[0].ID)
		}
		// Overlapping cycles are refused.
		w.refused(engine.CodeConflict, w.owner.ID, "cycle.create", M{"project": "SVA", "starts_on": cycles[0].StartsOn, "ends_on": cycles[0].EndsOn})

		// A template fills a new task and opens its decision.
		w.do(w.owner.ID, "template.create", M{"name": "Review", "project": "SVA", "title": "Review: ",
			"preset": M{"priority": 2, "decision": M{"question": "Which one?", "options": []M{{"label": "A"}, {"label": "B"}}, "ask": "@aram"}}})
		reviewer := w.agent("reviewer")
		made := w.do(reviewer, "task.create", M{"project": "SVA", "title": "hit flash", "template": "review"})
		got := w.task(made.Ref)
		if got.Title != "Review: hit flash" || got.Priority != 2 || got.WaitingOnID != w.owner.ID {
			t.Fatalf("templated task = %+v", got)
		}
		// A saved view gets a slug agents can query by.
		v := w.do(w.owner.ID, "view.create", M{"name": "Waiting on me", "query": M{"waiting_on": "me"}})
		if v.Key != "waiting-on-me" {
			t.Fatalf("view slug = %q", v.Key)
		}
		// Deleting the epic leaves its tasks, without an epic.
		w.do(w.owner.ID, "epic.delete", M{"id": epic.Ref})
		if got := w.task("SVA-1"); got.EpicID != "" || got.MilestoneID != "" {
			t.Fatalf("task kept a deleted epic: %+v", got)
		}
		// A status with tasks can only go if they have somewhere to go.
		var sts []core.Status
		w.db().List(ctx, &sts, store.Where(store.Eq("name", "Todo")))
		w.refused(engine.CodeInvalid, w.owner.ID, "status.delete", M{"id": sts[0].ID})
		w.do(w.owner.ID, "status.delete", M{"id": sts[0].ID, "move_to": "Backlog"})
	})
}

func TestLeasesResourcesAndInbox(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		a, b := w.agent("alpha"), w.agent("beta")
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Build"})
		// Two agents cannot take one task.
		w.do(a, "task.take", M{"id": "SVA-1"})
		e := w.refused(engine.CodeConflict, b, "task.take", M{"id": "SVA-1"})
		if !strings.Contains(e.Message, "@alpha") {
			t.Fatalf("refusal should name the holder: %v", e)
		}
		w.do(a, "task.release", M{"id": "SVA-1"})
		w.do(b, "task.take", M{"id": "SVA-1"})

		// A shared machine has a queue.
		w.do(w.owner.ID, "resource.create", M{"name": "minipc"})
		if r := w.do(a, "resource.acquire", M{"resource": "minipc"}); r.Key != "holding" {
			t.Fatalf("first claim = %q", r.Key)
		}
		if r := w.do(b, "resource.acquire", M{"resource": "minipc"}); r.Key != "waiting" {
			t.Fatalf("second claim = %q", r.Key)
		}
		w.do(a, "resource.release", M{"resource": "minipc"})
		var claims []core.ResourceClaim
		w.db().List(context.Background(), &claims, store.Where(store.Eq("user_id", b), store.Eq("state", "holding")))
		if len(claims) != 1 {
			t.Fatal("the queue did not move to beta")
		}

		// Mentions reach the inbox once, and can be marked read.
		w.do(w.owner.ID, "comment.create", M{"task": "SVA-1", "body": "@alpha can you look? cc @alpha"})
		in := w.inbox(a)
		last := in[len(in)-1]
		if last.Type != core.NoteMentioned || last.ReadAt != 0 {
			t.Fatalf("alpha inbox = %+v", in)
		}
		w.do(a, "notification.read", M{"all": true})
		for _, n := range w.inbox(a) {
			if n.ReadAt == 0 {
				t.Fatalf("still unread: %+v", n)
			}
		}
	})
}
