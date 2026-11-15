package server

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

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

// agentStates says what every agent is doing right now.
func (x *c) agentStates(tasks []core.Task, nm *names) ([]agentState, error) {
	w, err := x.agentWork(tasks, nm)
	if err != nil {
		return nil, err
	}
	var out []agentState
	for _, m := range nm.members {
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
// webhook, and the open questions.
type agentWork struct {
	x        *c
	nm       *names
	now      time.Time
	tasks    []core.Task
	keyOf    map[string]core.Task // the same tasks, by id
	sessions []core.AgentSession
	pushed   map[string]bool // members with a webhook that is being delivered
	asked    []core.Decision
}

// agentWork reads it, for the open tasks given.
func (x *c) agentWork(tasks []core.Task, nm *names) (*agentWork, error) {
	ctx := x.ctx()
	w := &agentWork{x: x, nm: nm, now: time.Now(), tasks: tasks, pushed: map[string]bool{}, keyOf: map[string]core.Task{}}
	if err := x.db.List(ctx, &w.sessions, store.Q{Where: []store.Cond{store.Eq("state", "running"), store.Gte("started_at", w.now.Add(-12*time.Hour).UnixMilli())},
		Order: "-started_at"}); err != nil {
		return nil, err
	}
	w.sessions = keepByTask(x, w.sessions, func(v core.AgentSession) string { return v.TaskID })
	var hooks []core.Webhook
	if err := x.db.List(ctx, &hooks, store.Where(store.Live, store.Eq("active", true), store.NotNull("user_id"))); err != nil {
		return nil, err
	}
	for _, h := range hooks {
		if h.Failures >= 3 {
			continue // it keeps failing: nothing is hearing these
		}
		w.pushed[h.UserID] = true
	}
	for _, t := range tasks {
		w.keyOf[t.ID] = t
	}
	// Open questions asked of someone wait on them too, even when the task
	// itself names another.
	if err := x.db.List(ctx, &w.asked, store.Where(store.Eq("state", core.StateOpen), store.NotNull("asked_id"), store.Live)); err != nil {
		return nil, err
	}
	return w, nil
}

// stateOf says what one agent is doing.
func (w *agentWork) stateOf(m core.Member) (agentState, error) {
	x, nm, now := w.x, w.nm, w.now
	shown := []core.Member{m}
	x.hideActions(shown)
	a := agentState{Handle: "@" + m.Handle, Name: m.Name, UserID: m.UserID, State: "idle", LastSeen: when(m.LastSeenAt), LastDid: shown[0].LastAction,
		Listening: m.ListeningUntil > now.UnixMilli() || w.pushed[m.UserID]}
	var waitsOnOthers, mine int
	for _, t := range w.tasks {
		if !core.OpenCategory(nm.statuses[t.StatusID].Category) {
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
			a.WaitsOn = nm.handle(t.WaitingOnID)
		}
		if t.LeaseHolderID == m.UserID && t.LeaseUntil > now.UnixMilli() && a.Task == "" {
			a.State, a.Task, a.Doing = "working", t.Key, t.Title
		}
	}
	a.Open = mine
	for _, d := range w.asked {
		if t, ok := w.keyOf[d.TaskID]; ok && d.AskedID == m.UserID && t.WaitingOnID != m.UserID {
			a.Queue++
		}
	}
	for _, se := range w.sessions {
		if se.AgentID == m.UserID {
			a.State, a.Doing, a.Since = "working", orText(se.Title, a.Doing), when(se.StartedAt)
			if t, ok := w.keyOf[se.TaskID]; ok {
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
	cost, minutes, err := x.s.eng.Usage(x.ctx(), x.db, m.UserID, weekStart(now))
	if err != nil {
		return a, err
	}
	if cost > 0 {
		a.CostWeek = money(cost)
	}
	a.MinWeek = minutes
	if b := m.Budget; b != nil && b.CostMicros > 0 {
		a.Budget = money(b.CostMicros)
	}
	return a, nil
}

// hAgents is the live view of agents: who is doing what, who is waiting,
// who is not reachable.
func (s *Server) hAgents(x *c) error {
	nm, err := x.names()
	if err != nil {
		return err
	}
	tasks, err := x.everyTask(store.TaskFilter{Open: true, ProjectIDs: x.projects})
	if err != nil {
		return err
	}
	agents, err := x.agentStates(tasks, nm)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(lines(agents, func(a agentState) string {
			l := fmt.Sprintf("%s  %s", a.Handle, strings.ReplaceAll(a.State, "_", " "))
			if a.Task != "" {
				l += " on " + a.Task
			}
			if a.WaitsOn != "" {
				l += " on " + a.WaitsOn
			}
			if !a.Listening {
				l += "  (nothing is listening for it)"
			}
			return l + fmt.Sprintf("  open=%d queue=%d", a.Open, a.Queue)
		}, "no agents"))
	}
	return x.ok(map[string]any{"agents": agents})
}

// agentStates fills in what every agent is doing, from the open tasks the
// dashboard covers.
func (d *dashboard) agentStates() error {
	var open []core.Task
	for _, t := range d.tasks {
		if core.OpenCategory(d.nm.statuses[t.StatusID].Category) {
			open = append(open, t)
		}
	}
	var err error
	d.agents, err = d.x.agentStates(open, d.nm)
	return err
}
