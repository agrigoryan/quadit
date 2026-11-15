// Agents: what each is doing right now (/agents, and the dashboard's agents part).

package server

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// agentState is what one agent is doing, as /agents and the dashboard show it.
type agentState struct {
	Handle string `json:"handle"`
	Name   string `json:"name"`
	UserID string `json:"user_id"`
	// State: working, waiting (all its open work waits on someone else),
	// has_work (something waits on it and it is not working), idle.
	State     string `json:"state"`
	Task      string `json:"task,omitempty"`
	Doing     string `json:"doing,omitempty"`
	Since     string `json:"since,omitempty"`
	WaitsOn   string `json:"waits_on,omitempty"`
	Listening bool   `json:"listening"`
	LastSeen  string `json:"last_seen,omitempty"`
	LastDid   string `json:"last_action,omitempty"`
	Open      int    `json:"open_tasks"`
	Queue     int    `json:"waiting_on_it"`
	CostWeek  string `json:"cost_week,omitempty"`
	MinWeek   int64  `json:"minutes_week,omitempty"`
	Budget    string `json:"budget,omitempty"`
}

// agentStates says what every agent is doing right now. With projects,
// every agent is still listed, but what it is shown doing (working, on
// what, its last action) is only what it does in those projects.
func (who *viewer) agentStates(ctx context.Context, tasks []core.Task, names *nameLookup, projects []string) ([]agentState, error) {
	w, err := who.agentWork(ctx, tasks, names, projects)
	if err != nil {
		return nil, err
	}
	var out []agentState
	for _, m := range names.members {
		if m.Kind != core.KindAgent || m.RemovedAt != 0 || m.SuspendedAt != 0 {
			continue // a suspended agent is not idle: it is not there
		}
		a, err := w.stateOf(m)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Handle < out[j].Handle })
	return out, nil
}

// agentWork is what agentStates reads once and then looks at for each
// agent: the open tasks, the sessions that are running, who is heard by a
// webhook, and the open questions. It is one run of work, made and used up
// inside viewer.agentStates, which is why it holds a ctx.
type agentWork struct {
	who      *viewer
	ctx      context.Context
	names    *nameLookup
	now      time.Time
	tasks    []core.Task
	keyOf    map[string]core.Task // the same tasks, by id
	sessions []core.AgentSession
	pushed   map[string]bool // members with a webhook that is being delivered
	asked    []core.Decision
	// keys are the keys of the projects the agents are seen in; nil when
	// that is the whole workspace.
	keys map[string]bool
}

// agentWork reads it, for the open tasks given, in the projects given (or
// the whole workspace).
func (who *viewer) agentWork(ctx context.Context, tasks []core.Task, names *nameLookup, projects []string) (*agentWork, error) {
	w := &agentWork{who: who, ctx: ctx, names: names, now: time.Now(), tasks: tasks, pushed: map[string]bool{}, keyOf: map[string]core.Task{}}
	if err := who.db.List(ctx, &w.sessions, store.Q{Where: []store.Cond{store.Eq("state", core.AgentSessionRunning), store.Gte("started_at", w.now.Add(-12*time.Hour).UnixMilli())},
		Order: "-started_at,id"}); err != nil {
		return nil, err
	}
	w.sessions = onTask(func(session core.AgentSession) string { return session.TaskID })(ctx, who, w.sessions)
	if len(projects) > 0 {
		w.keys = map[string]bool{}
		for _, projectID := range projects {
			w.keys[names.projects[projectID].Key] = true
		}
		var err error
		if w.sessions, err = who.sessionsIn(ctx, w.sessions, projects); err != nil {
			return nil, err
		}
	}
	var hooks []core.Webhook
	if err := who.db.List(ctx, &hooks, store.Where(store.Live, store.Eq("active", true), store.NotNull("user_id"))); err != nil {
		return nil, err
	}
	for _, hook := range hooks {
		if hook.Failures >= 3 {
			continue // it keeps failing: nothing is hearing these
		}
		w.pushed[hook.UserID] = true
	}
	for _, t := range tasks {
		w.keyOf[t.ID] = t
	}
	// Open questions asked of someone wait on them too, even when the task
	// itself names another.
	if err := who.db.List(ctx, &w.asked, store.Where(store.Eq("state", core.StateOpen), store.NotNull("asked_id"), store.Live)); err != nil {
		return nil, err
	}
	return w, nil
}

// sessionsIn keeps the sessions on tasks of the projects.
func (who *viewer) sessionsIn(ctx context.Context, sessions []core.AgentSession, projects []string) ([]core.AgentSession, error) {
	var ids []string
	for _, session := range sessions {
		if session.TaskID != "" {
			ids = append(ids, session.TaskID)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	tasks, err := who.db.Tasks(ctx, store.TaskFilter{IDs: ids, ProjectIDs: projects, Archived: true, Limit: maxTasksByID})
	if err != nil {
		return nil, err
	}
	inProjects := map[string]bool{}
	for _, t := range tasks {
		inProjects[t.ID] = true
	}
	return keep(sessions, func(session core.AgentSession) bool { return inProjects[session.TaskID] }), nil
}

// actsIn reports whether a last action ("comment.create SVA-12") was on a
// task of the projects with these keys: it names one, and none elsewhere.
func actsIn(action string, keys map[string]bool) bool {
	found := taskKeyIn.FindAllStringSubmatch(action, -1)
	for _, match := range found {
		if !keys[match[1]] {
			return false
		}
	}
	return len(found) > 0
}

// stateOf says what one agent is doing: working (it holds a task, or runs a
// session), has_work (something waits on it), waiting (all its open work
// waits on others), or idle; and what it has spent this week.
func (w *agentWork) stateOf(m core.Member) (agentState, error) {
	a := agentState{Handle: "@" + m.Handle, Name: m.Name, UserID: m.UserID, State: "idle", LastSeen: formatTime(m.LastSeenAt), LastDid: w.lastAction(m),
		Listening: m.ListeningUntil > w.now.UnixMilli() || w.pushed[m.UserID]}

	// The open tasks: what waits on it, what is its own, which of those wait
	// on someone else, and the task it holds (which makes it working).
	var mine, waitsOnOthers int
	for _, t := range w.tasks {
		if !core.OpenCategory(w.names.statuses[t.StatusID].Category) {
			continue
		}
		if t.WaitingOnID == m.UserID {
			a.Queue++
		}
		if t.AssigneeID != m.UserID {
			continue
		}
		mine++
		if t.WaitingOnID != "" && t.WaitingOnID != m.UserID {
			waitsOnOthers++
			a.WaitsOn = w.names.handle(t.WaitingOnID)
		}
		if t.LeaseHolderID == m.UserID && t.LeaseUntil > w.now.UnixMilli() && a.Task == "" {
			a.State, a.Task, a.Doing = "working", t.Key, t.Title
		}
	}
	a.Open = mine

	// Open questions asked of it wait on it too, on tasks that do not
	// already.
	for _, question := range w.asked {
		if t, ok := w.keyOf[question.TaskID]; ok && question.AskedID == m.UserID && t.WaitingOnID != m.UserID {
			a.Queue++
		}
	}

	// A running session makes it working, on the session's task.
	for _, session := range w.sessions {
		if session.AgentID == m.UserID {
			a.State, a.Doing, a.Since = "working", firstNonEmpty(session.Title, a.Doing), formatTime(session.StartedAt)
			if t, ok := w.keyOf[session.TaskID]; ok {
				a.Task = t.Key
			}
			break
		}
	}

	switch {
	case a.State == "working":
	case a.Queue > 0:
		a.State = "has_work"
	case mine > 0 && waitsOnOthers == mine:
		a.State = "waiting"
	}
	if a.State != "waiting" {
		a.WaitsOn = ""
	}

	// What it has spent this week, and its budget.
	cost, minutes, err := w.who.agentUsage(w.ctx, w.who.db, m.UserID, weekStart(w.now))
	if err != nil {
		return a, err
	}
	if cost > 0 {
		a.CostWeek = formatMoney(cost)
	}
	a.MinWeek = minutes
	if budget := m.Budget; budget != nil && budget.CostMicros > 0 {
		a.Budget = formatMoney(budget.CostMicros)
	}
	return a, nil
}

// lastAction is the agent's last action as the caller may see it: only
// when it was on a task of the projects the agents are seen in.
func (w *agentWork) lastAction(m core.Member) string {
	shown := []core.Member{m}
	w.who.hideActions(w.ctx, shown)
	if w.keys != nil && !actsIn(shown[0].LastAction, w.keys) {
		return ""
	}
	return shown[0].LastAction
}

// handleListAgents is the live view of agents: who is doing what, who is waiting,
// who is not reachable.
func (s *Server) handleListAgents(x *c) error {
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	tasks, err := x.everyTask(x.ctx(), x.readable(store.TaskFilter{Open: true}))
	if err != nil {
		return err
	}
	agents, err := x.agentStates(x.ctx(), tasks, names, nil)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(lines(agents, func(a agentState) string {
			line := fmt.Sprintf("%s  %s", a.Handle, strings.ReplaceAll(a.State, "_", " "))
			if a.Task != "" {
				line += " on " + a.Task
			}
			if a.WaitsOn != "" {
				line += " on " + a.WaitsOn
			}
			if !a.Listening {
				line += "  (nothing is listening for it)"
			}
			return line + fmt.Sprintf("  open=%d queue=%d", a.Open, a.Queue)
		}, "no agents"))
	}
	return x.ok(map[string]any{"agents": agents})
}

// agentStates fills in what every agent is doing, from the open tasks the
// dashboard covers. Narrowed to one project, that is what each agent does
// there.
func (d *dashboard) agentStates() error {
	var open []core.Task
	for _, t := range d.tasks {
		if core.OpenCategory(d.names.statuses[t.StatusID].Category) {
			open = append(open, t)
		}
	}
	var err error
	var only []string
	if d.oneProject {
		only = d.projects
	}
	d.agents, err = d.who.agentStates(d.ctx, open, d.names, only)
	return err
}
