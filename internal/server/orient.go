package server

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowWhoAmI answers "who am I": identity, role, scope, what needs approval, the
// budget left, and where the caller's cursors stand.
func (s *Server) handleShowWhoAmI(x *c) error {
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
	keys := x.projectKeys(nm)
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
			bud, err := s.weekBudget(x, b)
			if err != nil {
				return err
			}
			out["budget"] = bud
		}
	}
	unread, err := x.db.Count(ctx, "notifications", store.Eq("user_id", x.member.UserID), store.Null("read_at"))
	if err != nil {
		return err
	}
	out["unread"] = unread
	cm, err := x.cursorSeqs()
	if err != nil {
		return err
	}
	out["cursors"] = cm
	rules, err := x.workspaceRules()
	if err != nil {
		return err
	}
	if len(rules) > 0 {
		out["standing_preferences"] = rules
	}
	if x.wantText() {
		return x.text(meText(out, ws, keys, cm, rules))
	}
	return x.ok(out)
}

// projectKeys lists, in order, the keys of the projects the caller may read.
func (x *c) projectKeys(nm *names) []string {
	var keys []string
	for _, p := range nm.projects {
		if p.DeletedAt == 0 && p.ArchivedAt == 0 && x.canProject(p.ID) {
			keys = append(keys, p.Key)
		}
	}
	sort.Strings(keys)
	return keys
}

// weekBudget says what an agent has used of its budget this week, what is
// left, and when the week starts over.
func (s *Server) weekBudget(x *c, b *core.Budget) (map[string]any, error) {
	cost, minutes, err := s.eng.Usage(x.ctx(), x.db, x.member.UserID, weekStart(time.Now()))
	if err != nil {
		return nil, err
	}
	bud := map[string]any{}
	if b.CostMicros > 0 {
		bud["cost_limit"], bud["cost_used"], bud["cost_left"] = money(b.CostMicros), money(cost), money(max(0, b.CostMicros-cost))
	}
	if b.Minutes > 0 {
		bud["minutes_limit"], bud["minutes_used"], bud["minutes_left"] = b.Minutes, minutes, max(0, b.Minutes-minutes)
	}
	bud["resets"] = time.UnixMilli(weekStart(time.Now())).AddDate(0, 0, 7).UTC().Format("2006-01-02")
	return bud, nil
}

// cursorSeqs is where each of the caller's cursors stands, by name.
func (x *c) cursorSeqs() (map[string]int64, error) {
	var cursors []core.Cursor
	if err := x.db.List(x.ctx(), &cursors, store.Where(store.Eq("user_id", x.member.UserID))); err != nil {
		return nil, err
	}
	cm := map[string]int64{}
	for _, cu := range cursors {
		cm[cu.Name] = cu.Seq
	}
	return cm, nil
}

// workspaceRules lists the standing preferences that hold in every project.
func (x *c) workspaceRules() ([]string, error) {
	var prefs []core.Preference
	if err := x.db.List(x.ctx(), &prefs, store.Where(store.Live, store.Null("retired_at"), store.Null("project_id"))); err != nil {
		return nil, err
	}
	var rules []string
	for _, p := range prefs {
		rules = append(rules, p.Body)
	}
	return rules, nil
}

// meText is handleShowWhoAmI's answer as lines of text.
func meText(out map[string]any, ws core.Workspace, keys []string, cursors map[string]int64, rules []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "you are %s (%s, %s) in %s\n", out["handle"], out["kind"], out["role"], ws.Slug)
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
	if bud, ok := out["budget"].(map[string]any); ok {
		var parts []string
		if _, ok := bud["cost_limit"]; ok {
			parts = append(parts, fmt.Sprintf("cost %v of %v used (%v left)", bud["cost_used"], bud["cost_limit"], bud["cost_left"]))
		}
		if _, ok := bud["minutes_limit"]; ok {
			parts = append(parts, fmt.Sprintf("%v of %v minutes used (%v left)", bud["minutes_used"], bud["minutes_limit"], bud["minutes_left"]))
		}
		fmt.Fprintf(&b, "budget this week: %s; resets %v\n", strings.Join(parts, ", "), bud["resets"])
	}
	fmt.Fprintf(&b, "unread: %d   seq: %d\n", out["unread"], ws.Seq)
	if len(cursors) > 0 {
		var names []string
		for name, seq := range cursors {
			names = append(names, fmt.Sprintf("%s=%d", name, seq))
		}
		sort.Strings(names)
		fmt.Fprintf(&b, "cursors: %s\n", strings.Join(names, " "))
	}
	for _, r := range rules {
		b.WriteString("rule: " + r + "\n")
	}
	return b.String()
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

// handleListInbox lists what concerns the caller: mentions, assignments, picks,
// replies. Unread only unless all=1.
func (s *Server) handleListInbox(x *c) error {
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

// handleShowMyWork is the one call that starts a session: what is assigned to the
// caller, what waits on it, the questions asked of it, and its unread inbox.
func (s *Server) handleShowMyWork(x *c) error {
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
