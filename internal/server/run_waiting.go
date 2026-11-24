// What waits on an agent when Quadit's runner begins to serve its listener
// of a project: the items from before the runner that still ask something
// of the agent, which the runner takes as a queue (a task assigned before
// the runner was set up starts it), while the rest of the history is
// acknowledged without a run. It is said here once (asks and settled, put
// together by waits and eachWaiting), for the hold that begins a runner
// (where its reading starts, beginRunner), for each item from before the
// beginning that is handed out (wakeOf), and for the read that tells,
// before a runner is set up, what it would start.

package server

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

const (
	// maxWaitingTasks is how many tasks the read of what would start names.
	maxWaitingTasks = 5
	// The search for what waits reads an agent's items of a project
	// waitingPage at a time, oldest first, and looks at no more than
	// maxWaitingLooks of them: past those, a runner begins at the present.
	// It runs in the write of a runner's first hold, which other writes of
	// the workspace wait for.
	waitingPage     = 200
	maxWaitingLooks = 5000
	// maxHandlingLooks is how many of the agent's changes on a task, after
	// an item, are asked whether the agent made them in person; past them
	// the item is taken as handled, and starts nothing.
	maxHandlingLooks = 20
)

// runWaitingRoutes are the routes of what waits.
func (s *Server) runWaitingRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/listening/{key}/waiting", s.workspaceMember(s.handleShowRunnerWaiting), "What Quadit's runner would start if it began now to serve the caller's listener of a project (its key, or its id), without creating or changing anything: {agent, project, runs, tasks: [{key, title}]}: runs is how many tasks it would start a run on, one per task however many of its items wait, and tasks names the first five, oldest item first. An item from before a runner began starts a run only if it still waits on the agent: unread and not archived, addressed to it, on a task of the project that is not in the trash, done or canceled, still assigned to it for an assignment and still waiting on it for a hand-off, its comment not taken back, not taken by a run of the agent's that ended, and the agent did nothing on the task in person between it and the runner's beginning; and the wake rule starts it. An agent's login only.", "", "follow"},
	}
}

// waitingTask is a task the read of what would start names.
type waitingTask struct {
	Key   string `json:"key"`
	Title string `json:"title"`
}

// handleShowRunnerWaiting answers what a runner beginning now on the
// caller's listener of a project would start: so that a person setting
// one up is not surprised by what starts.
func (s *Server) handleShowRunnerWaiting(x *c) error {
	if x.member.Kind != core.KindAgent {
		return errForbidden("this login is @%s's, a person's, not an agent's: a runner runs an agent with its own login", x.member.Handle)
	}
	project, err := x.listenProject(x.ctx(), x.r.PathValue("key"))
	if err != nil {
		return err
	}
	if project.ID == "" {
		return &engine.Error{Code: engine.CodeInvalid, Field: "key", Message: "a runner listens to one project: name it"}
	}
	listeners, err := listenersOf(x.ctx(), x.db, x.member.UserID)
	if err != nil {
		return err
	}
	var ws core.Workspace
	if err := s.st.Get(x.ctx(), &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	from, err := x.runnerFloor(x.ctx(), x.db, listeners, project.ID, time.Now())
	if err != nil {
		return err
	}
	tasks, runs := []waitingTask{}, map[string]bool{}
	var failed error
	err = x.eachWaiting(x.ctx(), x.db, x.member.UserID, project.ID, from, ws.Seq, func(ev core.Event, t core.Task) bool {
		if runs[t.ID] {
			return true
		}
		w, err := x.wakeOf(x.ctx(), x.member, ev, ws.Seq)
		if err != nil {
			failed = err
			return false
		}
		if w.Do == wakeRun {
			runs[t.ID] = true
			if len(tasks) < maxWaitingTasks {
				tasks = append(tasks, waitingTask{Key: t.Key, Title: t.Title})
			}
		}
		return true
	})
	if err = cmp.Or(failed, err); err != nil {
		return err
	}
	return x.ok(map[string]any{"agent": "@" + x.member.Handle, "project": project.Key, "runs": len(runs), "tasks": tasks})
}

// beginRunner records, in the write of a hold, that a runner begins to
// serve the agent's listener of a project, which had none (listeners are
// as they were before the hold, which may be about to make the listener):
// the present is the runner's beginning, which it returns, and the
// listener's cursor is set where the runner reads from: just before the
// oldest item that waits (eachWaiting, after runnerFloor), so that it
// neither misses what waits nor walks the whole history item by item; at
// the present when nothing waits. The cursor may move back: what a session
// handled behind it is kept from running again by waits, not by the
// cursor, and a release puts it back (handleReleaseRunner).
func (who *viewer) beginRunner(ctx context.Context, tx store.Tx, listeners agentListeners, projectID string, now time.Time) (int64, error) {
	began := tx.Seq()
	from, err := who.runnerFloor(ctx, tx, listeners, projectID, now)
	if err != nil {
		return 0, err
	}
	start := began
	err = who.eachWaiting(ctx, tx, who.member.UserID, projectID, from, began, func(ev core.Event, _ core.Task) bool {
		start = ev.Seq - 1
		return false
	})
	if err != nil {
		return 0, err
	}
	return began, tx.Upsert(ctx, core.Cursor{WorkspaceID: who.ws.ID, UserID: who.member.UserID, Name: core.ListenCursorOf(projectID), Seq: start, UpdatedAt: now.UnixMilli()},
		"workspace_id", "user_id", "name")
}

// runnerFloor is the feed position a runner beginning now on the agent's
// listener of a project never reads behind. A project about to get its
// first listener beside a live listener of everything takes over only that
// one's queue (queueOf): what lies behind it, a session at work now has
// handled or holds in hand. Otherwise none: what a session handled is kept
// from running again by waits.
func (who *viewer) runnerFloor(ctx context.Context, db store.DB, listeners agentListeners, projectID string, now time.Time) (int64, error) {
	if _, has := listeners.of(projectID); has {
		return 0, nil
	}
	from, _, err := who.queueOf(ctx, db, listeners, projectID, now)
	return from, err
}

// eachWaiting gives yield, oldest first, each of the agent's items of a
// project after the feed position from that waits on it for a runner that
// began at began (as waits says), with its task, until yield answers
// false. It reads the project's items page by page, the rows they need a
// page at a time, and looks at no more than maxWaitingLooks items.
func (who *viewer) eachWaiting(ctx context.Context, db store.DB, agentID, projectID string, from, began int64, yield func(core.Event, core.Task) bool) error {
	var statuses []core.Status
	if err := db.List(ctx, &statuses, store.Where(store.Eq("project_id", projectID))); err != nil {
		return err
	}
	statusOf := map[string]core.Status{}
	for _, s := range statuses {
		statusOf[s.ID] = s
	}
	f := store.EventFilter{After: from, ProjectIDs: []string{projectID}, OnlyAudience: agentID, Types: []string{"notification.created"}, Limit: waitingPage}
	for looked := 0; looked < maxWaitingLooks; looked += waitingPage {
		evs, err := db.Events(ctx, f)
		if err != nil || len(evs) == 0 {
			return err
		}
		var ids []string
		for _, ev := range evs {
			ids = append(ids, ev.EntityID)
		}
		var notes []core.Notification
		if err := db.List(ctx, &notes, store.Where(store.In("id", ids), store.Null("read_at"), store.Null("archived_at"), store.Eq("addressed", true),
			store.NotNull("task_id"))); err != nil {
			return err
		}
		noteOf, taskIDs := map[string]core.Notification{}, []string{}
		for _, note := range notes {
			noteOf[note.ID] = note
			taskIDs = append(taskIDs, note.TaskID)
		}
		var tasks []core.Task
		if len(taskIDs) > 0 {
			if err := db.List(ctx, &tasks, store.Where(store.In("id", taskIDs))); err != nil {
				return err
			}
		}
		taskOf := map[string]core.Task{}
		for _, t := range tasks {
			taskOf[t.ID] = t
		}
		for _, ev := range evs {
			note, isNote := noteOf[ev.EntityID]
			t, isTask := taskOf[note.TaskID]
			if !isNote || !isTask || !asks(note, t, statusOf[t.StatusID], agentID, projectID) {
				continue
			}
			done, err := who.settled(ctx, db, agentID, note, began)
			if err != nil {
				return err
			}
			if !done && !yield(ev, t) {
				return nil
			}
		}
		if len(evs) < f.Limit {
			return nil
		}
		f.After = evs[len(evs)-1].Seq
	}
	return nil
}

// waits reports whether one of the agent's items, made in the project
// projectID, still waits on it for a runner that began at began, read as
// stored now: what it asks is still asked (asks), and no session settled
// it (settled).
func (who *viewer) waits(ctx context.Context, db store.DB, agentID string, note core.Notification, projectID string, began int64) (bool, error) {
	if note.TaskID == "" {
		return false, nil
	}
	var t core.Task
	if there, err := store.Find(ctx, db, &t, store.Eq("id", note.TaskID)); err != nil || !there {
		return false, err
	}
	var status core.Status
	if _, err := store.Find(ctx, db, &status, store.Eq("id", t.StatusID)); err != nil {
		return false, err
	}
	if !asks(note, t, status, agentID, projectID) {
		return false, nil
	}
	done, err := who.settled(ctx, db, agentID, note, began)
	return !done, err
}

// asks reports whether an item still asks something of the agent, by its
// own row, its task t and the task's status: it is unread and not
// archived; addressed to the agent; on a task of the project projectID that
// is not in the trash, done or canceled; for an assignment, the task is
// still assigned to the agent, and for a hand-off it still waits on the
// agent (a resource's turn asks nothing of the task).
func asks(note core.Notification, t core.Task, status core.Status, agentID, projectID string) bool {
	switch {
	case note.ReadAt != 0 || note.ArchivedAt != 0 || !note.Addressed || note.TaskID == "" || note.TaskID != t.ID:
		return false
	case t.DeletedAt != 0 || t.ProjectID != projectID || !core.OpenCategory(status.Category):
		return false
	case note.Type == core.NoteAssigned:
		return t.AssigneeID == agentID
	case note.Type == core.NoteWaitingOn:
		return note.EntityType != "resource" && t.WaitingOnID == agentID
	}
	return true
}

// settled reports whether an item that asks something was settled since,
// for a runner that began at began. Its comment was taken back (in the
// trash). A run of the agent's took it (AgentSession.ItemsThrough), and
// ended other than at a usage limit or a sign-in failure, after which
// the runner continues it. Or a session handled it before the runner
// began: nothing marks an item read when a session handles it, but the
// agent did something on its task in person after it (not by a rule, nor
// a session's own record of itself, nor what the server wrote in its name,
// appliedInPerson). After the beginning, only a run's record says what
// the runner handled.
func (who *viewer) settled(ctx context.Context, db store.DB, agentID string, note core.Notification, began int64) (bool, error) {
	if note.EntityType == "comment" {
		var cm core.Comment
		there, err := store.Find(ctx, db, &cm, store.Eq("id", note.EntityID), store.Live)
		if err != nil || !there {
			return true, err
		}
	}
	var runs []core.AgentSession
	if err := db.List(ctx, &runs, store.Where(store.Eq("agent_id", agentID), store.Eq("task_id", note.TaskID), store.Gte("items_through", note.Seq))); err != nil {
		return false, err
	}
	if slices.ContainsFunc(runs, func(run core.AgentSession) bool {
		goesOn := run.State == core.AgentSessionFailed && (run.Reason == core.RunUsageLimit || run.Reason == core.RunNotSignedIn)
		return !goesOn
	}) {
		return true, nil
	}
	f := store.EventFilter{ScopeType: "task", ScopeID: note.TaskID, ActorID: agentID, After: note.Seq, Limit: 50}
	asked := map[string]bool{}
	for {
		evs, err := db.Events(ctx, f)
		if err != nil {
			return false, err
		}
		for _, ev := range evs {
			if ev.Seq > began {
				return false, nil
			}
			data, err := ev.Payload()
			if err != nil {
				return false, err
			}
			if ev.EntityType == "session" || data.Rule != "" || asked[ev.ChangeID] {
				continue
			}
			if len(asked) == maxHandlingLooks {
				return true, nil
			}
			asked[ev.ChangeID] = true
			inPerson, err := appliedInPerson(ctx, db, ev)
			if err != nil || inPerson {
				return inPerson, err
			}
		}
		if len(evs) < f.Limit {
			return false, nil
		}
		f.After = evs[len(evs)-1].Seq
	}
}
