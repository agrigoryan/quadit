// Orientation: who am I (/me), what is mine to do (/my-work), and the inbox.

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

// handleShowWhoAmI answers "who am I": identity, role, scope, what needs approval, the
// budget left, and where the caller's cursors stand.
func (s *Server) handleShowWhoAmI(x *c) error {
	ctx := x.ctx()
	names, err := x.names(x.ctx())
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
	keys := x.projectKeys(names)
	out["projects"] = keys
	if x.actor.ReadOnly || (x.member.Scope != nil && x.member.Scope.ReadOnly) {
		out["read_only"] = true
	}
	if scope := x.member.Scope; scope != nil && len(scope.NeedsApproval) > 0 {
		out["needs_approval"] = scope.NeedsApproval
	}
	if x.member.Kind == core.KindAgent {
		out["responsible"] = names.handle(x.user.ResponsibleID)
		if limits := x.member.Budget; limits != nil {
			budget, err := x.weekBudget(ctx, limits)
			if err != nil {
				return err
			}
			out["budget"] = budget
		}
	}
	unread, err := x.db.Count(ctx, "notifications", store.Eq("user_id", x.member.UserID), store.Null("read_at"))
	if err != nil {
		return err
	}
	out["unread"] = unread
	cursors, err := x.cursorSeqs(x.ctx())
	if err != nil {
		return err
	}
	out["cursors"] = cursors
	rules, err := x.workspaceRules(x.ctx())
	if err != nil {
		return err
	}
	if len(rules) > 0 {
		out["standing_preferences"] = rules
	}
	if x.wantText() {
		return x.text(whoAmIText(out, ws, keys, cursors, rules))
	}
	return x.ok(out)
}

// projectKeys lists, in order, the keys of the projects the caller may read.
func (who *viewer) projectKeys(names *nameLookup) []string {
	var keys []string
	for _, project := range names.projects {
		if project.DeletedAt == 0 && project.ArchivedAt == 0 && who.canProject(project.ID) {
			keys = append(keys, project.Key)
		}
	}
	sort.Strings(keys)
	return keys
}

// weekBudget says what an agent has used of its budget this week, what is
// left, and when the week starts over.
func (who *viewer) weekBudget(ctx context.Context, limits *core.Budget) (map[string]any, error) {
	cost, minutes, err := who.agentUsage(ctx, who.db, who.member.UserID, weekStart(time.Now()))
	if err != nil {
		return nil, err
	}
	budget := map[string]any{}
	if limits.CostMicros > 0 {
		budget["cost_limit"], budget["cost_used"], budget["cost_left"] = formatMoney(limits.CostMicros), formatMoney(cost), formatMoney(max(0, limits.CostMicros-cost))
	}
	if limits.Minutes > 0 {
		budget["minutes_limit"], budget["minutes_used"], budget["minutes_left"] = limits.Minutes, minutes, max(0, limits.Minutes-minutes)
	}
	budget["resets"] = time.UnixMilli(weekStart(time.Now())).AddDate(0, 0, 7).UTC().Format("2006-01-02")
	return budget, nil
}

// cursorSeqs is where each of the caller's cursors stands, by name.
func (who *viewer) cursorSeqs(ctx context.Context) (map[string]int64, error) {
	var cursors []core.Cursor
	if err := who.db.List(ctx, &cursors, store.Where(store.Eq("user_id", who.member.UserID))); err != nil {
		return nil, err
	}
	seqs := map[string]int64{}
	for _, cursor := range cursors {
		seqs[cursor.Name] = cursor.Seq
	}
	return seqs, nil
}

// workspaceRules lists the standing preferences that hold in every project.
func (who *viewer) workspaceRules(ctx context.Context) ([]string, error) {
	var prefs []core.Preference
	if err := who.db.List(ctx, &prefs, store.Where(store.Live, store.Null("retired_at"), store.Null("project_id"))); err != nil {
		return nil, err
	}
	var rules []string
	for _, pref := range prefs {
		rules = append(rules, pref.Body)
	}
	return rules, nil
}

// whoAmIText is handleShowWhoAmI's answer as lines of text: who, where,
// what may be done, the budget, what is unread, the cursors and the rules.
func whoAmIText(out map[string]any, ws core.Workspace, keys []string, cursors map[string]int64, rules []string) string {
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
	if budget, ok := out["budget"].(map[string]any); ok {
		var parts []string
		if _, ok := budget["cost_limit"]; ok {
			parts = append(parts, fmt.Sprintf("cost %v of %v used (%v left)", budget["cost_used"], budget["cost_limit"], budget["cost_left"]))
		}
		if _, ok := budget["minutes_limit"]; ok {
			parts = append(parts, fmt.Sprintf("%v of %v minutes used (%v left)", budget["minutes_used"], budget["minutes_limit"], budget["minutes_left"]))
		}
		fmt.Fprintf(&b, "budget this week: %s; resets %v\n", strings.Join(parts, ", "), budget["resets"])
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

// weekStart is the start of the week (Monday, UTC) a moment falls in.
func weekStart(t time.Time) int64 {
	t = t.UTC()
	wd := (int(t.Weekday()) + 6) % 7
	return time.Date(t.Year(), t.Month(), t.Day()-wd, 0, 0, 0, 0, time.UTC).UnixMilli()
}

// formatMoney is an amount in millionths of a dollar, in dollars and cents.
func formatMoney(micros int64) string { return fmt.Sprintf("%.2f", float64(micros)/1e6) }

// inboxItem is one notification as the inbox lists it.
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

// line is the item on one line of text.
func (item inboxItem) line() string {
	l := fmt.Sprintf("#%d %s %s %s: %s", item.Seq, item.At, item.By, item.Type, item.Title)
	if item.Snippet != "" && item.Snippet != item.Title {
		l += " — " + item.Snippet
	}
	return l
}

// inboxQuery is which of the caller's inbox items to read: up to limit,
// newest first, all of them or the unread only.
type inboxQuery struct {
	unreadOnly bool
	limit      int
}

// inboxItems reads the caller's inbox, leaving out what was archived.
func (who *viewer) inboxItems(ctx context.Context, query inboxQuery) ([]inboxItem, error) {
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	conds := []store.Cond{store.Eq("user_id", who.member.UserID), store.Null("archived_at")}
	if query.unreadOnly {
		conds = append(conds, store.Null("read_at"))
	}
	var notes []core.Notification
	if err := who.db.List(ctx, &notes, store.Q{Where: conds, Order: "-seq", Limit: query.limit}); err != nil {
		return nil, err
	}
	out := make([]inboxItem, len(notes))
	for i, note := range notes {
		item := inboxItem{ID: note.ID, Seq: note.Seq, Type: note.Type, By: names.handle(note.ActorID), Title: note.Title, Snippet: note.Snippet, At: formatTime(note.CreatedAt), Read: note.ReadAt != 0}
		if note.TaskID != "" {
			item.Task, _, _ = strings.Cut(note.Title, " ") // a task's notification is titled with its key first
		}
		out[i] = item
	}
	return out, nil
}

// The inbox lists defaultInboxPage items unless limit= says otherwise, and
// never more than maxInboxPage.
const (
	defaultInboxPage = 50
	maxInboxPage     = 500
)

// handleListInbox lists what concerns the caller: mentions, assignments, picks,
// replies. Unread only unless all=1.
func (s *Server) handleListInbox(x *c) error {
	items, err := x.inboxItems(x.ctx(), inboxQuery{unreadOnly: !truthyParam(x.r.URL.Query(), "all"), limit: min(x.intParam("limit", defaultInboxPage), maxInboxPage)})
	if err != nil {
		return err
	}
	if since := int64(x.intParam("since", -1)); since >= 0 {
		items = keep(items, func(item inboxItem) bool { return item.Seq > since })
	}
	if x.wantText() {
		return x.text(lines(items, inboxItem.line, "inbox is empty"))
	}
	return x.ok(map[string]any{"inbox": items})
}

// myWorkTasks is the most tasks /my-work lists in each of its parts.
const myWorkTasks = 200

// handleShowMyWork is the one call that starts a session: what is assigned to the
// caller, what waits on it, the questions asked of it, and its unread inbox.
func (s *Server) handleShowMyWork(x *c) error {
	ctx := x.ctx()
	me := x.member.UserID
	assigned, err := x.db.Tasks(ctx, store.TaskFilter{AssigneeIDs: []string{me}, Open: true, ProjectIDs: x.projects, Sort: "priority", Limit: myWorkTasks})
	if err != nil {
		return err
	}
	waiting, err := x.db.Tasks(ctx, store.TaskFilter{WaitingOnID: me, Open: true, ProjectIDs: x.projects, Sort: "-activity", Limit: myWorkTasks})
	if err != nil {
		return err
	}
	assignedViews, err := x.taskViews(x.ctx(), assigned)
	if err != nil {
		return err
	}
	waitingViews, err := x.taskViews(x.ctx(), waiting)
	if err != nil {
		return err
	}
	var asked []core.Decision
	if err := x.db.List(ctx, &asked, store.Q{Where: []store.Cond{store.Eq("asked_id", me), store.Eq("state", core.StateOpen), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	askedViews, err := x.decisionViews(x.ctx(), asked)
	if err != nil {
		return err
	}
	inbox, err := x.inboxItems(x.ctx(), inboxQuery{unreadOnly: true, limit: defaultInboxPage})
	if err != nil {
		return err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	if x.wantText() {
		var b strings.Builder
		fmt.Fprintf(&b, "== waiting on you (%d)\n%s", len(waitingViews), lines(waitingViews, taskView.line, "nothing"))
		if len(askedViews) > 0 {
			fmt.Fprintf(&b, "== questions asked of you (%d)\n", len(askedViews))
			for _, decision := range askedViews {
				fmt.Fprintf(&b, "%s  %s  (id=%s)\n", decision.Task, oneLine(decision.Question, 140), decision.ID)
			}
		}
		fmt.Fprintf(&b, "== assigned to you (%d)\n%s", len(assignedViews), lines(assignedViews, taskView.line, "nothing"))
		fmt.Fprintf(&b, "== unread inbox (%d)\n%s", len(inbox), lines(inbox, inboxItem.line, "nothing"))
		fmt.Fprintf(&b, "seq: %d\n", ws.Seq)
		return x.text(b.String())
	}
	return x.ok(map[string]any{"waiting_on_me": waitingViews, "asked_of_me": askedViews, "assigned": assignedViews, "inbox": inbox, "seq": ws.Seq})
}
