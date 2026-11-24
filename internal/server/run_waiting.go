// What waits on an agent when Quadit's runner begins to serve its listener
// of a project: the items from before the runner that still ask something
// of the agent, which the runner takes as a queue (a task assigned before
// the runner was set up starts it), while the rest of the history is
// acknowledged without a run. It is said here once (waits), for the hold
// that begins a runner (where its reading starts, beginRunner), for each
// item from before the beginning that is handed out (wakeOf), and for the
// read that tells, before a runner is set up, what it would start.

package server

import (
	"context"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// maxWaitingTasks is how many tasks the read of what would start names.
const maxWaitingTasks = 5

// runWaitingRoutes are the routes of what waits.
func (s *Server) runWaitingRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/listening/{key}/waiting", s.workspaceMember(s.handleShowRunnerWaiting), "What Quadit's runner would start if it began now to serve the caller's listener of a project (its key, or its id), without creating or changing anything: {project, runs, tasks: [{key, title}]}: runs is how many tasks it would start a run on, one per task however many of its items wait, and tasks names the first five, oldest item first. An item from before a runner began starts a run only if it still waits on the agent: unread and not archived, addressed to it, on a task of the project that is not in the trash, done or canceled (for an assignment, still assigned to it), that no run of the agent's took and the agent did nothing on since but record its sessions; and the wake rule starts it. An agent's login only.", "", "follow"},
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
	waiting, err := x.waitingItems(x.ctx(), x.db, x.member.UserID, project.ID, from)
	if err != nil {
		return err
	}
	tasks, runs := []waitingTask{}, map[string]bool{}
	for _, item := range waiting {
		if runs[item.task.ID] {
			continue
		}
		w, err := x.wakeOf(x.ctx(), x.member, item.event, ws.Seq)
		if err != nil {
			return err
		}
		if w.Do != wakeRun {
			continue
		}
		runs[item.task.ID] = true
		if len(tasks) < maxWaitingTasks {
			tasks = append(tasks, waitingTask{Key: item.task.Key, Title: item.task.Title})
		}
	}
	return x.ok(map[string]any{"project": project.Key, "runs": len(runs), "tasks": tasks})
}

// beginRunner records, in the write of a hold, that a runner begins to
// serve the agent's listener of a project, which had none (listeners are
// as they were before the hold, which may be about to make the listener):
// the present is the runner's beginning, which it returns, and the
// listener's cursor is set where the runner reads from: just before the
// oldest item that waits (waitingItems, after runnerFloor), so that it
// neither misses what waits nor walks the whole history item by item; at
// the present when nothing waits. The cursor may move back: what a session
// handled behind it is kept from running again by waits, not by the
// cursor.
func (who *viewer) beginRunner(ctx context.Context, tx store.Tx, listeners agentListeners, projectID string, now time.Time) (int64, error) {
	began := tx.Seq()
	from, err := who.runnerFloor(ctx, tx, listeners, projectID, now)
	if err != nil {
		return 0, err
	}
	waiting, err := who.waitingItems(ctx, tx, who.member.UserID, projectID, from)
	if err != nil {
		return 0, err
	}
	start := began
	if len(waiting) > 0 {
		start = waiting[0].event.Seq - 1
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

// waitingItem is one of an agent's items that waits on it: its
// notification.created event, and its task.
type waitingItem struct {
	event core.Event
	task  core.Task
}

// waitingItems are the agent's items of a project after the feed position
// from that wait on it (waits), oldest first.
func (who *viewer) waitingItems(ctx context.Context, db store.DB, agentID, projectID string, from int64) ([]waitingItem, error) {
	var notes []core.Notification
	if err := db.List(ctx, &notes, store.Q{Where: []store.Cond{store.Eq("user_id", agentID), store.Gt("seq", from), store.Null("read_at"), store.Null("archived_at"),
		store.Eq("addressed", true), store.NotNull("task_id")}, Order: "seq"}); err != nil {
		return nil, err
	}
	var out []waitingItem
	for _, note := range notes {
		t, waiting, err := who.waits(ctx, db, agentID, note, projectID)
		if err != nil {
			return nil, err
		}
		if !waiting {
			continue
		}
		// The item is the project's listener's when it was made in the
		// project: a task moved in since brought its items' events along
		// in the project they were made in.
		var ev core.Event
		there, err := store.Find(ctx, db, &ev, store.Eq("seq", note.Seq), store.Eq("type", "notification.created"))
		if err != nil {
			return nil, err
		}
		if there && ev.ProjectID == projectID {
			out = append(out, waitingItem{event: ev, task: t})
		}
	}
	return out, nil
}

// waits reports whether one of the agent's items, made in the project
// projectID, still asks something of it, read as stored now, and answers
// its task. It waits when it is unread and not archived; addressed to the
// agent; on a task of that project that is not in the trash, done or
// canceled; for an assignment, on a task still assigned to the agent; no
// run of the agent's took it (AgentSession.ItemsThrough); and the agent
// did nothing on the task since, but record its sessions: nothing marks an
// item read when a session handles it, and a comment, an answer or a
// change of the agent's there after it says a session did.
func (who *viewer) waits(ctx context.Context, db store.DB, agentID string, note core.Notification, projectID string) (core.Task, bool, error) {
	var t core.Task
	if note.ReadAt != 0 || note.ArchivedAt != 0 || !note.Addressed || note.TaskID == "" {
		return t, false, nil
	}
	there, err := store.Find(ctx, db, &t, store.Eq("id", note.TaskID))
	if err != nil || !there || t.DeletedAt != 0 || t.ProjectID != projectID || note.Type == core.NoteAssigned && t.AssigneeID != agentID {
		return t, false, err
	}
	var status core.Status
	there, err = store.Find(ctx, db, &status, store.Eq("id", t.StatusID))
	if err != nil || there && !core.OpenCategory(status.Category) {
		return t, false, err
	}
	taken, err := db.Count(ctx, "agent_sessions", store.Eq("agent_id", agentID), store.Eq("task_id", t.ID), store.Gte("items_through", note.Seq))
	if err != nil || taken > 0 {
		return t, false, err
	}
	f := store.EventFilter{ScopeType: "task", ScopeID: t.ID, ActorID: agentID, After: note.Seq, Limit: 50}
	for {
		evs, err := db.Events(ctx, f)
		if err != nil {
			return t, false, err
		}
		for _, ev := range evs {
			data, err := ev.Payload()
			if err != nil {
				return t, false, err
			}
			// A rule the agent made acts in its name without it.
			if ev.EntityType != "session" && data.Rule == "" {
				return t, false, nil
			}
		}
		if len(evs) < f.Limit {
			return t, true, nil
		}
		f.After = evs[len(evs)-1].Seq
	}
}
