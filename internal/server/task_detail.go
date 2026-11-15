package server

import (
	"fmt"
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// buildTaskDetail builds everything about one task in its named form.
func (x *c) buildTaskDetail(t core.Task, maxChars int) (taskDetail, error) {
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
	names    *nameLookup
	files    map[string][]attachmentView // by what each file is attached to
}

// task fills in the task itself, where the feed stands, and what has been
// spent of the task's budget.
func (b *detailBuilder) task() error {
	x, ctx, t := b.x, b.x.ctx(), b.t
	var err error
	if b.names, err = x.names(); err != nil {
		return err
	}
	var ws core.Workspace
	if err := x.s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	b.d.Seq = ws.Seq
	tv, err := x.detailedTaskViews([]core.Task{t})
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
	b.d.Task.Description, b.d.Task.Truncated = truncate(b.d.Task.Description, b.maxChars)
	return nil
}

// subtasks fills in the task's sub-tasks, in their order.
func (b *detailBuilder) subtasks() error {
	subs, err := b.x.db.Tasks(b.x.ctx(), store.TaskFilter{ParentID: b.t.ID, Sort: "rank", Limit: 500})
	if err != nil {
		return err
	}
	b.d.Subtasks, err = b.x.taskViews(subs)
	return err
}

// decisions fills in the task's decisions, with their files.
func (b *detailBuilder) decisions() error {
	var decisions []core.Decision
	if err := b.x.db.List(b.x.ctx(), &decisions, store.Q{Where: []store.Cond{store.Eq("task_id", b.t.ID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	var err error
	b.d.Decisions, err = b.x.decisionViewsWithFiles(decisions)
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
	var comments []core.Comment
	if err := b.x.db.List(b.x.ctx(), &comments, store.Q{Where: []store.Cond{store.Eq("task_id", b.t.ID), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	for _, cm := range comments {
		v := commentView{ID: cm.ID, Seq: cm.CreatedSeq, By: b.names.handle(cm.AuthorID), At: formatTime(cm.CreatedAt), On: where[cm.SubjectID],
			ReplyTo: cm.ParentID, Evidence: cm.Evidence, Attachments: b.files[cm.ID], Edited: cm.EditedAt != 0}
		if cm.Kind != "comment" {
			v.Kind = cm.Kind
		}
		v.Body, v.Truncated = truncate(cm.Body, b.maxChars/2)
		b.d.Comments = append(b.d.Comments, v)
	}
	return nil
}

// relations names the tasks this one is related to, from either end.
func (b *detailBuilder) relations() error {
	x, ctx, t := b.x, b.x.ctx(), b.t
	var outgoing, incoming []core.Relation
	if err := x.db.List(ctx, &outgoing, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return err
	}
	if err := x.db.List(ctx, &incoming, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return err
	}
	var otherIDs []string
	for _, r := range outgoing {
		otherIDs = append(otherIDs, r.RelatedTaskID)
	}
	for _, r := range incoming {
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
			b.d.Relations = append(b.d.Relations, relationView{ID: r.ID, Type: typ, Task: o.Key, Title: o.Title, State: b.names.statuses[o.StatusID].Name})
		}
	}
	for _, r := range outgoing {
		add(r, r.RelatedTaskID, r.Type)
	}
	reverse := map[string]string{core.RelBlocks: "blocked_by", core.RelDuplicates: "duplicated_by", core.RelRelates: core.RelRelates}
	for _, r := range incoming {
		add(r, r.TaskID, reverse[r.Type])
	}
	return nil
}

// links fills in the task's links: branches, pull requests, addresses.
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

// watchers fills in who watches the task, by handle.
func (b *detailBuilder) watchers() error {
	var watchers []core.Watcher
	if err := b.x.db.List(b.x.ctx(), &watchers, store.Where(store.Eq("subject_id", b.t.ID))); err != nil {
		return err
	}
	for _, w := range watchers {
		b.d.Watchers = append(b.d.Watchers, b.names.handle(w.UserID))
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

// maxChars is where the request wants long text cut: max_chars=N, or
// nowhere with full=1.
func (x *c) maxChars() int {
	if truthyParam(x.r.URL.Query(), "full") {
		return 0
	}
	return x.intParam("max_chars", defaultMaxChars)
}

// defaultMaxChars is where a description is cut when the request does not say.
const defaultMaxChars = 6000

// handleShowTask returns one task with everything in it. since=N returns only what
// happened in it after feed position N. raw=1 returns rows, for the web app.
func (s *Server) handleShowTask(x *c) error {
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
		return x.events(eventPage{events: evs, seq: t.ActivitySeq})
	}
	if truthyParam(v, "raw") {
		return s.rawTask(x, t)
	}
	detail, err := x.buildTaskDetail(t, x.maxChars())
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(detail.text())
	}
	return x.ok(detail)
}

// rawTask returns a task's rows as stored.
func (s *Server) rawTask(x *c, t core.Task) error {
	ctx := x.ctx()
	var comments []core.Comment
	var links []core.TaskLink
	var watchers []core.Watcher
	var sessions []core.AgentSession
	if err := x.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_seq"}); err != nil {
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
	var decisions []core.Decision
	if err := x.db.List(ctx, &decisions, store.Where(store.Eq("task_id", t.ID), store.Live)); err != nil {
		return err
	}
	for _, decision := range decisions {
		targets = append(targets, decision.ID)
	}
	var refs []core.Ref
	if err := x.db.List(ctx, &refs, store.Where(store.In("to_id", targets))); err != nil {
		return err
	}
	mentioned, err := x.namedRefs(refs)
	if err != nil {
		return err
	}
	var outgoing, incoming []core.Relation
	if err := x.db.List(ctx, &outgoing, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return err
	}
	if err := x.db.List(ctx, &incoming, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return err
	}
	return x.ok(map[string]any{"task": t, "comments": comments, "links": links, "watchers": watchers, "attachments": atts, "sessions": sessions,
		"mentioned_in": mentioned, "relations": append(outgoing, incoming...)})
}
