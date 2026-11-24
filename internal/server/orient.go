// Orientation: who am I (/me), what is mine to do (/my-work), and the inbox.

package server

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleShowWhoAmI answers "who am I": identity, role, scope, what needs
// approval, an agent's hand-off limit, and where the caller's cursors stand.
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
		"workspace": map[string]any{"id": ws.ID, "slug": ws.Slug, "name": ws.Name}, "seq": ws.Seq, "server_time": time.Now().UTC().Format(time.RFC3339),
		"version": s.cfg.Version,
	}
	projects := x.readableProjects(names)
	keys, projectNames := make([]string, len(projects)), map[string]string{}
	for i, project := range projects {
		keys[i], projectNames[project.Key] = project.Key, project.Name
	}
	out["projects"], out["project_names"] = keys, projectNames
	if x.actor.ReadOnly || (x.member.Scope != nil && x.member.Scope.ReadOnly) {
		out["read_only"] = true
	}
	if scope := x.member.Scope; scope != nil && len(scope.NeedsApproval) > 0 {
		out["needs_approval"] = scope.NeedsApproval
	}
	if x.member.Kind == core.KindAgent {
		out["responsible"] = names.handle(x.user.ResponsibleID)
		if x.member.HandoffLimit > 0 {
			out["handoff_limit"] = x.member.HandoffLimit
		}
	}
	unread, err := x.ownNotes(ctx, []store.Cond{store.Null("read_at")}, 0)
	if err != nil {
		return err
	}
	out["unread"] = len(unread)
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
		return x.text(whoAmIText(out, ws, projects, cursors, rules))
	}
	return x.ok(out)
}

// readableProjects lists, by key, the projects the caller may read that
// are neither archived nor in the trash.
func (who *viewer) readableProjects(names *nameLookup) []core.Project {
	var projects []core.Project
	for _, project := range names.projects {
		if project.DeletedAt == 0 && project.ArchivedAt == 0 && who.canProject(project.ID) {
			projects = append(projects, project)
		}
	}
	slices.SortFunc(projects, func(a, b core.Project) int { return strings.Compare(a.Key, b.Key) })
	return projects
}

// entryName is a project's name as an entry of a list on one line ("SVA
// (Samurai vs Aliens), …") gives it: on one line, its parentheses made
// brackets and its commas semicolons, so that a reader who wants the keys
// can split the line at ", " and take each entry's first word.
var entryName = strings.NewReplacer("(", "[", ")", "]", ",", ";")

// cursorSeqs is where each of the caller's cursors stands, by name, of
// those the viewer may see (mayCursor).
func (who *viewer) cursorSeqs(ctx context.Context) (map[string]int64, error) {
	var cursors []core.Cursor
	if err := who.db.List(ctx, &cursors, store.Where(store.Eq("user_id", who.member.UserID))); err != nil {
		return nil, err
	}
	seqs := map[string]int64{}
	for _, cursor := range cursors {
		if who.mayCursor(cursor.Name) {
			seqs[cursor.Name] = cursor.Seq
		}
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
// the projects by key and name, what may be done, the hand-off limit, what
// is unread, the cursors and the rules.
func whoAmIText(out map[string]any, ws core.Workspace, projects []core.Project, cursors map[string]int64, rules []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "you are %s (%s, %s) in %s\n", out["handle"], out["kind"], out["role"], ws.Slug)
	entries := make([]string, len(projects))
	for i, project := range projects {
		entries[i] = project.Key + " (" + strings.Join(strings.Fields(entryName.Replace(project.Name)), " ") + ")"
	}
	fmt.Fprintf(&b, "projects: %s\n", strings.Join(entries, ", "))
	if v, ok := out["responsible"]; ok {
		fmt.Fprintf(&b, "responsible: %s\n", v)
	}
	if v, ok := out["needs_approval"]; ok {
		fmt.Fprintf(&b, "needs approval: %s\n", strings.Join(v.([]string), ", "))
	}
	if out["read_only"] == true {
		b.WriteString("read-only\n")
	}
	if v, ok := out["handoff_limit"]; ok {
		fmt.Fprintf(&b, "hand-offs to other agents: %v a week at most\n", v)
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

// inboxItem is one notification as the inbox lists it.
type inboxItem struct {
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	By      string `json:"by"`
	ByAgent bool   `json:"by_agent,omitempty"` // whoever it is from is an agent
	Task    string `json:"task,omitempty"`
	Title   string `json:"title,omitempty"`
	Snippet string `json:"snippet,omitempty"`
	At      string `json:"at"`
	Read    bool   `json:"read,omitempty"`
	// Decision is the decision's id, when the item is about one: asked,
	// answered, found unclear.
	Decision string `json:"decision,omitempty"`
	noteRefs
}

// line is the item on one line of text.
func (item inboxItem) line() string {
	l := fmt.Sprintf("#%d %s %s %s: %s", item.Seq, item.At, item.By, item.Type, item.Title)
	if item.Snippet != "" && item.Snippet != item.Title {
		l += " — " + oneLine(item.Snippet, 200)
	}
	return l + item.noteRefs.text()
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
	conds := []store.Cond{store.Null("archived_at")}
	if query.unreadOnly {
		conds = append(conds, store.Null("read_at"))
	}
	notes, err := who.ownNotes(ctx, conds, query.limit)
	if err != nil {
		return nil, err
	}
	out := make([]inboxItem, len(notes))
	for i, note := range notes {
		out[i] = who.inboxItem(ctx, note, names)
	}
	return out, nil
}

// inboxItem is one of the viewer's notifications as the inbox lists it.
func (who *viewer) inboxItem(ctx context.Context, note core.Notification, names *nameLookup) inboxItem {
	item := inboxItem{ID: note.ID, Seq: note.Seq, Type: note.Type, By: names.handle(note.ActorID), ByAgent: names.members[note.ActorID].Kind == core.KindAgent,
		Title: note.Title, Snippet: note.Snippet, At: formatTime(note.CreatedAt), Read: note.ReadAt != 0, noteRefs: who.refsOf(ctx, note)}
	if note.TaskID != "" {
		item.Task, _, _ = strings.Cut(note.Title, " ") // a task's notification is titled with its key first
	}
	if note.EntityType == "decision" {
		item.Decision = note.EntityID
	}
	return item
}

// ownNotes reads the viewer's own notifications that conds select, newest
// first, up to limit (0 for all), as visibleNotifications lets the viewer
// see them. A viewer that rule may keep from some is read page by page
// until the limit is met, so leaving some out does not shorten the list.
func (who *viewer) ownNotes(ctx context.Context, conds []store.Cond, limit int) ([]core.Notification, error) {
	q := store.Q{Where: append([]store.Cond{store.Eq("user_id", who.member.UserID)}, conds...), Order: "-seq", Limit: limit}
	if !who.limited() {
		var notes []core.Notification
		err := who.db.List(ctx, &notes, q)
		return notes, err
	}
	q.Limit = max(limit, notesPage)
	var seen []core.Notification
	for ; ; q.Offset += q.Limit {
		var page []core.Notification
		if err := who.db.List(ctx, &page, q); err != nil {
			return nil, err
		}
		seen = append(seen, visibleNotifications(ctx, who, page)...)
		if len(page) < q.Limit || limit > 0 && len(seen) >= limit {
			break
		}
	}
	if limit > 0 && len(seen) > limit {
		seen = seen[:limit]
	}
	return seen, nil
}

// notesPage is how many notifications ownNotes reads at a time.
const notesPage = 200

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
	assigned, err := x.db.Tasks(ctx, x.readable(store.TaskFilter{AssigneeIDs: []string{me}, Open: true, Sort: "priority", Limit: myWorkTasks}))
	if err != nil {
		return err
	}
	waiting, err := x.db.Tasks(ctx, x.readable(store.TaskFilter{WaitingOnID: me, Open: true, Sort: "-activity", Limit: myWorkTasks}))
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
	asked = onTask(func(d core.Decision) string { return d.TaskID })(ctx, &x.viewer, asked)
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
