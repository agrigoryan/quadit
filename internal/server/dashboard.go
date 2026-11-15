package server

import (
	"net/http"
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/w/{ws}/dashboard", s.workspaceMember(s.handleShowDashboard))
		m.HandleFunc("GET /api/v1/w/{ws}/cycles/{id}/chart", s.workspaceMember(s.handleShowCycleChart)) // dashboard_cycle.go
		m.HandleFunc("GET /api/v1/w/{ws}/agents", s.workspaceMember(s.handleListAgents))                // dashboard_agents.go
	})
}

// handleShowDashboard is where everything stands, in one call: what waits on the
// caller, epics, flow, agents, recent decisions and the health of the
// machinery. project=KEY narrows it to one project.
func (s *Server) handleShowDashboard(x *c) error {
	d, err := x.newDashboard()
	if err != nil {
		return err
	}
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
			return err
		}
	}
	if x.wantText() {
		return x.text(d.dashboardText()) // dashboard_text.go
	}
	return x.ok(d.answer())
}

// dashboard is one dashboard being built: who asked, what it covers, and
// its parts as they are filled in.
type dashboard struct {
	x        *c
	names    *nameLookup
	now      time.Time
	projects []string        // the projects it covers; none means all the caller may read
	tasks    []core.Task     // every task of those projects, archived ones too
	covered  map[string]bool // the ids of those tasks

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

// newDashboard works out which projects the dashboard covers and reads
// their tasks.
func (x *c) newDashboard() (*dashboard, error) {
	names, err := x.names()
	if err != nil {
		return nil, err
	}
	projects := x.projects
	if ref := x.r.URL.Query().Get("project"); ref != "" {
		project, err := x.resolver().Project(ref)
		if err != nil {
			return nil, err
		}
		if !x.canProject(project.ID) {
			return nil, errNotFound("project " + ref)
		}
		projects = []string{project.ID}
	}
	tasks, err := x.everyTask(store.TaskFilter{ProjectIDs: projects, Archived: true})
	if err != nil {
		return nil, err
	}
	covered := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		covered[t.ID] = true
	}
	return &dashboard{x: x, names: names, now: time.Now(), projects: projects, tasks: tasks, covered: covered}, nil
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
	x, me := d.x, d.x.member.UserID
	var waiting []core.Task
	for _, t := range d.tasks {
		if t.WaitingOnID == me && core.OpenCategory(d.names.statuses[t.StatusID].Category) {
			waiting = append(waiting, t)
		}
	}
	sort.Slice(waiting, func(i, j int) bool { return waiting[i].UpdatedAt < waiting[j].UpdatedAt })
	var err error
	if d.waiting, err = x.taskViews(waiting); err != nil {
		return err
	}
	var asked []core.Decision
	if err := x.db.List(x.ctx(), &asked, store.Q{Where: []store.Cond{store.Eq("asked_id", me), store.Eq("state", core.StateOpen), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	// Only questions on the tasks the dashboard covers: one narrowed to a
	// project leaves out what is asked on another's.
	asked = keep(asked, func(question core.Decision) bool { return d.covered[question.TaskID] })
	d.asked, err = x.decisionViews(asked)
	return err
}

// recentDecisions fills in the recent decisions and the new standing
// preferences.
func (d *dashboard) recentDecisions() error {
	x, ctx := d.x, d.x.ctx()
	var picked []core.Decision
	if err := x.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: 60}); err != nil {
		return err
	}
	picked = keep(picked, func(decision core.Decision) bool { return d.covered[decision.TaskID] })
	if len(picked) > dashboardDecisions {
		picked = picked[:dashboardDecisions]
	}
	var err error
	if d.decided, err = x.decisionViews(picked); err != nil {
		return err
	}
	var prefs []core.Preference
	if err := x.db.List(ctx, &prefs, store.Q{Where: []store.Cond{store.Live, store.Null("retired_at")}, Order: "-created_at", Limit: 5}); err != nil {
		return err
	}
	d.prefs = keep(prefs, func(pref core.Preference) bool {
		return len(d.projects) == 0 || pref.ProjectID == "" || has(d.projects, pref.ProjectID)
	})
	return nil
}

// dashboardDecisions is how many of the latest answered decisions the
// dashboard shows.
const dashboardDecisions = 8

// everyTask reads all the tasks a filter matches, however many there are.
func (x *c) everyTask(f store.TaskFilter) ([]core.Task, error) {
	f.Sort, f.Limit = "created", maxTasksByID
	var all []core.Task
	for {
		page, err := x.db.Tasks(x.ctx(), f)
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
