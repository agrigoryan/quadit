// The dashboard (/dashboard): where everything stands, in one call. Its
// parts are read by the other dashboard_*.go files.

package server

import (
	"context"
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// dashboardRoutes are the routes of the dashboard and its parts.
func (s *Server) dashboardRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/dashboard", s.workspaceMember(s.handleShowDashboard), "Where everything stands: waiting on me, epics with progress, flow, agents, recent decisions, and for an admin of the whole workspace its health.", "project: key", "oversight"},
		{"GET /api/v1/w/{ws}/cycles/{id}/chart", s.workspaceMember(s.handleShowCycleChart), "A cycle's scope against done, day by day.", "", "oversight"},                                                                                                                                                                                                     // dashboard_cycle.go
		{"GET /api/v1/w/{ws}/agents", s.workspaceMember(s.handleListAgents), "What every agent is doing now, and how far it is connected: connected_at, when it first proved it reached Quadit from its tool; listening, whether its listener holds its lease or a webhook pushes to it; tool, that of the last connect code it gave back.", "", "oversight"}, // dashboard_agents.go
		{"GET /api/v1/w/{ws}/agents/connection", s.workspaceMember(s.handleListAgentConnections), "How far every agent is connected, the cheap part of GET agents: {agents: [{handle, user_id, connected_at, listening, tool}]}.", "", "oversight"},                                                                                                           // dashboard_agents.go
	}
}

// handleShowDashboard is where everything stands, in one call: what waits on the
// caller, epics, flow, agents, recent decisions and, for an admin of the
// whole workspace, the health of the machinery. project=KEY narrows it to
// one project.
func (s *Server) handleShowDashboard(x *c) error {
	d, err := x.dashboard(x.ctx(), x.r.URL.Query().Get("project"))
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(d.dashboardText()) // dashboard_text.go
	}
	return x.ok(d.answer())
}

// dashboard is the dashboard as it is answered: each of its parts, read
// on its own from what the dashboard covers (dashboardScope).
type dashboard struct {
	waiting   []taskView     // tasks that wait on the caller, oldest first
	asked     []decisionView // open questions asked of the caller
	epics     []epicProgress
	byStatus  []flowStatus
	weekly    []flowWeek
	waits     []flowWait
	agents    []agentState
	decided   []decisionView // the latest answered decisions
	prefs     []core.Preference
	machinery map[string]any // what is failing behind the scenes; nil when that is not for the viewer
}

// dashboardScope is what a dashboard covers. Every part reads it, and none
// changes it.
type dashboardScope struct {
	// oneProject says the dashboard was asked for one project, not for
	// everything the viewer may read.
	oneProject bool
	names      *nameLookup
	now        time.Time
	// covers is the viewer kept to the projects the dashboard covers: what
	// it may see is what the dashboard shows.
	covers  *viewer
	tasks   []core.Task     // every task it covers, archived ones too
	covered map[string]bool // the ids of those tasks
}

// dashboard builds the dashboard of the projects the viewer may read, or of
// the one project named (by key or id) when projectRef is not "": what it
// covers, then each part of it.
func (who *viewer) dashboard(ctx context.Context, projectRef string) (dashboard, error) {
	names, err := who.names(ctx)
	if err != nil {
		return dashboard{}, err
	}
	covers := *who
	if projectRef != "" {
		project, err := who.resolver(ctx).Project(projectRef)
		if err != nil {
			return dashboard{}, err
		}
		if !who.canProject(project.ID) {
			return dashboard{}, errNotFound("project " + projectRef)
		}
		covers.limitTo([]string{project.ID})
	}
	tasks, err := who.everyTask(ctx, covers.readable(store.TaskFilter{Archived: true}))
	if err != nil {
		return dashboard{}, err
	}
	covered := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		covered[t.ID] = true
	}
	scope := dashboardScope{oneProject: projectRef != "", names: names, now: time.Now(), covers: &covers, tasks: tasks, covered: covered}

	var d dashboard
	if d.waiting, d.asked, err = who.waitingOnMe(ctx, scope); err != nil {
		return dashboard{}, err
	}
	d.epics = epicProgressOf(scope)      // dashboard_epics.go
	d.byStatus = who.flowByStatus(scope) // dashboard_flow.go
	d.weekly = flowWeekly(scope)
	if d.waits, err = who.flowWaiting(ctx, scope); err != nil {
		return dashboard{}, err
	}
	if d.agents, err = who.dashboardAgents(ctx, scope); err != nil { // dashboard_agents.go
		return dashboard{}, err
	}
	if d.decided, d.prefs, err = who.recentDecisions(ctx, scope); err != nil {
		return dashboard{}, err
	}
	if d.machinery, err = who.health(ctx); err != nil { // dashboard_health.go
		return dashboard{}, err
	}
	return d, nil
}

// answer is the dashboard as it is sent. It has a "health" only for a
// viewer the health is for: none is not the same as nothing failing.
func (d dashboard) answer() map[string]any {
	out := map[string]any{
		"waiting_on_me":    d.waiting,
		"asked_of_me":      d.asked,
		"epics":            d.epics,
		"flow":             map[string]any{"by_status": d.byStatus, "weekly": d.weekly, "waiting": d.waits},
		"agents":           d.agents,
		"recent_decisions": d.decided,
		"preferences":      d.prefs,
	}
	if d.machinery != nil {
		out["health"] = d.machinery
	}
	return out
}

// waitingOnMe is what waits on the caller: tasks and the questions asked of
// them, oldest first.
func (who *viewer) waitingOnMe(ctx context.Context, scope dashboardScope) ([]taskView, []decisionView, error) {
	me := who.member.UserID
	var waiting []core.Task
	for _, t := range scope.tasks {
		if t.WaitingOnID == me && core.OpenCategory(scope.names.statuses[t.StatusID].Category) {
			waiting = append(waiting, t)
		}
	}
	sort.Slice(waiting, func(i, j int) bool { return waiting[i].UpdatedAt < waiting[j].UpdatedAt })
	tasks, err := who.taskViews(ctx, waiting)
	if err != nil {
		return nil, nil, err
	}
	var asked []core.Decision
	if err := who.db.List(ctx, &asked, store.Q{Where: []store.Cond{store.Eq("asked_id", me), store.Eq("state", core.StateOpen), store.Live}, Order: "created_seq"}); err != nil {
		return nil, nil, err
	}
	// Only questions on the tasks the dashboard covers: one narrowed to a
	// project leaves out what is asked on another's.
	asked = keep(asked, func(question core.Decision) bool { return scope.covered[question.TaskID] })
	questions, err := who.decisionViews(ctx, asked)
	return tasks, questions, err
}

// recentDecisions is the latest answered decisions and the new standing
// preferences.
func (who *viewer) recentDecisions(ctx context.Context, scope dashboardScope) ([]decisionView, []core.Preference, error) {
	var picked []core.Decision
	if err := who.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: 60}); err != nil {
		return nil, nil, err
	}
	picked = keep(picked, func(decision core.Decision) bool { return scope.covered[decision.TaskID] })
	if len(picked) > dashboardDecisions {
		picked = picked[:dashboardDecisions]
	}
	decided, err := who.decisionViews(ctx, picked)
	if err != nil {
		return nil, nil, err
	}
	var prefs []core.Preference
	if err := who.db.List(ctx, &prefs, store.Q{Where: []store.Cond{store.Live, store.Null("retired_at")}, Order: "-created_at", Limit: 5}); err != nil {
		return nil, nil, err
	}
	prefs = keep(prefs, func(pref core.Preference) bool { return scope.covers.canProject(pref.ProjectID) })
	return decided, prefs, nil
}

// dashboardDecisions is how many of the latest answered decisions the
// dashboard shows.
const dashboardDecisions = 8

// everyTask reads all the tasks a filter matches, however many there are.
func (who *viewer) everyTask(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	f.Sort, f.Limit = "created", maxTasksByID
	var all []core.Task
	for {
		page, err := who.db.Tasks(ctx, f)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(page) < f.Limit {
			return all, nil
		}
		// Past the last one read, in the order they were made.
		f.After = []any{page[len(page)-1].ID}
	}
}
