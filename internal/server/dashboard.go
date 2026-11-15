package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/w/{ws}/dashboard", s.in(s.hDashboard))
		m.HandleFunc("GET /api/v1/w/{ws}/cycles/{id}/chart", s.in(s.hCycleChart))
		m.HandleFunc("GET /api/v1/w/{ws}/agents", s.in(s.hAgents))
	})
}

type epicProgress struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Project  string `json:"project"`
	State    string `json:"state"`
	Lead     string `json:"lead,omitempty"`
	TargetOn string `json:"target_on,omitempty"`
	Total    int    `json:"total"`
	Done     int    `json:"done"`
	Started  int    `json:"started"`
	Points   int    `json:"points,omitempty"`
	PointsOK int    `json:"points_done,omitempty"`
	// AtRisk: the target date is close or past and work is left, or nothing
	// has moved in two weeks.
	AtRisk string `json:"at_risk,omitempty"`
	// AtRiskCode names the reason for programs: past_target, due_soon, stalled.
	AtRiskCode string `json:"at_risk_code,omitempty"`
}

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
	ctx := x.ctx()
	now := time.Now()
	var sessions []core.AgentSession
	if err := x.db.List(ctx, &sessions, store.Q{Where: []store.Cond{store.Eq("state", "running"), store.Gte("started_at", now.Add(-12*time.Hour).UnixMilli())},
		Order: "-started_at"}); err != nil {
		return nil, err
	}
	sessions = keepByTask(x, sessions, func(v core.AgentSession) string { return v.TaskID })
	var hooks []core.Webhook
	if err := x.db.List(ctx, &hooks, store.Where(store.Live, store.Eq("active", true), store.NotNull("user_id"))); err != nil {
		return nil, err
	}
	pushed := map[string]bool{}
	for _, h := range hooks {
		if h.Failures >= 3 {
			continue // it keeps failing: nothing is hearing these
		}
		pushed[h.UserID] = true
	}
	keyOf := map[string]core.Task{}
	for _, t := range tasks {
		keyOf[t.ID] = t
	}
	// Open questions asked of someone wait on them too, even when the task
	// itself names another.
	var asked []core.Decision
	if err := x.db.List(ctx, &asked, store.Where(store.Eq("state", core.StateOpen), store.NotNull("asked_id"), store.Live)); err != nil {
		return nil, err
	}
	var out []agentState
	for _, m := range nm.members {
		if m.Kind != core.KindAgent || m.RemovedAt != 0 || m.SuspendedAt != 0 {
			continue // a suspended agent is not idle: it is not there
		}
		shown := []core.Member{m}
		x.hideActions(shown)
		a := agentState{Handle: "@" + m.Handle, Name: m.Name, UserID: m.UserID, State: "idle", LastSeen: when(m.LastSeenAt), LastDid: shown[0].LastAction,
			Listening: m.ListeningUntil > now.UnixMilli() || pushed[m.UserID]}
		var waitsOnOthers, mine int
		for _, t := range tasks {
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
		for _, d := range asked {
			if t, ok := keyOf[d.TaskID]; ok && d.AskedID == m.UserID && t.WaitingOnID != m.UserID {
				a.Queue++
			}
		}
		for _, se := range sessions {
			if se.AgentID == m.UserID {
				a.State, a.Doing, a.Since = "working", orText(se.Title, a.Doing), when(se.StartedAt)
				if t, ok := keyOf[se.TaskID]; ok {
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
		cost, minutes, err := x.s.eng.Usage(ctx, x.db, m.UserID, weekStart(now))
		if err != nil {
			return nil, err
		}
		if cost > 0 {
			a.CostWeek = money(cost)
		}
		a.MinWeek = minutes
		if b := m.Budget; b != nil && b.CostMicros > 0 {
			a.Budget = money(b.CostMicros)
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Handle < out[j].Handle })
	return out, nil
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

// hDashboard is where everything stands, in one call: what waits on the
// caller, epics, flow, agents, recent decisions and the health of the
// machinery. project=KEY narrows it to one project.
func (s *Server) hDashboard(x *c) error {
	ctx := x.ctx()
	nm, err := x.names()
	if err != nil {
		return err
	}
	projects := x.projects
	if ref := x.r.URL.Query().Get("project"); ref != "" {
		p, err := x.resolver().Project(ref)
		if err != nil {
			return err
		}
		if !x.canProject(p.ID) {
			return errNotFound("project " + ref)
		}
		projects = []string{p.ID}
	}
	tasks, err := x.everyTask(store.TaskFilter{ProjectIDs: projects, Archived: true})
	if err != nil {
		return err
	}
	now := time.Now()
	me := x.member.UserID
	out := map[string]any{}

	// Waiting on me: tasks and the questions asked of me, oldest first.
	var waiting []core.Task
	for _, t := range tasks {
		if t.WaitingOnID == me && core.OpenCategory(nm.statuses[t.StatusID].Category) {
			waiting = append(waiting, t)
		}
	}
	sort.Slice(waiting, func(i, j int) bool { return waiting[i].UpdatedAt < waiting[j].UpdatedAt })
	wv, err := x.taskViews(waiting, false)
	if err != nil {
		return err
	}
	out["waiting_on_me"] = wv
	var asked []core.Decision
	if err := x.db.List(ctx, &asked, store.Q{Where: []store.Cond{store.Eq("asked_id", me), store.Eq("state", core.StateOpen), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	if out["asked_of_me"], err = x.decisionViews(asked, false); err != nil {
		return err
	}

	// Epics with their progress.
	var epics []epicProgress
	lastMove := map[string]int64{}
	byEpic := map[string]*epicProgress{}
	for _, e := range nm.epics {
		if e.DeletedAt != 0 || (len(projects) > 0 && !has(projects, e.ProjectID)) || e.State == core.EpicCanceled {
			continue
		}
		byEpic[e.ID] = &epicProgress{ID: e.ID, Name: e.Name, Project: nm.projects[e.ProjectID].Key, State: e.State, Lead: nm.handle(e.LeadID), TargetOn: e.TargetOn}
	}
	byStatus := map[string]int{}
	weeks := map[string][2]int{}
	weekOf := func(ms int64) string {
		t := time.UnixMilli(ms).UTC()
		t = t.AddDate(0, 0, -((int(t.Weekday()) + 6) % 7))
		return t.Format("2006-01-02")
	}
	cutoff := now.AddDate(0, 0, -7*12).UnixMilli()
	for _, t := range tasks {
		cat := nm.statuses[t.StatusID].Category
		if t.ArchivedAt == 0 {
			byStatus[t.StatusID]++
		}
		if t.CreatedAt >= cutoff {
			w := weeks[weekOf(t.CreatedAt)]
			w[0]++
			weeks[weekOf(t.CreatedAt)] = w
		}
		if t.CompletedAt >= cutoff && t.CompletedAt != 0 {
			w := weeks[weekOf(t.CompletedAt)]
			w[1]++
			weeks[weekOf(t.CompletedAt)] = w
		}
		ep, ok := byEpic[t.EpicID]
		if !ok || cat == core.CatCanceled {
			continue
		}
		ep.Total++
		ep.Points += t.Estimate
		switch cat {
		case core.CatDone:
			ep.Done++
			ep.PointsOK += t.Estimate
		case core.CatStarted, core.CatWaiting:
			ep.Started++
		}
		if t.UpdatedAt > lastMove[t.EpicID] {
			lastMove[t.EpicID] = t.UpdatedAt
		}
	}
	today := now.UTC().Format("2006-01-02")
	soon := now.AddDate(0, 0, 7).UTC().Format("2006-01-02")
	for id, ep := range byEpic {
		left := ep.Total - ep.Done
		switch {
		case ep.State == core.EpicDone || left == 0:
		case ep.TargetOn != "" && ep.TargetOn < today:
			ep.AtRisk, ep.AtRiskCode = "past its target date", "past_target"
		case ep.TargetOn != "" && ep.TargetOn <= soon && ep.Done*2 < ep.Total:
			ep.AtRisk, ep.AtRiskCode = "due within a week and less than half done", "due_soon"
		case ep.State == core.EpicActive && lastMove[id] != 0 && now.UnixMilli()-lastMove[id] > 14*24*3600_000:
			ep.AtRisk, ep.AtRiskCode = "nothing has moved in two weeks", "stalled"
		}
		epics = append(epics, *ep)
	}
	sort.Slice(epics, func(i, j int) bool {
		if (epics[i].TargetOn == "") != (epics[j].TargetOn == "") {
			return epics[i].TargetOn != ""
		}
		return epics[i].TargetOn+epics[i].Name < epics[j].TargetOn+epics[j].Name
	})
	out["epics"] = epics

	// Flow: tasks by status, opened and closed per week, waits per member.
	type statusCount struct {
		Status   string `json:"status"`
		Category string `json:"category"`
		Project  string `json:"project"`
		Count    int    `json:"count"`
	}
	var sc []statusCount
	var sts []core.Status
	for _, st := range nm.statuses {
		if st.DeletedAt == 0 && (len(projects) == 0 || has(projects, st.ProjectID)) && x.canProject(st.ProjectID) {
			sts = append(sts, st)
		}
	}
	sort.Slice(sts, func(i, j int) bool { return sts[i].ProjectID+sts[i].Rank < sts[j].ProjectID+sts[j].Rank })
	for _, st := range sts {
		sc = append(sc, statusCount{Status: st.Name, Category: st.Category, Project: nm.projects[st.ProjectID].Key, Count: byStatus[st.ID]})
	}
	type week struct {
		Week   string `json:"week"`
		Opened int    `json:"opened"`
		Closed int    `json:"closed"`
	}
	var wk []week
	for d := now.AddDate(0, 0, -7*11); !d.After(now); d = d.AddDate(0, 0, 7) {
		k := weekOf(d.UnixMilli())
		wk = append(wk, week{Week: k, Opened: weeks[k][0], Closed: weeks[k][1]})
	}
	// How long each open task has waited on its member: since the last
	// change that handed it to them.
	since := map[string]int64{}
	evs, err := x.db.Events(ctx, store.EventFilter{Types: []string{"task.updated", "task.created"}, ProjectIDs: projects, Desc: true, Limit: 2000})
	if err != nil {
		return err
	}
	for _, ev := range evs {
		if _, seen := since[ev.ScopeID]; seen || !strings.Contains(string(ev.Data), "waiting_on_id") {
			continue
		}
		since[ev.ScopeID] = ev.At
	}
	type wait struct {
		Member string  `json:"member"`
		Kind   string  `json:"kind"`
		Tasks  int     `json:"tasks"`
		Hours  float64 `json:"avg_hours"`
		Oldest float64 `json:"oldest_hours"`
	}
	waits := map[string]*wait{}
	for _, t := range tasks {
		if t.WaitingOnID == "" || !core.OpenCategory(nm.statuses[t.StatusID].Category) {
			continue
		}
		at := since[t.ID]
		if at == 0 {
			at = t.UpdatedAt
		}
		h := float64(now.UnixMilli()-at) / 3600_000
		wt := waits[t.WaitingOnID]
		if wt == nil {
			wt = &wait{Member: nm.handle(t.WaitingOnID), Kind: nm.members[t.WaitingOnID].Kind}
			waits[t.WaitingOnID] = wt
		}
		wt.Tasks++
		wt.Hours += h
		wt.Oldest = max(wt.Oldest, h)
	}
	var wl []wait
	for _, wt := range waits {
		wt.Hours = float64(int(wt.Hours/float64(wt.Tasks)*10)) / 10
		wt.Oldest = float64(int(wt.Oldest*10)) / 10
		wl = append(wl, *wt)
	}
	sort.Slice(wl, func(i, j int) bool {
		if wl[i].Oldest != wl[j].Oldest {
			return wl[i].Oldest > wl[j].Oldest
		}
		return wl[i].Member < wl[j].Member
	})
	out["flow"] = map[string]any{"by_status": sc, "weekly": wk, "waiting": wl}

	var open []core.Task
	for _, t := range tasks {
		if core.OpenCategory(nm.statuses[t.StatusID].Category) {
			open = append(open, t)
		}
	}
	if out["agents"], err = x.agentStates(open, nm); err != nil {
		return err
	}

	// Recent decisions and new standing preferences.
	var picked []core.Decision
	if err := x.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: 60}); err != nil {
		return err
	}
	inScope := map[string]bool{}
	for _, t := range tasks {
		inScope[t.ID] = true
	}
	picked = keep(picked, func(d core.Decision) bool { return inScope[d.TaskID] })
	if len(picked) > 8 {
		picked = picked[:8]
	}
	if out["recent_decisions"], err = x.decisionViews(picked, false); err != nil {
		return err
	}
	var prefs []core.Preference
	if err := x.db.List(ctx, &prefs, store.Q{Where: []store.Cond{store.Live, store.Null("retired_at")}, Order: "-created_at", Limit: 5}); err != nil {
		return err
	}
	out["preferences"] = keep(prefs, func(p core.Preference) bool {
		return len(projects) == 0 || p.ProjectID == "" || has(projects, p.ProjectID)
	})

	// Health: what is failing behind the scenes.
	health := map[string]any{}
	health["webhooks_failing"], _ = x.db.Count(ctx, "webhooks", store.Live, store.Gt("failures", 0))
	health["deliveries_dead"] = liveDeliveries(ctx, x.db, store.Eq("state", "dead"))
	health["deliveries_pending"] = liveDeliveries(ctx, x.db, store.Eq("state", "pending"), store.Gt("attempts", 0))
	var backups []core.Backup
	if err := s.st.List(ctx, &backups, store.Q{Order: "-started_at", Limit: 1}); err == nil && len(backups) > 0 {
		health["last_backup"] = when(backups[0].FinishedAt)
		health["last_backup_ok"] = backups[0].Error == "" && backups[0].FinishedAt != 0
	}
	var sources []core.DocSource
	if err := x.db.List(ctx, &sources, store.Where(store.Live)); err == nil {
		n := 0
		for _, src := range sources {
			if src.LastError != "" {
				n++
			}
		}
		health["sources_failing"] = n
	}
	out["health"] = health

	if x.wantText() {
		raw, _ := json.Marshal(out["health"])
		var b strings.Builder
		fmt.Fprintf(&b, "== waiting on you (%d)\n%s", len(wv), lines(wv, taskView.line, "nothing"))
		b.WriteString("== epics\n")
		for _, e := range epics {
			fmt.Fprintf(&b, "%s  %s  %d/%d done", e.Project, e.Name, e.Done, e.Total)
			if e.TargetOn != "" {
				b.WriteString("  target " + e.TargetOn)
			}
			if e.AtRisk != "" {
				b.WriteString("  AT RISK: " + e.AtRisk)
			}
			b.WriteString("\n")
		}
		b.WriteString("== status\n")
		for _, c := range sc {
			if c.Count > 0 {
				fmt.Fprintf(&b, "%s %s: %d\n", c.Project, c.Status, c.Count)
			}
		}
		b.WriteString("== waiting longest\n")
		for _, wt := range wl {
			fmt.Fprintf(&b, "%s  %d tasks, oldest %.1fh, average %.1fh\n", wt.Member, wt.Tasks, wt.Oldest, wt.Hours)
		}
		b.WriteString("== agents\n")
		for _, a := range out["agents"].([]agentState) {
			fmt.Fprintf(&b, "%s  %s %s\n", a.Handle, strings.ReplaceAll(a.State, "_", " "), a.Task)
		}
		fmt.Fprintf(&b, "== health\n%s\n", raw)
		return x.text(b.String())
	}
	return x.ok(out)
}

// hCycleChart returns a cycle's scope against done, day by day, in tasks
// and in points.
func (s *Server) hCycleChart(x *c) error {
	var cy core.Cycle
	if err := x.db.Get(x.ctx(), &cy, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil || !x.canProject(cy.ProjectID) {
		return errNotFound("cycle")
	}
	nm, err := x.names()
	if err != nil {
		return err
	}
	tasks, err := x.db.Tasks(x.ctx(), store.TaskFilter{CycleIDs: []string{cy.ID}, Archived: true, Limit: 5000})
	if err != nil {
		return err
	}
	type day struct {
		Date       string `json:"date"`
		Scope      int    `json:"scope"`
		Done       int    `json:"done"`
		Points     int    `json:"points"`
		PointsDone int    `json:"points_done"`
	}
	start, _ := time.Parse("2006-01-02", cy.StartsOn)
	end, _ := time.Parse("2006-01-02", cy.EndsOn)
	today := time.Now().UTC()
	var days []day
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		eod := d.AddDate(0, 0, 1).UnixMilli()
		row := day{Date: d.Format("2006-01-02")}
		if d.After(today) {
			days = append(days, day{Date: row.Date, Scope: -1}) // the future: nothing to plot yet
			continue
		}
		for _, t := range tasks {
			if t.CreatedAt >= eod || nm.statuses[t.StatusID].Category == core.CatCanceled && t.CanceledAt < eod {
				continue
			}
			row.Scope++
			row.Points += t.Estimate
			if t.CompletedAt != 0 && t.CompletedAt < eod {
				row.Done++
				row.PointsDone += t.Estimate
			}
		}
		days = append(days, row)
	}
	total, done := 0, 0
	for _, t := range tasks {
		if nm.statuses[t.StatusID].Category == core.CatCanceled {
			continue
		}
		total++
		if nm.statuses[t.StatusID].Category == core.CatDone {
			done++
		}
	}
	return x.ok(map[string]any{"cycle": cy, "days": days, "total": total, "done": done})
}

// everyTask reads all the tasks a filter matches, however many there are.
func (x *c) everyTask(f store.TaskFilter) ([]core.Task, error) {
	f.Sort, f.Limit = "created", 5000
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

// liveDeliveries counts deliveries of webhooks that still exist: what a
// deleted webhook left behind can no longer be sent again, so it is not
// something to act on.
func liveDeliveries(ctx context.Context, db store.DB, conds ...store.Cond) int {
	var hooks []core.Webhook
	if err := db.List(ctx, &hooks, store.Where(store.Live)); err != nil || len(hooks) == 0 {
		return 0
	}
	ids := make([]string, len(hooks))
	for i, h := range hooks {
		ids[i] = h.ID
	}
	// A press of "Test" is in the log, and is not a delivery that was lost.
	n, _ := db.Count(ctx, "webhook_deliveries", append(conds, store.In("webhook_id", ids), store.Ne("event_type", "webhook.test"))...)
	return n
}
