package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// ---- writes ----

type changesBody struct {
	Changes []engine.Change `json:"changes"`
	DryRun  bool            `json:"dry_run"`
	// A single change may be sent bare, without the changes list.
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Args     json.RawMessage `json:"args"`
	Approval string          `json:"approval"`
	For      string          `json:"for"`
}

var auditedPrefixes = []string{"member.", "agent.", "project.delete", "webhook.", "rule.", "integration.", "secret.", "workspace.update", "workspace.delete"}

// auditArgs is a change's arguments as the audit log keeps them: what was
// asked, with anything secret blanked out.
func auditArgs(raw json.RawMessage) any {
	var args map[string]json.RawMessage
	if json.Unmarshal(raw, &args) != nil {
		return nil
	}
	for _, k := range []string{"secret", "value", "password", "token", "credentials", "private_key"} {
		if v, ok := args[k]; ok && string(v) != `""` && string(v) != "null" {
			args[k] = json.RawMessage(`"•••"`)
		}
	}
	return args
}

// hChanges applies one change or a batch. A batch is all or nothing.
func (s *Server) hChanges(x *c) error {
	var b changesBody
	if err := x.body(&b); err != nil {
		return err
	}
	if len(b.Changes) == 0 && b.Type != "" {
		b.Changes = []engine.Change{{ID: b.ID, Type: b.Type, Args: b.Args, Approval: b.Approval, For: b.For}}
	}
	dry := b.DryRun || truthyParam(x.r.URL.Query(), "dry_run")
	res, err := s.eng.Batch(x.ctx(), x.ws.ID, x.actor, b.Changes, dry)
	if err != nil {
		return err
	}
	withEvents := truthyParam(x.r.URL.Query(), "events") || dry
	var seq int64
	for i, r := range res {
		if r.Seq > seq {
			seq = r.Seq
		}
		if dry || r.Duplicate {
			continue
		}
		for _, p := range auditedPrefixes {
			if strings.HasPrefix(r.Type, p) {
				s.audit(x.r, x.ws.ID, x.user, r.Type, strings.SplitN(r.Type, ".", 2)[0], r.Ref, auditArgs(b.Changes[i].Args))
			}
		}
		if b.Changes[i].Approval != "" {
			s.audit(x.r, x.ws.ID, x.user, "approval.used", "decision", b.Changes[i].Approval, map[string]string{"change": r.Type})
		}
	}
	if !withEvents {
		for _, r := range res {
			r.Events = nil
		}
	}
	if !dry && len(res) > 0 {
		last := res[len(res)-1]
		s.touchPresence(x, strings.TrimSpace(last.Type+" "+last.Key))
	}
	out := map[string]any{"results": res, "seq": seq}
	if dry {
		out["dry_run"] = true
	}
	return x.ok(out)
}

func truthyParam(v url.Values, name string) bool {
	return v.Has(name) && truthy(v.Get(name))
}

// ---- the web app's starting copy ----

// hBootstrap returns the workspace as rows, for a client that keeps a local
// copy and then follows the feed from "seq".
func (s *Server) hBootstrap(x *c) error {
	ctx := x.ctx()
	// Read the position first: anything committed after it will also come
	// through the feed, and applying an event twice is harmless.
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	out := map[string]any{"seq": ws.Seq, "workspace": ws, "me": x.member, "user": x.user, "server_time": time.Now().UnixMilli(), "version": s.cfg.Version}
	inScope := func(projectID string) bool { return x.canProject(projectID) }

	var members []core.Member
	var projects []core.Project
	var statuses []core.Status
	var labels []core.Label
	var epics []core.Epic
	var milestones []core.Milestone
	var cycles []core.Cycle
	var views []core.View
	var templates []core.Template
	var prefs []core.Preference
	var decisions []core.Decision
	var options []core.Option
	var relations []core.Relation
	var notes []core.Notification
	var watchers []core.Watcher
	var resources []core.Resource
	var claims []core.ResourceClaim
	var docs []core.Doc
	var sessions []core.AgentSession
	live := store.Where(store.Live)
	for _, load := range []func() error{
		func() error { return x.db.List(ctx, &members, store.Q{Order: "handle"}) },
		func() error { return x.db.List(ctx, &projects, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return x.db.List(ctx, &statuses, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return x.db.List(ctx, &labels, store.Q{Where: live.Where, Order: "name"}) },
		func() error { return x.db.List(ctx, &epics, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return x.db.List(ctx, &milestones, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return x.db.List(ctx, &cycles, store.Q{Where: live.Where, Order: "starts_on"}) },
		func() error { return x.db.List(ctx, &views, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return x.db.List(ctx, &templates, store.Q{Where: live.Where, Order: "name"}) },
		func() error { return x.db.List(ctx, &prefs, live) },
		func() error { return x.db.List(ctx, &decisions, store.Q{Where: live.Where, Order: "created_seq"}) },
		func() error { return x.db.List(ctx, &options, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return x.db.List(ctx, &relations, store.Q{}) },
		func() error {
			return x.db.List(ctx, &notes, store.Q{Where: []store.Cond{store.Eq("user_id", x.member.UserID), store.Null("archived_at")}, Order: "-seq", Limit: 300})
		},
		func() error { return x.db.List(ctx, &watchers, store.Where(store.Eq("user_id", x.member.UserID))) },
		func() error { return x.db.List(ctx, &resources, live) },
		func() error { return x.db.List(ctx, &claims, store.Where(store.Ne("state", "released"))) },
		func() error { return x.db.List(ctx, &docs, store.Q{Where: live.Where, Order: "rank"}) },
		func() error {
			return x.db.List(ctx, &sessions, store.Q{Where: []store.Cond{store.Gte("started_at", time.Now().Add(-7*24*time.Hour).UnixMilli())}, Order: "-started_at", Limit: 300})
		},
	} {
		if err := load(); err != nil {
			return err
		}
	}
	// part=open brings the open work, which is what the first screen needs;
	// part=rest brings what is done, canceled or archived, to be asked for in
	// the background. Without part, everything comes at once.
	part := x.r.URL.Query().Get("part")
	want := store.TaskFilter{ProjectIDs: x.projects, Archived: true, Limit: 5000, Sort: "created"}
	switch part {
	case "":
	case "open":
		want.Open, want.Archived = true, false
	case "rest":
		want.Closed = true
	default:
		return &engine.Error{Code: engine.CodeInvalid, Field: "part", Message: "unknown part " + part, Allowed: []string{"open", "rest"}}
	}
	tasks, err := x.db.Tasks(ctx, want)
	if err != nil {
		return err
	}
	for more := tasks; len(more) == 5000; {
		want.Offset = len(tasks)
		if more, err = x.db.Tasks(ctx, want); err != nil {
			return err
		}
		tasks = append(tasks, more...)
	}
	taskIDs := map[string]bool{}
	for i := range tasks {
		tasks[i].Description = "" // loaded when the task is opened
		taskIDs[tasks[i].ID] = true
	}
	byDecision := map[string][]core.Option{}
	for _, o := range options {
		byDecision[o.DecisionID] = append(byDecision[o.DecisionID], o)
	}
	decisions = keep(decisions, func(d core.Decision) bool { return taskIDs[d.TaskID] })
	for i := range decisions {
		decisions[i].Options = byDecision[decisions[i].ID]
	}
	s.withResponsible(ctx, members)
	out["members"] = members
	out["projects"] = keep(projects, func(p core.Project) bool { return inScope(p.ID) })
	out["statuses"] = keep(statuses, func(v core.Status) bool { return inScope(v.ProjectID) })
	out["labels"] = keep(labels, func(v core.Label) bool { return inScope(v.ProjectID) })
	out["epics"] = keep(epics, func(v core.Epic) bool { return inScope(v.ProjectID) })
	epicOK := map[string]bool{}
	for _, e := range epics {
		epicOK[e.ID] = inScope(e.ProjectID)
	}
	out["milestones"] = keep(milestones, func(v core.Milestone) bool { return epicOK[v.EpicID] })
	out["cycles"] = keep(cycles, func(v core.Cycle) bool { return inScope(v.ProjectID) })
	out["views"] = keep(views, func(v core.View) bool { return (v.Shared || v.OwnerID == x.member.UserID) && inScope(v.ProjectID) })
	out["templates"] = keep(templates, func(v core.Template) bool { return inScope(v.ProjectID) })
	out["preferences"] = keep(prefs, func(v core.Preference) bool { return inScope(v.ProjectID) })
	// The files shown on decisions and their options, so a list can show a
	// decision's pictures without opening its task.
	var atts []core.Attachment
	if err := x.db.List(ctx, &atts, store.Q{Where: []store.Cond{store.In("subject_type", []string{"decision", "decision_option"}), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	atts = keep(atts, func(a core.Attachment) bool { return taskIDs[a.TaskID] })
	if len(atts) > 0 {
		ids := make([]string, len(atts))
		for i, a := range atts {
			ids[i] = a.FileID
		}
		var files []core.File
		if err := x.db.List(ctx, &files, store.Where(store.In("id", ids))); err != nil {
			return err
		}
		byID := map[string]core.File{}
		for _, f := range files {
			f.URL = "/f/" + f.ID + "/" + url.PathEscape(f.Name)
			if f.PreviewKey != "" {
				f.PreviewURL = "/f/" + f.ID + "/preview"
			}
			byID[f.ID] = f
		}
		for i := range atts {
			if f, ok := byID[atts[i].FileID]; ok {
				atts[i].File = &f
			}
		}
	}
	out["attachments"] = atts
	out["tasks"] = tasks
	out["decisions"] = decisions
	relations = keep(relations, func(r core.Relation) bool { return taskIDs[r.TaskID] || taskIDs[r.RelatedTaskID] })
	if part == "rest" {
		// Only what part=open left out: the closed tasks and what hangs on them.
		return x.ok(map[string]any{"seq": out["seq"], "part": part, "tasks": tasks, "decisions": decisions, "attachments": atts, "relations": relations})
	}
	if part == "open" {
		out["part"] = part
		out["rest"], _ = x.db.CountTasks(ctx, store.TaskFilter{ProjectIDs: x.projects, Archived: true, Closed: true})
	}
	out["relations"] = relations
	out["notifications"] = notes
	out["watchers"] = watchers
	out["resources"] = resources
	out["claims"] = claims
	out["docs"] = keep(docs, func(d core.Doc) bool { return engine.CanSeeDoc(d, x.member.UserID) && inScope(d.ProjectID) })
	out["sessions"] = sessions
	return x.ok(out)
}

func keep[T any](list []T, ok func(T) bool) []T {
	out := make([]T, 0, len(list))
	for _, v := range list {
		if ok(v) {
			out = append(out, v)
		}
	}
	return out
}

// ---- orient ----

// hMe answers "who am I": identity, role, scope, what needs approval, the
// budget left, and where the caller's cursors stand.
func (s *Server) hMe(x *c) error {
	ctx := x.ctx()
	nm, err := x.names()
	if err != nil {
		return err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	out := map[string]any{
		"handle": "@" + x.member.Handle, "name": x.member.Name, "kind": x.member.Kind, "role": x.member.Role, "user_id": x.member.UserID,
		"workspace": map[string]any{"slug": ws.Slug, "name": ws.Name}, "seq": ws.Seq, "server_time": time.Now().UTC().Format(time.RFC3339),
		"version": s.cfg.Version,
	}
	var keys []string
	for _, p := range nm.projects {
		if p.DeletedAt == 0 && p.ArchivedAt == 0 && x.canProject(p.ID) {
			keys = append(keys, p.Key)
		}
	}
	sort.Strings(keys)
	out["projects"] = keys
	if x.actor.ReadOnly || (x.member.Scope != nil && x.member.Scope.ReadOnly) {
		out["read_only"] = true
	}
	if sc := x.member.Scope; sc != nil && len(sc.NeedsApproval) > 0 {
		out["needs_approval"] = sc.NeedsApproval
	}
	if x.member.Kind == core.KindAgent {
		out["responsible"] = nm.handle(x.user.ResponsibleID)
		if b := x.member.Budget; b != nil {
			cost, minutes, err := s.eng.Usage(ctx, x.db, x.member.UserID, weekStart(time.Now()))
			if err != nil {
				return err
			}
			bud := map[string]any{}
			if b.CostMicros > 0 {
				bud["cost_limit"], bud["cost_used"], bud["cost_left"] = money(b.CostMicros), money(cost), money(max(0, b.CostMicros-cost))
			}
			if b.Minutes > 0 {
				bud["minutes_limit"], bud["minutes_used"], bud["minutes_left"] = b.Minutes, minutes, max(0, b.Minutes-minutes)
			}
			bud["resets"] = time.UnixMilli(weekStart(time.Now())).AddDate(0, 0, 7).UTC().Format("2006-01-02")
			out["budget"] = bud
		}
	}
	unread, err := x.db.Count(ctx, "notifications", store.Eq("user_id", x.member.UserID), store.Null("read_at"))
	if err != nil {
		return err
	}
	out["unread"] = unread
	var cursors []core.Cursor
	if err := x.db.List(ctx, &cursors, store.Where(store.Eq("user_id", x.member.UserID))); err != nil {
		return err
	}
	cm := map[string]int64{}
	for _, cu := range cursors {
		cm[cu.Name] = cu.Seq
	}
	out["cursors"] = cm
	var prefs []core.Preference
	if err := x.db.List(ctx, &prefs, store.Where(store.Live, store.Null("retired_at"), store.Null("project_id"))); err != nil {
		return err
	}
	var rules []string
	for _, p := range prefs {
		rules = append(rules, p.Body)
	}
	if len(rules) > 0 {
		out["standing_preferences"] = rules
	}
	if x.wantText() {
		var b strings.Builder
		fmt.Fprintf(&b, "you are %s (%s, %s) in %s\n", out["handle"], x.member.Kind, x.member.Role, ws.Slug)
		fmt.Fprintf(&b, "projects: %s\n", strings.Join(keys, ", "))
		if v, ok := out["responsible"]; ok {
			fmt.Fprintf(&b, "responsible: %s\n", v)
		}
		if v, ok := out["needs_approval"]; ok {
			fmt.Fprintf(&b, "needs approval: %s\n", strings.Join(v.([]string), ", "))
		}
		if out["read_only"] == true {
			b.WriteString("read-only\n")
		}
		if v, ok := out["budget"]; ok {
			raw, _ := json.Marshal(v)
			fmt.Fprintf(&b, "budget: %s\n", raw)
		}
		fmt.Fprintf(&b, "unread: %d   seq: %d   cursors: %v\n", unread, ws.Seq, cm)
		for _, r := range rules {
			b.WriteString("rule: " + r + "\n")
		}
		return x.text(b.String())
	}
	return x.ok(out)
}

func weekStart(t time.Time) int64 {
	t = t.UTC()
	wd := (int(t.Weekday()) + 6) % 7
	return time.Date(t.Year(), t.Month(), t.Day()-wd, 0, 0, 0, 0, time.UTC).UnixMilli()
}

func money(micros int64) string { return fmt.Sprintf("%.2f", float64(micros)/1e6) }

type inboxItem struct {
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	By      string `json:"by"`
	Task    string `json:"task,omitempty"`
	Title   string `json:"title,omitempty"`
	Snippet string `json:"snippet,omitempty"`
	At      string `json:"at"`
	Read    bool   `json:"read,omitempty"`
}

func (i inboxItem) line() string {
	l := fmt.Sprintf("#%d %s %s %s: %s", i.Seq, i.At, i.By, i.Type, i.Title)
	if i.Snippet != "" && i.Snippet != i.Title {
		l += " — " + i.Snippet
	}
	return l
}

func (x *c) inboxItems(unreadOnly bool, limit int) ([]inboxItem, error) {
	nm, err := x.names()
	if err != nil {
		return nil, err
	}
	conds := []store.Cond{store.Eq("user_id", x.member.UserID), store.Null("archived_at")}
	if unreadOnly {
		conds = append(conds, store.Null("read_at"))
	}
	var ns []core.Notification
	if err := x.db.List(x.ctx(), &ns, store.Q{Where: conds, Order: "-seq", Limit: limit}); err != nil {
		return nil, err
	}
	out := make([]inboxItem, len(ns))
	for i, n := range ns {
		it := inboxItem{ID: n.ID, Seq: n.Seq, Type: n.Type, By: nm.handle(n.ActorID), Title: n.Title, Snippet: n.Snippet, At: when(n.CreatedAt), Read: n.ReadAt != 0}
		if n.TaskID != "" {
			it.Task = strings.SplitN(n.Title, " ", 2)[0]
		}
		out[i] = it
	}
	return out, nil
}

// hInbox lists what concerns the caller: mentions, assignments, picks,
// replies. Unread only unless all=1.
func (s *Server) hInbox(x *c) error {
	items, err := x.inboxItems(!truthyParam(x.r.URL.Query(), "all"), min(x.intParam("limit", 50), 500))
	if err != nil {
		return err
	}
	if since := int64(x.intParam("since", -1)); since >= 0 {
		items = keep(items, func(i inboxItem) bool { return i.Seq > since })
	}
	if x.wantText() {
		return x.text(lines(items, func(i inboxItem) string { return i.line() }, "inbox is empty"))
	}
	return x.ok(map[string]any{"inbox": items})
}

func lines[T any](items []T, line func(T) string, empty string) string {
	if len(items) == 0 {
		return empty + "\n"
	}
	var b strings.Builder
	for _, it := range items {
		b.WriteString(line(it) + "\n")
	}
	return b.String()
}

// hMyWork is the one call that starts a session: what is assigned to the
// caller, what waits on it, the questions asked of it, and its unread inbox.
func (s *Server) hMyWork(x *c) error {
	ctx := x.ctx()
	me := x.member.UserID
	assigned, err := x.db.Tasks(ctx, store.TaskFilter{AssigneeIDs: []string{me}, Open: true, ProjectIDs: x.projects, Sort: "priority", Limit: 200})
	if err != nil {
		return err
	}
	waiting, err := x.db.Tasks(ctx, store.TaskFilter{WaitingOnID: me, Open: true, ProjectIDs: x.projects, Sort: "-activity", Limit: 200})
	if err != nil {
		return err
	}
	av, err := x.taskViews(assigned, false)
	if err != nil {
		return err
	}
	wv, err := x.taskViews(waiting, false)
	if err != nil {
		return err
	}
	var asked []core.Decision
	if err := x.db.List(ctx, &asked, store.Q{Where: []store.Cond{store.Eq("asked_id", me), store.Eq("state", core.StateOpen), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	dv, err := x.decisionViews(asked, false)
	if err != nil {
		return err
	}
	inbox, err := x.inboxItems(true, 50)
	if err != nil {
		return err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	if x.wantText() {
		var b strings.Builder
		fmt.Fprintf(&b, "== waiting on you (%d)\n%s", len(wv), lines(wv, taskView.line, "nothing"))
		if len(dv) > 0 {
			fmt.Fprintf(&b, "== questions asked of you (%d)\n", len(dv))
			for _, d := range dv {
				fmt.Fprintf(&b, "%s  %s  (id=%s)\n", d.Task, oneLine(d.Question, 140), d.ID)
			}
		}
		fmt.Fprintf(&b, "== assigned to you (%d)\n%s", len(av), lines(av, taskView.line, "nothing"))
		fmt.Fprintf(&b, "== unread inbox (%d)\n%s", len(inbox), lines(inbox, inboxItem.line, "nothing"))
		fmt.Fprintf(&b, "seq: %d\n", ws.Seq)
		return x.text(b.String())
	}
	return x.ok(map[string]any{"waiting_on_me": wv, "asked_of_me": dv, "assigned": av, "inbox": inbox, "seq": ws.Seq})
}

// ---- tasks ----

var listFields = []string{"key", "title", "status", "priority", "assignee", "waiting_on", "held_by", "labels", "due_on", "parent", "seq"}

// hTasks answers a task query. count=1 returns only how many match.
func (s *Server) hTasks(x *c) error {
	q, err := x.queryFromRequest()
	if err != nil {
		return err
	}
	f, err := x.filter(q)
	if err != nil {
		return err
	}
	v := x.r.URL.Query()
	if truthyParam(v, "count") {
		n, err := x.db.CountTasks(x.ctx(), f)
		if err != nil {
			return err
		}
		if x.wantText() {
			return x.text(fmt.Sprintf("%d\n", n))
		}
		return x.ok(map[string]any{"count": n})
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	if f.Limit > 1000 {
		f.Limit = 1000
	}
	// cursor= continues a list from where the last page ended: after the
	// last row it gave, in the list's own order. Whatever changes, closes or
	// is reordered meanwhile, no row comes twice and none in between is
	// skipped. The token also holds where the feed stood when the first page
	// was read: tasks made since are left for the next read.
	type cursor struct {
		K    []any  `json:"k"`
		S    int64  `json:"s"`
		Sort string `json:"q"`
	}
	if tok := v.Get("cursor"); tok != "" {
		var cur cursor
		raw, err := base64.RawURLEncoding.DecodeString(tok)
		if err != nil || json.Unmarshal(raw, &cur) != nil || len(cur.K) != len(store.TaskSortKeys[f.Sort]) || cur.Sort != f.Sort {
			return &engine.Error{Code: engine.CodeInvalid, Field: "cursor", Message: "this cursor does not belong to this list (same filters and sort as the page it came from); start again without one"}
		}
		for i, k := range cur.K {
			// Whole numbers went through JSON as floats.
			if n, ok := k.(float64); ok && n == float64(int64(n)) {
				cur.K[i] = int64(n)
			}
		}
		f.After, f.MadeUpTo, f.Offset = cur.K, cur.S, 0
	}
	limit := f.Limit
	f.Limit++ // one extra row says whether there are more
	tasks, err := x.db.Tasks(x.ctx(), f)
	if err != nil {
		return err
	}
	more := len(tasks) > limit
	if more {
		tasks = tasks[:limit]
	}
	next := ""
	if more {
		cur := cursor{S: f.MadeUpTo, Sort: f.Sort}
		if cur.S == 0 {
			var ws core.Workspace
			if err := x.s.st.Get(x.ctx(), &ws, store.Eq("id", x.ws.ID)); err == nil {
				cur.S = ws.Seq
			}
		}
		last := tasks[len(tasks)-1]
		for _, k := range store.TaskSortKeys[f.Sort] {
			cur.K = append(cur.K, k.Val(last))
		}
		raw, _ := json.Marshal(cur)
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	if truthyParam(v, "raw") {
		return x.ok(map[string]any{"tasks": tasks, "more": more})
	}
	x.narrowedAlready()
	fields := splitList(v.Get("fields"))
	views, err := x.taskViews(tasks, has(fields, "description") || has(fields, "id") || has(fields, "project"))
	if err != nil {
		return err
	}
	if x.wantText() {
		out := lines(views, taskView.line, "no tasks match")
		if more {
			out += fmt.Sprintf("… more: add cursor=%s\n", next)
		}
		return x.text(out)
	}
	if len(fields) == 0 {
		fields = listFields
	}
	out := map[string]any{"tasks": pick(views, fields)}
	if more {
		out["next_offset"] = f.Offset + limit
		out["next_cursor"] = next
	}
	return x.ok(out)
}

func (x *c) fileURL(f core.File) (string, string) {
	u := x.s.cfg.BaseURL + "/f/" + f.ID + "/" + url.PathEscape(f.Name)
	preview := ""
	if f.PreviewKey != "" {
		preview = x.s.cfg.BaseURL + "/f/" + f.ID + "/preview"
	}
	return u, preview
}

// attachments loads the attachments in a task with their files, by subject.
func (x *c) attachments(conds ...store.Cond) (map[string][]attachmentView, []core.Attachment, error) {
	var atts []core.Attachment
	if err := x.db.List(x.ctx(), &atts, store.Q{Where: append(conds, store.Live), Order: "rank"}); err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(atts))
	for i, a := range atts {
		ids[i] = a.FileID
	}
	var files []core.File
	if len(ids) > 0 {
		if err := x.db.List(x.ctx(), &files, store.Where(store.In("id", ids))); err != nil {
			return nil, nil, err
		}
	}
	byID := map[string]core.File{}
	for _, f := range files {
		f.URL, f.PreviewURL = x.fileURL(f)
		byID[f.ID] = f
	}
	out := map[string][]attachmentView{}
	for i, a := range atts {
		f := byID[a.FileID]
		atts[i].File = &f
		out[a.SubjectID] = append(out[a.SubjectID], attachmentView{ID: a.ID, Name: f.Name, Type: f.ContentType, Size: f.Size, URL: f.URL,
			Preview: f.PreviewURL, Role: a.Role, Caption: a.Caption})
	}
	return out, atts, nil
}

// decisionViews names decisions, numbering them within their task.
func (x *c) decisionViews(ds []core.Decision, withFiles bool) ([]decisionView, error) {
	if len(ds) == 0 {
		return nil, nil
	}
	nm, err := x.names()
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(ds))
	taskIDs := map[string]bool{}
	for i, d := range ds {
		ids[i] = d.ID
		taskIDs[d.TaskID] = true
	}
	var opts []core.Option
	if err := x.db.List(x.ctx(), &opts, store.Q{Where: []store.Cond{store.In("decision_id", ids), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	files := map[string][]attachmentView{}
	counts := map[string]int{}
	var tids []string
	for t := range taskIDs {
		tids = append(tids, t)
	}
	if withFiles {
		if files, _, err = x.attachments(store.In("task_id", tids)); err != nil {
			return nil, err
		}
		rows, err := x.db.Tally(x.ctx(), "comments", []string{"subject_id"}, store.In("task_id", tids), store.Eq("subject_type", "decision_option"), store.Live)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			counts[r.Keys[0]] = r.Count
		}
	}
	keys := map[string]string{}
	ts, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: tids, Archived: true, Limit: 5000})
	if err != nil {
		return nil, err
	}
	for _, t := range ts {
		keys[t.ID] = t.Key
	}
	ordinal := map[string]int{}
	out := make([]decisionView, len(ds))
	for i, d := range ds {
		ordinal[d.TaskID]++
		v := decisionView{N: ordinal[d.TaskID], ID: d.ID, Task: keys[d.TaskID], TaskID: d.TaskID, DeletedAt: d.DeletedAt, Kind: d.Kind, Question: d.Question, Details: d.Details, Action: d.Action,
			State: d.State, By: nm.handle(d.CreatedBy), Asked: nm.handle(d.AskedID), Recommendation: d.Recommendation, Outcome: d.Outcome,
			Note: d.OutcomeNote, DecidedBy: nm.handle(d.DecidedBy), DecidedAt: when(d.DecidedAt), UnclearNote: d.UnclearNote, AskedAt: when(d.CreatedAt)}
		n := 0
		for _, o := range opts {
			if o.DecisionID != d.ID {
				continue
			}
			n++
			v.Options = append(v.Options, optionView{N: n, ID: o.ID, Label: o.Label, Description: o.Description, Attachments: files[o.ID], Comments: counts[o.ID]})
			if o.ID == d.RecommendedOptionID {
				v.Recommended = n
			}
			if o.ID == d.PickedOptionID {
				v.Picked, v.PickedLabel = n, o.Label
			}
		}
		out[i] = v
	}
	return out, nil
}

// detail builds everything about one task in its named form.
func (x *c) detail(t core.Task, maxChars int) (taskDetail, error) {
	ctx := x.ctx()
	var d taskDetail
	nm, err := x.names()
	if err != nil {
		return d, err
	}
	var ws core.Workspace
	if err := x.s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return d, err
	}
	d.Seq = ws.Seq
	tv, err := x.taskViews([]core.Task{t}, true)
	if err != nil {
		return d, err
	}
	d.Task = tv[0]
	if t.Budget != nil {
		// What agents have spent of the task's own budget so far.
		var runs []core.AgentSession
		if err := x.db.List(ctx, &runs, store.Where(store.Eq("task_id", t.ID))); err != nil {
			return d, err
		}
		spent := core.Budget{}
		now := time.Now().UnixMilli()
		for _, r := range runs {
			spent.CostMicros += r.CostMicros
			end := r.EndedAt
			if end == 0 {
				end = now
			}
			spent.Minutes += (end - r.StartedAt) / 60_000
		}
		d.Task.Spent = &spent
	}
	d.Task.Description, d.Task.Truncated = cut(d.Task.Description, maxChars)
	subs, err := x.db.Tasks(ctx, store.TaskFilter{ParentID: t.ID, Sort: "rank", Limit: 500})
	if err != nil {
		return d, err
	}
	if d.Subtasks, err = x.taskViews(subs, false); err != nil {
		return d, err
	}
	var ds []core.Decision
	if err := x.db.List(ctx, &ds, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "rank"}); err != nil {
		return d, err
	}
	if d.Decisions, err = x.decisionViews(ds, true); err != nil {
		return d, err
	}
	files, _, err := x.attachments(store.Eq("task_id", t.ID))
	if err != nil {
		return d, err
	}
	d.Attachments = files[t.ID]
	// "option 2 of decision 1" says where a comment sits.
	where := map[string]string{}
	for _, dv := range d.Decisions {
		where[dv.ID] = fmt.Sprintf("decision %d", dv.N)
		for _, o := range dv.Options {
			where[o.ID] = fmt.Sprintf("option %d of decision %d", o.N, dv.N)
		}
	}
	var cms []core.Comment
	if err := x.db.List(ctx, &cms, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_seq"}); err != nil {
		return d, err
	}
	for _, cm := range cms {
		v := commentView{ID: cm.ID, Seq: cm.CreatedSeq, By: nm.handle(cm.AuthorID), At: when(cm.CreatedAt), On: where[cm.SubjectID],
			ReplyTo: cm.ParentID, Evidence: cm.Evidence, Attachments: files[cm.ID], Edited: cm.EditedAt != 0}
		if cm.Kind != "comment" {
			v.Kind = cm.Kind
		}
		v.Body, v.Truncated = cut(cm.Body, maxChars/2)
		d.Comments = append(d.Comments, v)
	}
	var out, in []core.Relation
	if err := x.db.List(ctx, &out, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return d, err
	}
	if err := x.db.List(ctx, &in, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return d, err
	}
	var otherIDs []string
	for _, r := range out {
		otherIDs = append(otherIDs, r.RelatedTaskID)
	}
	for _, r := range in {
		otherIDs = append(otherIDs, r.TaskID)
	}
	if len(otherIDs) > 0 {
		others, err := x.db.Tasks(ctx, store.TaskFilter{IDs: otherIDs, Archived: true, Limit: 1000})
		if err != nil {
			return d, err
		}
		byID := map[string]core.Task{}
		for _, o := range others {
			byID[o.ID] = o
		}
		add := func(r core.Relation, otherID, typ string) {
			if o, ok := byID[otherID]; ok {
				d.Relations = append(d.Relations, relationView{ID: r.ID, Type: typ, Task: o.Key, Title: o.Title, State: nm.statuses[o.StatusID].Name})
			}
		}
		for _, r := range out {
			add(r, r.RelatedTaskID, r.Type)
		}
		reverse := map[string]string{core.RelBlocks: "blocked_by", core.RelDuplicates: "duplicated_by", core.RelRelates: core.RelRelates}
		for _, r := range in {
			add(r, r.TaskID, reverse[r.Type])
		}
	}
	var links []core.TaskLink
	if err := x.db.List(ctx, &links, store.Where(store.Eq("task_id", t.ID), store.Live)); err != nil {
		return d, err
	}
	for _, l := range links {
		d.Links = append(d.Links, linkView{ID: l.ID, Kind: l.Kind, Ref: l.Ref, Repo: l.Repo, Title: l.Title, URL: l.URL, State: l.State, Checks: l.Checks, Data: l.Data})
	}
	var ws2 []core.Watcher
	if err := x.db.List(ctx, &ws2, store.Where(store.Eq("subject_id", t.ID))); err != nil {
		return d, err
	}
	for _, w := range ws2 {
		d.Watchers = append(d.Watchers, nm.handle(w.UserID))
	}
	sort.Strings(d.Watchers)
	return d, nil
}

// taskByRef loads a task the caller may read.
func (x *c) taskByRef(ref string) (core.Task, error) {
	t, err := x.resolver().Task(ref)
	if err != nil {
		return t, err
	}
	if !x.canProject(t.ProjectID) {
		return t, errNotFound("task " + ref)
	}
	return t, nil
}

func (x *c) maxChars() int {
	if truthyParam(x.r.URL.Query(), "full") {
		return 0
	}
	return x.intParam("max_chars", 6000)
}

// hTask returns one task with everything in it. since=N returns only what
// happened in it after feed position N. raw=1 returns rows, for the web app.
func (s *Server) hTask(x *c) error {
	t, err := x.taskByRef(x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	v := x.r.URL.Query()
	x.narrowedAlready()
	if since := x.intParam("since", -1); since >= 0 {
		evs, err := x.db.Events(x.ctx(), store.EventFilter{After: int64(since), ScopeType: "task", ScopeID: t.ID, Viewer: x.member.UserID, Limit: 500})
		if err != nil {
			return err
		}
		return x.events(evs, t.ActivitySeq, false)
	}
	if truthyParam(v, "raw") {
		return s.rawTask(x, t)
	}
	d, err := x.detail(t, x.maxChars())
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(d.text())
	}
	return x.ok(d)
}

// rawTask returns a task's rows as stored.
func (s *Server) rawTask(x *c, t core.Task) error {
	ctx := x.ctx()
	var cms []core.Comment
	var links []core.TaskLink
	var watchers []core.Watcher
	var sessions []core.AgentSession
	if err := x.db.List(ctx, &cms, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	if err := x.db.List(ctx, &links, store.Where(store.Eq("task_id", t.ID), store.Live)); err != nil {
		return err
	}
	if err := x.db.List(ctx, &watchers, store.Where(store.Eq("subject_id", t.ID))); err != nil {
		return err
	}
	if err := x.db.List(ctx, &sessions, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID)}, Order: "-started_at", Limit: 50}); err != nil {
		return err
	}
	_, atts, err := x.attachments(store.Eq("task_id", t.ID))
	if err != nil {
		return err
	}
	// Where this task, and each of its decisions, is mentioned: in pages,
	// in other tasks, in comments. Each says what it is called.
	targets := []string{t.ID}
	var ds []core.Decision
	if err := x.db.List(ctx, &ds, store.Where(store.Eq("task_id", t.ID), store.Live)); err != nil {
		return err
	}
	for _, d := range ds {
		targets = append(targets, d.ID)
	}
	var refs []core.Ref
	if err := x.db.List(ctx, &refs, store.Where(store.In("to_id", targets))); err != nil {
		return err
	}
	mentioned := x.namedRefs(refs)
	var rels, relsIn []core.Relation
	if err := x.db.List(ctx, &rels, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return err
	}
	if err := x.db.List(ctx, &relsIn, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return err
	}
	return x.ok(map[string]any{"task": t, "comments": cms, "links": links, "watchers": watchers, "attachments": atts, "sessions": sessions,
		"mentioned_in": mentioned, "relations": append(rels, relsIn...)})
}

// hContext is the context pack: one call with everything an agent needs to
// work on a task.
func (s *Server) hContext(x *c) error {
	ctx := x.ctx()
	t, err := x.taskByRef(x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	d, err := x.detail(t, x.maxChars())
	if err != nil {
		return err
	}
	nm, _ := x.names()
	out := map[string]any{"task": d}
	var b strings.Builder
	b.WriteString(d.text())

	// The chain of parents says what this task is part of.
	var parents []taskView
	for cur, depth := t.ParentID, 0; cur != "" && depth < 5; depth++ {
		var p core.Task
		if err := x.db.Get(ctx, &p, store.Eq("id", cur)); err != nil {
			break
		}
		pv, _ := x.taskViews([]core.Task{p}, true)
		pv[0].Description, pv[0].Truncated = cut(pv[0].Description, 1500)
		parents = append(parents, pv[0])
		cur = p.ParentID
	}
	if len(parents) > 0 {
		out["parents"] = parents
		b.WriteString("=== part of\n")
		for _, p := range parents {
			fmt.Fprintf(&b, "%s\n%s\n", p.line(), p.Description)
		}
	}
	if e, ok := nm.epics[t.EpicID]; ok {
		desc, _ := cut(e.Description, 2000)
		out["epic"] = map[string]any{"name": e.Name, "state": e.State, "target_on": e.TargetOn, "description": desc}
		fmt.Fprintf(&b, "=== epic: %s (%s", e.Name, e.State)
		if e.TargetOn != "" {
			b.WriteString(", target " + e.TargetOn)
		}
		b.WriteString(")\n" + desc + "\n")
	}
	// Standing preferences: the workspace's, the project's, and those tied
	// to this task's labels.
	var prefs []core.Preference
	if err := x.db.List(ctx, &prefs, store.Where(store.Live, store.Null("retired_at"))); err != nil {
		return err
	}
	var rules []string
	for _, p := range prefs {
		if p.ProjectID != "" && p.ProjectID != t.ProjectID {
			continue
		}
		if len(p.LabelIDs) > 0 {
			match := false
			for _, l := range p.LabelIDs {
				match = match || has(t.LabelIDs, l)
			}
			if !match {
				continue
			}
		}
		rules = append(rules, p.Body)
	}
	if len(rules) > 0 {
		out["standing_preferences"] = rules
		b.WriteString("=== standing preferences\n- " + strings.Join(rules, "\n- ") + "\n")
	}
	// Earlier answers in the same project guide later work.
	var picked []core.Decision
	if err := x.db.List(ctx, &picked, store.Q{Where: []store.Cond{store.Ne("state", core.StateOpen), store.Live}, Order: "-updated_seq", Limit: 200}); err != nil {
		return err
	}
	var recent []core.Decision
	for _, dc := range picked {
		if dc.TaskID == t.ID || len(recent) >= 8 {
			continue
		}
		var dt core.Task
		if err := x.db.Get(ctx, &dt, store.Eq("id", dc.TaskID)); err == nil && dt.ProjectID == t.ProjectID {
			recent = append(recent, dc)
		}
	}
	if rv, err := x.decisionViews(recent, false); err == nil && len(rv) > 0 {
		out["recent_decisions"] = rv
		b.WriteString("=== recent decisions in this project\n")
		for _, r := range rv {
			ans := r.Outcome
			if r.PickedLabel != "" {
				ans = r.PickedLabel
			}
			fmt.Fprintf(&b, "%s %q -> %s", r.Task, oneLine(r.Question, 100), ans)
			if r.Note != "" {
				b.WriteString(": " + oneLine(r.Note, 160))
			}
			b.WriteString("\n")
		}
	}
	// Docs this task mentions, or that mention it.
	var refs []core.Ref
	x.db.List(ctx, &refs, store.Where(store.Eq("from_scope_id", t.ID), store.Eq("to_type", "doc")))
	var back []core.Ref
	x.db.List(ctx, &back, store.Where(store.Eq("to_id", t.ID), store.Eq("from_scope_type", "doc")))
	docIDs := map[string]bool{}
	for _, r := range refs {
		docIDs[r.ToID] = true
	}
	for _, r := range back {
		docIDs[r.FromScopeID] = true
	}
	var docs []map[string]any
	for did := range docIDs {
		var doc core.Doc
		if err := x.db.Get(ctx, &doc, store.Eq("id", did), store.Live); err == nil && engine.CanSeeDoc(doc, x.member.UserID) {
			docs = append(docs, map[string]any{"id": doc.ID, "title": doc.Title, "url": s.cfg.BaseURL + "/" + x.ws.Slug + "/docs/" + doc.ID})
		}
	}
	if len(docs) > 0 {
		out["docs"] = docs
		b.WriteString("=== linked docs\n")
		for _, dc := range docs {
			fmt.Fprintf(&b, "%s  (doc %s)\n", dc["title"], dc["id"])
		}
	}
	if x.wantText() {
		return x.text(b.String())
	}
	return x.ok(out)
}

// ---- search, decision log, layout ----

func (s *Server) hSearch(x *c) error {
	v := x.r.URL.Query()
	hits, err := x.db.Search(x.ctx(), store.SearchQuery{Text: v.Get("q"), Kinds: splitList(v.Get("kind")), ProjectIDs: x.projects,
		Viewer: x.member.UserID, Limit: x.intParam("limit", 20)})
	if err != nil {
		return err
	}
	type hit struct {
		store.SearchHit
		Task string `json:"task,omitempty"`
		URL  string `json:"url"`
	}
	out := make([]hit, 0, len(hits))
	var taskIDs []string
	for _, h := range hits {
		if h.ScopeType == "task" {
			taskIDs = append(taskIDs, h.ScopeID)
		}
	}
	keys := map[string]string{}
	if len(taskIDs) > 0 {
		ts, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: taskIDs, Archived: true, Limit: 1000})
		if err != nil {
			return err
		}
		for _, t := range ts {
			keys[t.ID] = t.Key
		}
	}
	base := s.cfg.BaseURL + "/" + x.ws.Slug
	for _, h := range hits {
		hh := hit{SearchHit: h}
		switch h.ScopeType {
		case "task":
			if keys[h.ScopeID] == "" {
				continue // in the trash
			}
			hh.Task, hh.URL = keys[h.ScopeID], base+"/task/"+keys[h.ScopeID]
		case "doc":
			hh.URL = base + "/docs/" + h.ScopeID
		case "epic":
			hh.URL = base + "/epic/" + h.ScopeID
		}
		out = append(out, hh)
	}
	if x.wantText() {
		return x.text(lines(out, func(h hit) string {
			where := h.Task
			if where == "" {
				where = h.ScopeType + " " + h.ScopeID
			}
			title := strings.TrimSpace(strings.TrimPrefix(h.Title, where))
			return fmt.Sprintf("%s  %s  %s — %s", h.Kind, where, oneLine(title, 80), oneLine(h.Snippet, 160))
		}, "nothing found"))
	}
	return x.ok(map[string]any{"hits": out})
}

// hDecisions is the decision log: every question with the options shown,
// the choice, the reason and the date.
func (s *Server) hDecisions(x *c) error {
	v := x.r.URL.Query()
	conds := []store.Cond{store.Live}
	if truthyParam(v, "trash") {
		conds = []store.Cond{store.NotNull("deleted_at")}
	}
	switch st := v.Get("state"); st {
	case "", "answered":
		if truthyParam(v, "trash") {
			break // the trash holds decisions in any state
		}
		conds = append(conds, store.Ne("state", core.StateOpen))
	case "all":
	case core.StateOpen, core.StatePicked, core.StateSentBack:
		conds = append(conds, store.Eq("state", st))
	default:
		return &engine.Error{Code: engine.CodeInvalid, Field: "state", Message: "unknown state " + st, Allowed: []string{"answered", "open", "picked", "sent_back", "all"}}
	}
	if since := x.intParam("since", -1); since >= 0 {
		conds = append(conds, store.Gt("updated_seq", int64(since))) // only what changed after that position
	}
	if q := v.Get("q"); q != "" {
		conds = append(conds, store.Like("question", "%"+strings.NewReplacer("%", "", "_", " ").Replace(q)+"%"))
	}
	if a := v.Get("asked"); a != "" {
		m, err := x.resolver().Member("asked", a)
		if err != nil {
			return err
		}
		conds = append(conds, store.Eq("asked_id", m.UserID))
	}
	var ds []core.Decision
	if err := x.db.List(x.ctx(), &ds, store.Q{Where: conds, Order: "-updated_seq", Limit: min(x.intParam("limit", 50), 500), Offset: x.intParam("offset", 0)}); err != nil {
		return err
	}
	// Keep to the projects asked for, and to those the caller may read.
	var projectIDs []string
	for _, ref := range splitList(v.Get("project")) {
		p, err := x.resolver().Project(ref)
		if err != nil {
			return err
		}
		projectIDs = append(projectIDs, p.ID)
	}
	if len(projectIDs) > 0 || x.projects != nil {
		var tids []string
		for _, d := range ds {
			tids = append(tids, d.TaskID)
		}
		ts, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: tids, Archived: true, Limit: 5000})
		if err != nil {
			return err
		}
		okTask := map[string]bool{}
		for _, t := range ts {
			okTask[t.ID] = x.canProject(t.ProjectID) && (len(projectIDs) == 0 || has(projectIDs, t.ProjectID))
		}
		ds = keep(ds, func(d core.Decision) bool { return okTask[d.TaskID] })
	}
	views, err := x.decisionViews(ds, false)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(lines(views, func(d decisionView) string {
			ans := d.Outcome
			if d.PickedLabel != "" {
				ans = fmt.Sprintf("%s (%s)", d.PickedLabel, d.Outcome)
			}
			if d.State == core.StateOpen {
				ans = "open, asked " + d.Asked
			}
			at := d.DecidedAt
			if at == "" {
				at = d.AskedAt
			}
			l := fmt.Sprintf("%s  %s  %q -> %s", at, d.Task, oneLine(d.Question, 100), ans)
			if d.Note != "" {
				l += ": " + oneLine(d.Note, 200)
			}
			return l
		}, "no decisions"))
	}
	return x.ok(map[string]any{"decisions": views})
}

// hLayout describes one project: its statuses, labels, members, epics,
// cycles and templates, by name.
func (s *Server) hLayout(x *c) error {
	p, err := x.resolver().Project(x.r.PathValue("key"))
	if err != nil {
		return err
	}
	if !x.canProject(p.ID) {
		return errNotFound("project " + p.Key)
	}
	nm, err := x.names()
	if err != nil {
		return err
	}
	type named struct {
		Name     string `json:"name"`
		Category string `json:"category,omitempty"`
		Default  bool   `json:"default,omitempty"`
		State    string `json:"state,omitempty"`
		Role     string `json:"role,omitempty"`
		Kind     string `json:"kind,omitempty"`
		Dates    string `json:"dates,omitempty"`
		Title    string `json:"title,omitempty"`
	}
	out := map[string][]named{}
	var sts []core.Status
	for _, st := range nm.statuses {
		if st.ProjectID == p.ID && st.DeletedAt == 0 {
			sts = append(sts, st)
		}
	}
	sort.Slice(sts, func(i, j int) bool { return sts[i].Rank < sts[j].Rank })
	for _, st := range sts {
		out["statuses"] = append(out["statuses"], named{Name: st.Name, Category: st.Category, Default: st.IsDefault})
	}
	for _, l := range nm.labels {
		if (l.ProjectID == "" || l.ProjectID == p.ID) && l.DeletedAt == 0 {
			out["labels"] = append(out["labels"], named{Name: l.Name})
		}
	}
	for _, m := range nm.members {
		if m.RemovedAt == 0 {
			out["members"] = append(out["members"], named{Name: "@" + m.Handle, Role: string(m.Role), Kind: m.Kind, Title: m.Name})
		}
	}
	for _, e := range nm.epics {
		if e.ProjectID == p.ID && e.DeletedAt == 0 {
			out["epics"] = append(out["epics"], named{Name: e.Name, State: e.State, Dates: e.TargetOn})
		}
	}
	today := time.Now().UTC().Format("2006-01-02")
	for _, cy := range nm.cycles {
		if cy.ProjectID == p.ID && cy.DeletedAt == 0 && cy.EndsOn >= today {
			out["cycles"] = append(out["cycles"], named{Name: fmt.Sprint(cy.Number), Dates: cy.StartsOn + " to " + cy.EndsOn})
		}
	}
	var tpls []core.Template
	if err := x.db.List(x.ctx(), &tpls, store.Where(store.Live)); err != nil {
		return err
	}
	for _, t := range tpls {
		if t.ProjectID == "" || t.ProjectID == p.ID {
			out["templates"] = append(out["templates"], named{Name: t.Name})
		}
	}
	for k := range out {
		list := out[k]
		if k != "statuses" {
			sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
		}
	}
	if x.wantText() {
		var b strings.Builder
		fmt.Fprintf(&b, "project %s  %s\n", p.Key, p.Name)
		for _, k := range []string{"statuses", "labels", "members", "epics", "cycles", "templates"} {
			var parts []string
			for _, n := range out[k] {
				s := n.Name
				if n.Category != "" {
					s += " (" + n.Category + ")"
				}
				if n.Kind == core.KindAgent {
					s += " (agent)"
				}
				if n.Dates != "" {
					s += " (" + n.Dates + ")"
				}
				parts = append(parts, s)
			}
			if len(parts) > 0 {
				fmt.Fprintf(&b, "%s: %s\n", k, strings.Join(parts, ", "))
			}
		}
		return x.text(b.String())
	}
	return x.ok(map[string]any{"project": map[string]string{"key": p.Key, "name": p.Name, "description": p.Description}, "layout": out})
}

// withResponsible fills in, for each agent, the person who answers for it.
func (s *Server) withResponsible(ctx context.Context, members []core.Member) {
	var ids []string
	for _, m := range members {
		if m.Kind == core.KindAgent {
			ids = append(ids, m.UserID)
		}
	}
	if len(ids) == 0 {
		return
	}
	var users []core.User
	if err := s.st.List(ctx, &users, store.Where(store.In("id", ids))); err != nil {
		return
	}
	by := map[string]string{}
	for _, u := range users {
		by[u.ID] = u.ResponsibleID
	}
	for i := range members {
		members[i].ResponsibleID = by[members[i].UserID]
	}
}

// namedRef is one mention with what the mentioning thing is called.
type namedRef struct {
	core.Ref
	// Title is the page's title or the task's; Key the task's key, when the
	// mention is in a task or one of its comments.
	Title string `json:"title,omitempty"`
	Key   string `json:"key,omitempty"`
}

// namedRefs gives each mention the name of where it was made, leaving out
// those the caller may not see.
func (x *c) namedRefs(refs []core.Ref) []namedRef {
	out := []namedRef{}
	ctx := x.ctx()
	for _, r := range refs {
		nr := namedRef{Ref: r}
		switch r.FromScopeType {
		case "doc":
			var d core.Doc
			if err := x.db.Get(ctx, &d, store.Eq("id", r.FromScopeID), store.Live); err != nil || !engine.CanSeeDoc(d, x.member.UserID) || !x.canProject(d.ProjectID) {
				continue
			}
			nr.Title = d.Title
		case "task":
			var t core.Task
			if err := x.db.Get(ctx, &t, store.Eq("id", r.FromScopeID), store.Live); err != nil || !x.canProject(t.ProjectID) {
				continue
			}
			nr.Title, nr.Key = t.Title, t.Key
		}
		out = append(out, nr)
	}
	return out
}
