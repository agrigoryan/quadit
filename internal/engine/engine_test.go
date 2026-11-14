package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// world is one fresh workspace with an owner, for one test.
type world struct {
	t     *testing.T
	e     *engine.Engine
	st    store.Store
	ws    core.Workspace
	owner core.User
}

func newWorld(t *testing.T, st store.Store) *world {
	t.Helper()
	e := engine.New(st)
	tag := id.New()[24:] // unique per test, so tests share one Postgres database
	ws, owner, err := e.Bootstrap(context.Background(), engine.BootstrapArgs{
		OwnerName: "Aram", OwnerEmail: "owner-" + tag + "@example.com", OwnerHandle: "aram",
		WorkspaceSlug: "ws-" + tag, WorkspaceName: "Test",
	})
	if err != nil {
		t.Fatal(err)
	}
	return &world{t: t, e: e, st: st, ws: ws, owner: owner}
}

// do applies a change and fails the test if it is refused.
func (w *world) do(actor, typ string, args any) *engine.Result {
	w.t.Helper()
	res, err := w.try(actor, typ, args)
	if err != nil {
		w.t.Fatalf("%s: %v", typ, err)
	}
	return res
}

func (w *world) try(actor, typ string, args any) (*engine.Result, error) {
	w.t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		w.t.Fatal(err)
	}
	return w.e.Apply(context.Background(), w.ws.ID, actor, engine.Change{ID: id.New(), Type: typ, Args: raw})
}

// refused checks that a change is refused with the given code.
func (w *world) refused(code, actor, typ string, args any) *engine.Error {
	w.t.Helper()
	_, err := w.try(actor, typ, args)
	var ee *engine.Error
	if !errors.As(err, &ee) {
		w.t.Fatalf("%s: want refusal %q, got %v", typ, code, err)
	}
	if ee.Code != code {
		w.t.Fatalf("%s: want refusal %q, got %q: %s", typ, code, ee.Code, ee.Message)
	}
	return ee
}

func (w *world) agent(by, name, handle, role string) string {
	w.t.Helper()
	uid := id.New()
	w.do(by, "agent.create", map[string]any{"id": uid, "name": name, "handle": handle, "role": role})
	return uid
}

func (w *world) project(key string) core.Project {
	w.t.Helper()
	pid := id.New()
	w.do(w.owner.ID, "project.create", map[string]any{"id": pid, "key": key, "name": key + " project"})
	p, err := w.st.Project(context.Background(), w.ws.ID, pid)
	if err != nil {
		w.t.Fatal(err)
	}
	return p
}

func (w *world) task(actor, projectKey, title string, extra map[string]any) core.Task {
	w.t.Helper()
	tid := id.New()
	args := map[string]any{"id": tid, "project": projectKey, "title": title}
	for k, v := range extra {
		args[k] = v
	}
	w.do(actor, "task.create", args)
	return w.getTask(tid)
}

func (w *world) getTask(taskID string) core.Task {
	w.t.Helper()
	tk, err := w.st.Task(context.Background(), w.ws.ID, taskID)
	if err != nil {
		w.t.Fatal(err)
	}
	return tk
}

func (w *world) statusByCategory(projectID, category string) core.Status {
	w.t.Helper()
	sts, err := w.st.Statuses(context.Background(), w.ws.ID, projectID)
	if err != nil {
		w.t.Fatal(err)
	}
	for _, s := range sts {
		if s.Category == category {
			return s
		}
	}
	w.t.Fatalf("no %s status", category)
	return core.Status{}
}

func (w *world) feed(f store.EventFilter) []core.Event {
	w.t.Helper()
	evs, err := w.st.Events(context.Background(), w.ws.ID, f)
	if err != nil {
		w.t.Fatal(err)
	}
	return evs
}

// The loop the product exists for: an agent asks, the owner answers on an
// option, the agent sees it and the task comes back to it.
func TestReviewLoop(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		claude := w.agent(w.owner.ID, "Claude", "claude", "admin")
		p := w.project("SVA")

		if sts, _ := st.Statuses(ctx, w.ws.ID, p.ID); len(sts) != 6 {
			t.Fatalf("new project has %d statuses, want 6", len(sts))
		}

		tk := w.task(claude, "sva", "Core fight shield", map[string]any{"assignee_id": claude, "priority": 2})
		if tk.Key != "SVA-1" || tk.Number != 1 || tk.AssigneeID != claude {
			t.Fatalf("task = %+v", tk)
		}
		if tk2 := w.task(claude, "SVA", "Lane strike", nil); tk2.Key != "SVA-2" {
			t.Fatalf("second task key = %s", tk2.Key)
		}

		// The agent remembers where it is in the feed, on the server.
		if err := st.SetCursor(ctx, w.ws.ID, claude, "inbox", tk.ActivitySeq+100); err != nil {
			t.Fatal(err)
		}
		ws, _ := st.Workspace(ctx, w.ws.ID)
		if err := st.SetCursor(ctx, w.ws.ID, claude, "inbox", ws.Seq); err != nil {
			t.Fatal(err)
		}
		if cur, _ := st.Cursor(ctx, w.ws.ID, claude, "inbox"); cur != tk.ActivitySeq+100 {
			t.Fatalf("cursor moved backwards to %d", cur)
		}
		cursor := ws.Seq

		// Ask, with three options and a recommendation.
		did, optA, optB, optC := id.New(), id.New(), id.New(), id.New()
		res := w.do(claude, "decision.open", map[string]any{
			"id": did, "task_id": tk.ID, "question": "Which shield?",
			"options": []map[string]any{
				{"id": optA, "label": "A: flat seal"}, {"id": optB, "label": "C: full dome"}, {"id": optC, "label": "D: lighter dome"},
			},
			"recommended": 3, "recommendation": "Reads as a shield without hiding the Core", "ask": w.owner.ID,
		})
		if len(res.Events) != 2 || res.Events[0].Type != "decision.opened" || res.Events[1].Type != "task.updated" {
			t.Fatalf("decision.open events = %v", types(res.Events))
		}
		if got := w.getTask(tk.ID); got.WaitingOnID != w.owner.ID {
			t.Fatalf("task waits on %q, want the owner", got.WaitingOnID)
		}
		d, err := st.Decision(ctx, w.ws.ID, did)
		if err != nil || len(d.Options) != 3 || d.RecommendedOptionID != optC || d.State != core.StateOpen {
			t.Fatalf("decision = %+v, err %v", d, err)
		}

		// The owner's home screen: what waits on me, with an open decision.
		mine, err := st.Tasks(ctx, w.ws.ID, store.TaskFilter{WaitingOnID: w.owner.ID, OpenDecision: true})
		if err != nil || len(mine) != 1 || mine[0].ID != tk.ID {
			t.Fatalf("waiting on owner = %v, err %v", keys(mine), err)
		}

		// The owner comments on one option. It must show up as activity on
		// the task: this is the comment a tracker without a feed loses.
		w.do(w.owner.ID, "comment.create", map[string]any{
			"task_id": tk.ID, "subject_type": "decision_option", "subject_id": optB, "body": "Too heavy, hides the Core",
		})
		changed, err := st.Tasks(ctx, w.ws.ID, store.TaskFilter{AssigneeIDs: []string{claude}, ActivityAfter: cursor})
		if err != nil || len(changed) != 1 || changed[0].ID != tk.ID {
			t.Fatalf("tasks with new activity = %v, err %v", keys(changed), err)
		}

		// The asker cannot answer its own question.
		w.refused(engine.CodeForbidden, claude, "decision.pick", map[string]any{"id": did, "option_id": optC})
		// "With changes" must say which changes; an unknown option lists the real ones.
		w.refused(engine.CodeInvalid, w.owner.ID, "decision.pick", map[string]any{"id": did, "option_id": optC, "outcome": "with_changes"})
		if e := w.refused(engine.CodeInvalid, w.owner.ID, "decision.pick", map[string]any{"id": did, "option_id": id.New()}); len(e.Allowed) != 3 {
			t.Fatalf("refusal should list the 3 options, got %v", e.Allowed)
		}

		res = w.do(w.owner.ID, "decision.pick", map[string]any{"id": did, "option_id": optC, "outcome": "with_changes", "note": "smaller and darker"})
		if got := types(res.Events); len(got) != 2 || got[0] != "decision.picked" || got[1] != "task.updated" {
			t.Fatalf("decision.pick events = %v", got)
		}
		d, _ = st.Decision(ctx, w.ws.ID, did)
		if d.State != core.StatePicked || d.PickedOptionID != optC || d.Outcome != core.OutcomeWithChanges || d.DecidedBy != w.owner.ID {
			t.Fatalf("picked decision = %+v", d)
		}
		// The answer hands the task back to the one who asked.
		if got := w.getTask(tk.ID); got.WaitingOnID != claude {
			t.Fatalf("after the pick the task waits on %q, want the agent", got.WaitingOnID)
		}
		// The first answer stands.
		w.refused(engine.CodeConflict, w.owner.ID, "decision.pick", map[string]any{"id": did, "option_id": optA})

		// The task's own timeline has all of it, in order.
		timeline := types(w.feed(store.EventFilter{ScopeType: "task", ScopeID: tk.ID}))
		want := []string{"task.created", "decision.opened", "task.updated", "comment.created", "decision.picked", "task.updated"}
		if fmt.Sprint(timeline) != fmt.Sprint(want) {
			t.Fatalf("timeline = %v\n      want %v", timeline, want)
		}

		// The whole feed has no gaps and is in order.
		all := w.feed(store.EventFilter{Limit: 1000})
		for i, ev := range all {
			if ev.Seq != int64(i+1) {
				t.Fatalf("feed position %d has seq %d", i, ev.Seq)
			}
		}
		ws, _ = st.Workspace(ctx, w.ws.ID)
		if ws.Seq != int64(len(all)) {
			t.Fatalf("workspace seq %d, feed length %d", ws.Seq, len(all))
		}
		// Reading from a cursor returns only what is newer.
		if later := w.feed(store.EventFilter{After: cursor}); len(later) != len(all)-int(cursor) {
			t.Fatalf("feed after %d has %d events, want %d", cursor, len(later), len(all)-int(cursor))
		}
	})
}

func TestTaskUpdate(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		p := w.project("QD")
		tk := w.task(w.owner.ID, "QD", "Write the schema", nil)
		done := w.statusByCategory(p.ID, core.CatDone)
		started := w.statusByCategory(p.ID, core.CatStarted)

		res := w.do(w.owner.ID, "task.update", map[string]any{"id": tk.ID, "status_id": started.ID, "title": "Write the schema v2", "due_on": "2026-12-01"})
		var data struct {
			Changes map[string]core.FieldChange `json:"changes"`
		}
		if err := json.Unmarshal(res.Events[0].Data, &data); err != nil {
			t.Fatal(err)
		}
		if len(data.Changes) != 3 || data.Changes["title"].From != "Write the schema" || data.Changes["title"].To != "Write the schema v2" {
			t.Fatalf("changes = %+v", data.Changes)
		}
		got := w.getTask(tk.ID)
		if got.StartedAt == 0 || got.CompletedAt != 0 || got.DueOn != "2026-12-01" || got.UpdatedSeq != res.Seq {
			t.Fatalf("after start: %+v", got)
		}

		// Asking for what is already there writes nothing.
		if res := w.do(w.owner.ID, "task.update", map[string]any{"id": tk.ID, "status_id": started.ID}); len(res.Events) != 0 {
			t.Fatalf("no-op update produced %v", types(res.Events))
		}

		w.do(w.owner.ID, "task.update", map[string]any{"id": tk.ID, "status_id": done.ID, "due_on": nil})
		if got = w.getTask(tk.ID); got.CompletedAt == 0 || got.DueOn != "" {
			t.Fatalf("after done: %+v", got)
		}

		// An update based on an old version is refused, not applied over the new one.
		w.refused(engine.CodeStale, w.owner.ID, "task.update", map[string]any{"id": tk.ID, "base_seq": tk.UpdatedSeq, "title": "x"})
		// A misspelt field is an error, not a silent no-op.
		w.refused(engine.CodeInvalid, w.owner.ID, "task.update", map[string]any{"id": tk.ID, "titel": "x"})
		// A status from nowhere is refused.
		w.refused(engine.CodeInvalid, w.owner.ID, "task.update", map[string]any{"id": tk.ID, "status_id": id.New()})
		// An unknown change type lists the real ones.
		if e := w.refused(engine.CodeInvalid, w.owner.ID, "task.frobnicate", map[string]any{}); len(e.Allowed) == 0 {
			t.Fatal("unknown change type should list the allowed ones")
		}

		// Labels, sub-tasks and loops.
		lid := id.New()
		w.do(w.owner.ID, "label.create", map[string]any{"id": lid, "name": "visual"})
		w.do(w.owner.ID, "task.update", map[string]any{"id": tk.ID, "add_label_ids": []string{lid}})
		if got = w.getTask(tk.ID); len(got.LabelIDs) != 1 || got.LabelIDs[0] != lid {
			t.Fatalf("labels = %v", got.LabelIDs)
		}
		byLabel, _ := st.Tasks(context.Background(), w.ws.ID, store.TaskFilter{LabelID: lid})
		if len(byLabel) != 1 {
			t.Fatalf("filter by label found %d", len(byLabel))
		}
		child := w.task(w.owner.ID, "QD", "Sub-task", map[string]any{"parent_id": tk.ID})
		w.refused(engine.CodeInvalid, w.owner.ID, "task.update", map[string]any{"id": tk.ID, "parent_id": child.ID})

		// Trash and restore.
		w.do(w.owner.ID, "task.delete", map[string]any{"id": child.ID})
		live, _ := st.Tasks(context.Background(), w.ws.ID, store.TaskFilter{})
		trash, _ := st.Tasks(context.Background(), w.ws.ID, store.TaskFilter{InTrash: true})
		if len(live) != 1 || len(trash) != 1 {
			t.Fatalf("live %d, trash %d", len(live), len(trash))
		}
		w.refused(engine.CodeConflict, w.owner.ID, "task.update", map[string]any{"id": child.ID, "title": "x"})
		w.do(w.owner.ID, "task.restore", map[string]any{"id": child.ID})
		if live, _ = st.Tasks(context.Background(), w.ws.ID, store.TaskFilter{}); len(live) != 2 {
			t.Fatalf("after restore live = %d", len(live))
		}
	})
}

func TestSendingAChangeTwice(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.project("QD")
		ctx := context.Background()
		ch := engine.Change{ID: id.New(), Type: "task.create", Args: json.RawMessage(`{"project":"QD","title":"Once"}`)}

		first, err := w.e.Apply(ctx, w.ws.ID, w.owner.ID, ch)
		if err != nil {
			t.Fatal(err)
		}
		// The same change again, as a retry after a lost answer would send it.
		ch.Args = json.RawMessage(`{ "project": "QD", "title": "Once" }`)
		second, err := w.e.Apply(ctx, w.ws.ID, w.owner.ID, ch)
		if err != nil {
			t.Fatal(err)
		}
		if !second.Duplicate || second.Seq != first.Seq || len(second.Events) != 0 {
			t.Fatalf("retry = %+v, first = %+v", second, first)
		}
		if all, _ := st.Tasks(ctx, w.ws.ID, store.TaskFilter{}); len(all) != 1 {
			t.Fatalf("%d tasks after a retried create, want 1", len(all))
		}
		// The same id for something else is a mistake, and is refused.
		ch.Args = json.RawMessage(`{"project":"QD","title":"Different"}`)
		var ee *engine.Error
		if _, err := w.e.Apply(ctx, w.ws.ID, w.owner.ID, ch); !errors.As(err, &ee) || ee.Code != engine.CodeConflict {
			t.Fatalf("reused id: %v", err)
		}
	})
}

func TestRolesAndWorkspaceWalls(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		worker := w.agent(w.owner.ID, "Worker", "worker", "")
		admin := w.agent(w.owner.ID, "Coordinator", "coordinator", "admin")

		// A member cannot do an admin's work, and no agent is an owner.
		w.refused(engine.CodeForbidden, worker, "project.create", map[string]any{"key": "NO", "name": "no"})
		w.refused(engine.CodeForbidden, worker, "agent.create", map[string]any{"name": "x", "handle": "xx"})
		w.refused(engine.CodeInvalid, w.owner.ID, "agent.create", map[string]any{"name": "x", "handle": "xx", "role": "owner"})
		// An agent cannot answer for another agent.
		w.refused(engine.CodeInvalid, admin, "agent.create", map[string]any{"name": "x", "handle": "xx", "responsible_id": worker})
		// Handles are unique in a workspace.
		w.refused(engine.CodeConflict, w.owner.ID, "agent.create", map[string]any{"name": "x", "handle": "worker"})
		// An admin agent can create a member agent. The person who answers
		// for the admin agent answers for the new one too.
		sub := w.agent(admin, "Sub", "sub", "member")
		if u, err := st.User(ctx, sub); err != nil || u.Kind != core.KindAgent || u.ResponsibleID != w.owner.ID {
			t.Fatalf("sub-agent = %+v, err %v", u, err)
		}

		w.project("AA")
		tk := w.task(worker, "AA", "Mine", map[string]any{"assignee_id": worker})

		// Another workspace sees none of it and cannot touch it.
		other := newWorld(t, st)
		if _, err := st.Task(ctx, other.ws.ID, tk.ID); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("task visible from another workspace: %v", err)
		}
		other.refused(engine.CodeNotFound, other.owner.ID, "task.update", map[string]any{"id": tk.ID, "title": "stolen"})
		other.refused(engine.CodeNotFound, other.owner.ID, "comment.create", map[string]any{"task_id": tk.ID, "body": "hi"})
		// A stranger cannot write to this workspace.
		w.refused(engine.CodeForbidden, other.owner.ID, "task.create", map[string]any{"project": "AA", "title": "x"})
		// And cannot be made an assignee here.
		w.refused(engine.CodeNotFound, w.owner.ID, "task.update", map[string]any{"id": tk.ID, "assignee_id": other.owner.ID})

		members, _ := st.Members(ctx, w.ws.ID)
		if len(members) != 4 {
			t.Fatalf("%d members, want 4", len(members))
		}
	})
}

// Many writers at once: task numbers and event numbers stay unique and
// without gaps on every database.
func TestConcurrentWrites(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		ctx := context.Background()
		w.project("CC")
		before, _ := st.Workspace(ctx, w.ws.ID)

		const n = 40
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				args, _ := json.Marshal(map[string]any{"project": "CC", "title": fmt.Sprintf("task %d", i)})
				if _, err := w.e.Apply(ctx, w.ws.ID, w.owner.ID, engine.Change{ID: id.New(), Type: "task.create", Args: args}); err != nil {
					errs <- err
				}
			}(i)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}

		tasks, err := st.Tasks(ctx, w.ws.ID, store.TaskFilter{Limit: 500})
		if err != nil || len(tasks) != n {
			t.Fatalf("%d tasks, err %v", len(tasks), err)
		}
		seen := map[int]bool{}
		for _, tk := range tasks {
			if tk.Number < 1 || tk.Number > n || seen[tk.Number] {
				t.Fatalf("bad or repeated task number %d", tk.Number)
			}
			seen[tk.Number] = true
		}
		evs := w.feed(store.EventFilter{After: before.Seq, Limit: 1000})
		if len(evs) != n {
			t.Fatalf("%d events, want %d", len(evs), n)
		}
		for i, ev := range evs {
			if ev.Seq != before.Seq+int64(i)+1 {
				t.Fatalf("gap in the feed at %d: seq %d", i, ev.Seq)
			}
		}
	})
}

func types(evs []core.Event) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.Type
	}
	return out
}

func keys(ts []core.Task) []string {
	out := make([]string, len(ts))
	for i, tk := range ts {
		out[i] = tk.Key
	}
	return out
}
