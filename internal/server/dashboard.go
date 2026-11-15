// The dashboard (/dashboard): where everything stands, in one call. Its
// parts are filled in by the other dashboard_*.go files.

package server

import (
	"context"
	"slices"
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// dashboardRoutes are the routes of the dashboard and its parts.
func (s *Server) dashboardRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/dashboard", s.workspaceMember(s.handleShowDashboard), "Where everything stands: waiting on me, epics with progress, flow, agents, recent decisions, health.", "project: key", "oversight"},
		{"GET /api/v1/w/{ws}/cycles/{id}/chart", s.workspaceMember(s.handleShowCycleChart), "A cycle's scope against done, day by day.", "", "oversight"},                 // dashboard_cycle.go
		{"GET /api/v1/w/{ws}/agents", s.workspaceMember(s.handleListAgents), "What every agent is doing now, and whether anything is listening for it.", "", "oversight"}, // dashboard_agents.go
	}
}

// handleShowDashboard is where everything stands, in one call: what waits on the
// caller, epics, flow, agents, recent decisions and the health of the
// machinery. project=KEY narrows it to one project.
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

// dashboard is one dashboard being built: who asked, what it covers, and
// its parts as they are filled in. It is one run of work, made and filled
// inside viewer.dashboard, which is why it holds a ctx.
type dashboard struct {
	who *viewer
	ctx context.Context
	// oneProject says the dashboard was asked for one project, not for
	// everything the viewer may read.
	oneProject bool
	names      *nameLookup
	now        time.Time
	projects   []string        // the projects it covers; none means all the caller may read
	tasks      []core.Task     // every task of those projects, archived ones too
	covered    map[string]bool // the ids of those tasks

	waiting   []taskView     // tasks that wait on the caller, oldest first
	asked     []decisionView // open questions asked of the caller
	epics     []epicProgress
	byStatus  []flowStatus
	weekly    []flowWeek
	waits     []flowWait
	agents    []agentState
	decided   []decisionView // the latest answered decisions
	prefs     []core.Preference
	machinery map[string]any // what is failing behind the scenes
}

// dashboard builds the dashboard of the projects the viewer may read, or of
// the one project named (by key or id) when projectRef is not "".
func (who *viewer) dashboard(ctx context.Context, projectRef string) (*dashboard, error) {
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	projects := who.projects
	if projectRef != "" {
		project, err := who.resolver(ctx).Project(projectRef)
		if err != nil {
			return nil, err
		}
		if !who.canProject(project.ID) {
			return nil, errNotFound("project " + projectRef)
		}
		projects = []string{project.ID}
	}
	tasks, err := who.everyTask(ctx, store.TaskFilter{ProjectIDs: projects, Archived: true})
	if err != nil {
		return nil, err
	}
	covered := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		covered[t.ID] = true
	}
	d := &dashboard{who: who, ctx: ctx, oneProject: projectRef != "", names: names, now: time.Now(), projects: projects, tasks: tasks, covered: covered}
	parts := []func() error{
		d.waitingOnMe,
		d.epicProgress, // dashboard_epics.go
		d.flow,         // dashboard_flow.go
		d.agentStates,  // dashboard_agents.go
		d.recentDecisions,
		d.health, // dashboard_health.go
	}
	for _, part := range parts {
		if err := part(); err != nil {
			return nil, err
		}
	}
	return d, nil
}

// answer is the dashboard as it is sent.
func (d *dashboard) answer() map[string]any {
	return map[string]any{
		"waiting_on_me":    d.waiting,
		"asked_of_me":      d.asked,
		"epics":            d.epics,
		"flow":             map[string]any{"by_status": d.byStatus, "weekly": d.weekly, "waiting": d.waits},
		"agents":           d.agents,
		"recent_decisions": d.decided,
		"preferences":      d.prefs,
		"health":           d.machinery,
	}
}

// waitingOnMe fills in what waits on the caller: tasks and the questions
// asked of them, oldest first.
func (d *dashboard) waitingOnMe() error {
	who, ctx, me := d.who, d.ctx, d.who.member.UserID
	var waiting []core.Task
	for _, t := range d.tasks {
		if t.WaitingOnID == me && core.OpenCategory(d.names.statuses[t.StatusID].Category) {
			waiting = append(waiting, t)
		}
	}
	sort.Slice(waiting, func(i, j int) bool { return waiting[i].UpdatedAt < waiting[j].UpdatedAt })
	var err error
	if d.waiting, err = who.taskViews(ctx, waiting); err != nil {
		return err
	}
	var asked []core.Decision
	if err := who.db.List(ctx, &asked, store.Q{Where: []store.Cond{store.Eq("asked_id", me), store.Eq("state", core.StateOpen), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	// Only questions on the tasks the dashboard covers: one narrowed to a
	// project leaves out what is asked on another's.
	asked = keep(asked, func(question core.Decision) bool { return d.covered[question.TaskID] })
	d.asked, err = who.decisionViews(ctx, asked)
	return err
}

// recentDecisions fills in the recent decisions and the new standing
// preferences.
func (d *dashboard) recentDecisions() error {
	who, ctx := d.who, d.ctx
	var picked []core.Decision
	if err := who.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: 60}); err != nil {
		return err
	}
	picked = keep(picked, func(decision core.Decision) bool { return d.covered[decision.TaskID] })
	if len(picked) > dashboardDecisions {
		picked = picked[:dashboardDecisions]
	}
	var err error
	if d.decided, err = who.decisionViews(ctx, picked); err != nil {
		return err
	}
	var prefs []core.Preference
	if err := who.db.List(ctx, &prefs, store.Q{Where: []store.Cond{store.Live, store.Null("retired_at")}, Order: "-created_at", Limit: 5}); err != nil {
		return err
	}
	d.prefs = keep(prefs, func(pref core.Preference) bool {
		return len(d.projects) == 0 || pref.ProjectID == "" || slices.Contains(d.projects, pref.ProjectID)
	})
	return nil
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
