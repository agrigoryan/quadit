package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

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
		return x.taskCount(f)
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	if f.Limit > 1000 {
		f.Limit = 1000
	}
	if tok := v.Get("cursor"); tok != "" {
		cur, err := parseTaskCursor(tok, f.Sort)
		if err != nil {
			return err
		}
		f.After, f.MadeUpTo, f.Offset = cur.K, cur.S, 0
	}
	page, err := x.readTaskPage(f)
	if err != nil {
		return err
	}
	if truthyParam(v, "raw") {
		return x.ok(map[string]any{"tasks": page.tasks, "more": page.more})
	}
	x.narrowedAlready()
	fields := splitList(v.Get("fields"))
	views, err := x.taskViews(page.tasks, has(fields, "description") || has(fields, "id") || has(fields, "project"))
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(page.text(views, x.staleView))
	}
	if len(fields) == 0 {
		fields = listFields
	}
	out := map[string]any{"tasks": pick(views, fields)}
	if page.more {
		if len(f.After) == 0 {
			out["next_offset"] = f.Offset + f.Limit
		}
		out["next_cursor"] = page.next
	}
	if page.changedMeanwhile > 0 {
		out["changed_while_reading"] = page.changedMeanwhile
	}
	if x.staleView != "" {
		out["note"] = x.staleView
	}
	return x.ok(out)
}

// taskCount answers a task query with only how many tasks match.
func (x *c) taskCount(f store.TaskFilter) error {
	n, err := x.db.CountTasks(x.ctx(), f)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(fmt.Sprintf("%d\n", n))
	}
	out := map[string]any{"count": n}
	if x.staleView != "" {
		out["note"] = x.staleView
	}
	return x.ok(out)
}

// taskCursor is what a cursor= token holds. cursor= continues a list from
// where the last page ended: after the last row it gave, in the list's own
// order, so rows that close or are added meanwhile shift nothing. The token
// also holds where the feed stood when the first page was read: tasks made
// since are left for the next read. A task whose own place in the order
// changes during the walk (its priority is raised while the list is read by
// priority) could have moved behind the reader; the last page therefore ends
// with every matching task that changed since the walk began. Nothing is
// missed; a task that changed may come a second time, with its new values.
type taskCursor struct {
	K    []any  `json:"k"`
	S    int64  `json:"s"`
	Sort string `json:"q"`
}

// parseTaskCursor reads the token of a list sorted this way.
func parseTaskCursor(tok, sortedBy string) (taskCursor, error) {
	var cur taskCursor
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil || json.Unmarshal(raw, &cur) != nil || len(cur.K) != len(store.TaskSortKeys[sortedBy]) || cur.Sort != sortedBy {
		return cur, &engine.Error{Code: engine.CodeInvalid, Field: "cursor", Message: "this cursor does not belong to this list (same filters and sort as the page it came from); start again without one"}
	}
	for i, k := range cur.K {
		// Whole numbers went through JSON as floats.
		if n, ok := k.(float64); ok && n == float64(int64(n)) {
			cur.K[i] = int64(n)
		}
	}
	return cur, nil
}

// token is the cursor as a list gives it, to be sent back in cursor=.
func (cur taskCursor) token() string {
	raw, _ := json.Marshal(cur)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// taskPage is one page of a task list.
type taskPage struct {
	tasks []core.Task
	more  bool
	// next is the cursor that continues after this page, when there is more.
	next string
	// changedMeanwhile counts the tasks at the end of the last page that are
	// there because they changed while the list was being read.
	changedMeanwhile int
}

// readTaskPage reads the page a filter asks for: up to f.Limit tasks, and
// whether more follow.
func (x *c) readTaskPage(f store.TaskFilter) (taskPage, error) {
	var p taskPage
	limit := f.Limit
	f.Limit++ // one extra row says whether there are more
	tasks, err := x.db.Tasks(x.ctx(), f)
	if err != nil {
		return p, err
	}
	p.tasks = tasks
	if p.more = len(p.tasks) > limit; p.more {
		p.tasks = p.tasks[:limit]
		p.next = x.cursorAfter(f, p.tasks[limit-1]).token()
		return p, nil
	}
	if len(f.After) > 0 && f.MadeUpTo > 0 {
		moved, err := x.changedDuringWalk(f, p.tasks)
		if err != nil {
			return p, err
		}
		p.tasks, p.changedMeanwhile = append(p.tasks, moved...), len(moved)
	}
	return p, nil
}

// changedDuringWalk finds the tasks of a list that changed since a walk
// through it by cursor began, leaving out those of its last page.
func (x *c) changedDuringWalk(f store.TaskFilter, lastPage []core.Task) ([]core.Task, error) {
	again := f
	again.After, again.Offset, again.Limit, again.UpdatedAfter = nil, 0, 1000, max(f.UpdatedAfter, f.MadeUpTo)
	moved, err := x.db.Tasks(x.ctx(), again)
	if err != nil {
		return nil, err
	}
	here := map[string]bool{}
	for _, t := range lastPage {
		here[t.ID] = true
	}
	return keep(moved, func(t core.Task) bool { return !here[t.ID] }), nil
}

// cursorAfter makes the cursor that continues a list after one of its rows.
func (x *c) cursorAfter(f store.TaskFilter, last core.Task) taskCursor {
	cur := taskCursor{S: f.MadeUpTo, Sort: f.Sort}
	if cur.S == 0 {
		var ws core.Workspace
		if err := x.s.st.Get(x.ctx(), &ws, store.Eq("id", x.ws.ID)); err == nil {
			cur.S = ws.Seq
		}
	}
	for _, k := range store.TaskSortKeys[f.Sort] {
		cur.K = append(cur.K, k.Val(last))
	}
	return cur
}

// text is the page as lines, one task each. note says a view named in the
// query was out of date.
func (p taskPage) text(views []taskView, note string) string {
	out := lines(views, taskView.line, "no tasks match")
	if p.more {
		out += fmt.Sprintf("… more: add cursor=%s\n", p.next)
	}
	if note != "" {
		out = "note: " + note + "\n" + out
	}
	if p.changedMeanwhile > 0 {
		out += fmt.Sprintf("… the last %d changed while you were reading; you may have seen them before\n", p.changedMeanwhile)
	}
	return out
}

// detail builds everything about one task in its named form.
func (x *c) detail(t core.Task, maxChars int) (taskDetail, error) {
	b := &detailBuilder{x: x, t: t, maxChars: maxChars}
	for _, part := range []func() error{b.task, b.subtasks, b.decisions, b.attachments, b.comments, b.relations, b.links, b.watchers} {
		if err := part(); err != nil {
			return b.d, err
		}
	}
	return b.d, nil
}

// detailBuilder is one task's detail in the making.
type detailBuilder struct {
	x *c
	t core.Task
	// maxChars is where a long description is cut, and twice where a long
	// comment is; 0 cuts nothing.
	maxChars int
	d        taskDetail
	nm       *names
	files    map[string][]attachmentView // by what each file is attached to
}

// task fills in the task itself, where the feed stands, and what has been
// spent of the task's budget.
func (b *detailBuilder) task() error {
	x, ctx, t := b.x, b.x.ctx(), b.t
	var err error
	if b.nm, err = x.names(); err != nil {
		return err
	}
	var ws core.Workspace
	if err := x.s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	b.d.Seq = ws.Seq
	tv, err := x.taskViews([]core.Task{t}, true)
	if err != nil {
		return err
	}
	b.d.Task = tv[0]
	if t.Budget != nil {
		// What agents have spent of the task's own budget so far.
		var runs []core.AgentSession
		if err := x.db.List(ctx, &runs, store.Where(store.Eq("task_id", t.ID))); err != nil {
			return err
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
		b.d.Task.Spent = &spent
	}
	b.d.Task.Description, b.d.Task.Truncated = cut(b.d.Task.Description, b.maxChars)
	return nil
}

func (b *detailBuilder) subtasks() error {
	subs, err := b.x.db.Tasks(b.x.ctx(), store.TaskFilter{ParentID: b.t.ID, Sort: "rank", Limit: 500})
	if err != nil {
		return err
	}
	b.d.Subtasks, err = b.x.taskViews(subs, false)
	return err
}

func (b *detailBuilder) decisions() error {
	var ds []core.Decision
	if err := b.x.db.List(b.x.ctx(), &ds, store.Q{Where: []store.Cond{store.Eq("task_id", b.t.ID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	var err error
	b.d.Decisions, err = b.x.decisionViews(ds, true)
	return err
}

// attachments loads every file in the task, and gives the task its own.
func (b *detailBuilder) attachments() error {
	var err error
	if b.files, _, err = b.x.attachments(store.Eq("task_id", b.t.ID)); err != nil {
		return err
	}
	b.d.Attachments = b.files[b.t.ID]
	return nil
}

func (b *detailBuilder) comments() error {
	// "option 2 of decision 1" says where a comment sits.
	where := map[string]string{}
	for _, dv := range b.d.Decisions {
		where[dv.ID] = fmt.Sprintf("decision %d", dv.N)
		for _, o := range dv.Options {
			where[o.ID] = fmt.Sprintf("option %d of decision %d", o.N, dv.N)
		}
	}
	var cms []core.Comment
	if err := b.x.db.List(b.x.ctx(), &cms, store.Q{Where: []store.Cond{store.Eq("task_id", b.t.ID), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	for _, cm := range cms {
		v := commentView{ID: cm.ID, Seq: cm.CreatedSeq, By: b.nm.handle(cm.AuthorID), At: when(cm.CreatedAt), On: where[cm.SubjectID],
			ReplyTo: cm.ParentID, Evidence: cm.Evidence, Attachments: b.files[cm.ID], Edited: cm.EditedAt != 0}
		if cm.Kind != "comment" {
			v.Kind = cm.Kind
		}
		v.Body, v.Truncated = cut(cm.Body, b.maxChars/2)
		b.d.Comments = append(b.d.Comments, v)
	}
	return nil
}

// relations names the tasks this one is related to, from either end.
func (b *detailBuilder) relations() error {
	x, ctx, t := b.x, b.x.ctx(), b.t
	var out, in []core.Relation
	if err := x.db.List(ctx, &out, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return err
	}
	if err := x.db.List(ctx, &in, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return err
	}
	var otherIDs []string
	for _, r := range out {
		otherIDs = append(otherIDs, r.RelatedTaskID)
	}
	for _, r := range in {
		otherIDs = append(otherIDs, r.TaskID)
	}
	if len(otherIDs) == 0 {
		return nil
	}
	others, err := x.db.Tasks(ctx, store.TaskFilter{IDs: otherIDs, Archived: true, Limit: 1000})
	if err != nil {
		return err
	}
	byID := map[string]core.Task{}
	for _, o := range others {
		byID[o.ID] = o
	}
	add := func(r core.Relation, otherID, typ string) {
		if o, ok := byID[otherID]; ok {
			b.d.Relations = append(b.d.Relations, relationView{ID: r.ID, Type: typ, Task: o.Key, Title: o.Title, State: b.nm.statuses[o.StatusID].Name})
		}
	}
	for _, r := range out {
		add(r, r.RelatedTaskID, r.Type)
	}
	reverse := map[string]string{core.RelBlocks: "blocked_by", core.RelDuplicates: "duplicated_by", core.RelRelates: core.RelRelates}
	for _, r := range in {
		add(r, r.TaskID, reverse[r.Type])
	}
	return nil
}

func (b *detailBuilder) links() error {
	var links []core.TaskLink
	if err := b.x.db.List(b.x.ctx(), &links, store.Where(store.Eq("task_id", b.t.ID), store.Live)); err != nil {
		return err
	}
	for _, l := range links {
		b.d.Links = append(b.d.Links, linkView{ID: l.ID, Kind: l.Kind, Ref: l.Ref, Repo: l.Repo, Title: l.Title, URL: l.URL, State: l.State, Checks: l.Checks, Data: l.Data})
	}
	return nil
}

func (b *detailBuilder) watchers() error {
	var ws []core.Watcher
	if err := b.x.db.List(b.x.ctx(), &ws, store.Where(store.Eq("subject_id", b.t.ID))); err != nil {
		return err
	}
	for _, w := range ws {
		b.d.Watchers = append(b.d.Watchers, b.nm.handle(w.UserID))
	}
	sort.Strings(b.d.Watchers)
	return nil
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
	t, err := x.taskByRef(x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	d, err := x.detail(t, x.maxChars())
	if err != nil {
		return err
	}
	p := &contextPack{x: x, t: t, out: map[string]any{"task": d}}
	p.text.WriteString(d.text())
	for _, part := range []func() error{p.parents, p.epic, p.preferences, p.recentDecisions, p.docs} {
		if err := part(); err != nil {
			return err
		}
	}
	if x.wantText() {
		return x.text(p.text.String())
	}
	return x.ok(p.out)
}

// contextPack is one task's context pack in the making, in both its forms:
// each part adds to the answer and to the text.
type contextPack struct {
	x    *c
	t    core.Task
	out  map[string]any
	text strings.Builder
}

// parents adds the chain of parents, which says what this task is part of.
func (p *contextPack) parents() error {
	x := p.x
	var parents []taskView
	for cur, depth := p.t.ParentID, 0; cur != "" && depth < 5; depth++ {
		var up core.Task
		if err := x.db.Get(x.ctx(), &up, store.Eq("id", cur)); err != nil {
			break
		}
		pv, _ := x.taskViews([]core.Task{up}, true)
		pv[0].Description, pv[0].Truncated = cut(pv[0].Description, 1500)
		parents = append(parents, pv[0])
		cur = up.ParentID
	}
	if len(parents) > 0 {
		p.out["parents"] = parents
		p.text.WriteString("=== part of\n")
		for _, v := range parents {
			fmt.Fprintf(&p.text, "%s\n%s\n", v.line(), v.Description)
		}
	}
	return nil
}

// epic adds the epic the task is in.
func (p *contextPack) epic() error {
	nm, _ := p.x.names()
	if e, ok := nm.epics[p.t.EpicID]; ok {
		desc, _ := cut(e.Description, 2000)
		p.out["epic"] = map[string]any{"name": e.Name, "state": e.State, "target_on": e.TargetOn, "description": desc}
		fmt.Fprintf(&p.text, "=== epic: %s (%s", e.Name, e.State)
		if e.TargetOn != "" {
			p.text.WriteString(", target " + e.TargetOn)
		}
		p.text.WriteString(")\n" + desc + "\n")
	}
	return nil
}

// preferences adds the standing preferences: the workspace's, the
// project's, and those tied to this task's labels.
func (p *contextPack) preferences() error {
	t := p.t
	var prefs []core.Preference
	if err := p.x.db.List(p.x.ctx(), &prefs, store.Where(store.Live, store.Null("retired_at"))); err != nil {
		return err
	}
	var rules []string
	for _, pr := range prefs {
		if pr.ProjectID != "" && pr.ProjectID != t.ProjectID {
			continue
		}
		if len(pr.LabelIDs) > 0 {
			match := false
			for _, l := range pr.LabelIDs {
				match = match || has(t.LabelIDs, l)
			}
			if !match {
				continue
			}
		}
		rules = append(rules, pr.Body)
	}
	if len(rules) > 0 {
		p.out["standing_preferences"] = rules
		p.text.WriteString("=== standing preferences\n- " + strings.Join(rules, "\n- ") + "\n")
	}
	return nil
}

// recentDecisions adds earlier answers in the same project, which guide
// later work.
func (p *contextPack) recentDecisions() error {
	x, ctx, t := p.x, p.x.ctx(), p.t
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
		p.out["recent_decisions"] = rv
		p.text.WriteString("=== recent decisions in this project\n")
		for _, r := range rv {
			ans := r.Outcome
			if r.PickedLabel != "" {
				ans = r.PickedLabel
			}
			fmt.Fprintf(&p.text, "%s %q -> %s", r.Task, oneLine(r.Question, 100), ans)
			if r.Note != "" {
				p.text.WriteString(": " + oneLine(r.Note, 160))
			}
			p.text.WriteString("\n")
		}
	}
	return nil
}

// docs adds the docs this task mentions, or that mention it.
func (p *contextPack) docs() error {
	x, ctx, t := p.x, p.x.ctx(), p.t
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
			docs = append(docs, map[string]any{"id": doc.ID, "title": doc.Title, "url": x.s.cfg.BaseURL + "/" + x.ws.Slug + "/docs/" + doc.ID})
		}
	}
	if len(docs) > 0 {
		p.out["docs"] = docs
		p.text.WriteString("=== linked docs\n")
		for _, dc := range docs {
			fmt.Fprintf(&p.text, "%s  (doc %s)\n", dc["title"], dc["id"])
		}
	}
	return nil
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
