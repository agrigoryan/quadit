// One task in full: GET /tasks/KEY, as names for agents or as rows for the web app.

package server

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// buildTaskDetail builds everything about one task in its named form.
// maxChars is where a long description is cut, and half of it where a long
// comment is; 0 cuts nothing.
func (who *viewer) buildTaskDetail(ctx context.Context, t core.Task, maxChars int) (taskDetail, error) {
	var d taskDetail
	names, err := who.names(ctx)
	if err != nil {
		return d, err
	}

	// The task itself, and where the feed stands.
	var ws core.Workspace
	if err := who.st.Get(ctx, &ws, store.Eq("id", who.ws.ID)); err != nil {
		return d, err
	}
	d.Seq = ws.Seq
	tv, err := who.detailedTaskViews(ctx, []core.Task{t})
	if err != nil {
		return d, err
	}
	d.Task = tv[0]
	if t.Budget != nil {
		// What agents have spent of the task's own budget so far.
		var runs []core.AgentSession
		if err := who.db.List(ctx, &runs, store.Where(store.Eq("task_id", t.ID))); err != nil {
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
	d.Task.Description, d.Task.Truncated = truncate(d.Task.Description, maxChars)

	// Its sub-tasks, in their order.
	subs, err := who.db.Tasks(ctx, store.TaskFilter{ParentID: t.ID, Sort: "rank", Limit: 500})
	if err != nil {
		return d, err
	}
	if d.Subtasks, err = who.taskViews(ctx, subs); err != nil {
		return d, err
	}

	// Its decisions, with their files.
	var decisions []core.Decision
	if err := who.db.List(ctx, &decisions, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "rank"}); err != nil {
		return d, err
	}
	if d.Decisions, err = who.decisionViewsWithFiles(ctx, decisions); err != nil {
		return d, err
	}

	// Every file in the task, by what it is attached to; the task's own go
	// on the task, the comments' on their comments.
	files, _, err := who.attachments(ctx, store.Eq("task_id", t.ID))
	if err != nil {
		return d, err
	}
	d.Attachments = files[t.ID]

	// Its comments, each with its files, where it sits ("option 2 of
	// decision 1"), and cut at half of maxChars.
	where := map[string]string{}
	for _, dv := range d.Decisions {
		where[dv.ID] = fmt.Sprintf("decision %d", dv.N)
		for _, o := range dv.Options {
			where[o.ID] = fmt.Sprintf("option %d of decision %d", o.N, dv.N)
		}
	}
	var comments []core.Comment
	if err := who.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_seq"}); err != nil {
		return d, err
	}
	for _, cm := range comments {
		v := commentView{ID: cm.ID, Seq: cm.CreatedSeq, By: names.handle(cm.AuthorID), At: formatTime(cm.CreatedAt), On: where[cm.SubjectID],
			ReplyTo: cm.ParentID, Evidence: cm.Evidence, Attachments: files[cm.ID], Edited: cm.EditedAt != 0}
		if cm.Kind != core.CommentPlain {
			v.Kind = cm.Kind
		}
		v.Body, v.Truncated = truncate(cm.Body, maxChars/2)
		d.Comments = append(d.Comments, v)
	}

	// The tasks it is related to, from either end. One of a project the
	// viewer may not read is listed as a task they cannot see: the kind of
	// relation, and nothing of the task.
	var outgoing, incoming []core.Relation
	if err := who.db.List(ctx, &outgoing, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return d, err
	}
	if err := who.db.List(ctx, &incoming, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return d, err
	}
	var otherIDs []string
	for _, r := range outgoing {
		otherIDs = append(otherIDs, r.RelatedTaskID)
	}
	for _, r := range incoming {
		otherIDs = append(otherIDs, r.TaskID)
	}
	if len(otherIDs) > 0 {
		others, err := who.db.Tasks(ctx, store.TaskFilter{IDs: otherIDs, Archived: true, Limit: 1000})
		if err != nil {
			return d, err
		}
		byID := map[string]core.Task{}
		for _, o := range others {
			byID[o.ID] = o
		}
		add := func(r core.Relation, otherID, typ string) {
			o, ok := byID[otherID]
			switch {
			case !ok: // in the trash
			case !who.canProject(o.ProjectID):
				d.Relations = append(d.Relations, relationView{Type: typ, Hidden: true})
			default:
				d.Relations = append(d.Relations, relationView{ID: r.ID, Type: typ, Task: o.Key, Title: o.Title, State: names.statuses[o.StatusID].Name})
			}
		}
		for _, r := range outgoing {
			add(r, r.RelatedTaskID, r.Type)
		}
		reverse := map[string]string{core.RelBlocks: "blocked_by", core.RelDuplicates: "duplicated_by", core.RelRelates: core.RelRelates}
		for _, r := range incoming {
			add(r, r.TaskID, reverse[r.Type])
		}
	}

	// Its links: branches, pull requests, addresses.
	var links []core.TaskLink
	if err := who.db.List(ctx, &links, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_at,id"}); err != nil {
		return d, err
	}
	for _, l := range links {
		d.Links = append(d.Links, linkView{ID: l.ID, Kind: l.Kind, Ref: l.Ref, Repo: l.Repo, Title: l.Title, URL: l.URL, State: l.State, Checks: l.Checks, Data: l.Data})
	}

	// Who watches it, by handle.
	var watchers []core.Watcher
	if err := who.db.List(ctx, &watchers, store.Where(store.Eq("subject_id", t.ID))); err != nil {
		return d, err
	}
	for _, w := range watchers {
		d.Watchers = append(d.Watchers, names.handle(w.UserID))
	}
	sort.Strings(d.Watchers)
	return d, nil
}

// taskByRef loads a task the caller may read.
func (who *viewer) taskByRef(ctx context.Context, ref string) (core.Task, error) {
	t, err := who.resolver(ctx).Task(ref)
	if err != nil {
		return t, err
	}
	if !who.canProject(t.ProjectID) {
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
	t, err := x.taskByRef(x.ctx(), x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	v := x.r.URL.Query()
	x.narrowedAlready()
	if since := x.intParam("since", -1); since >= 0 {
		evs, err := x.readFeed(x.ctx(), store.EventFilter{After: int64(since), ScopeType: "task", ScopeID: t.ID, Viewer: x.member.UserID, Limit: 500})
		if err != nil {
			return err
		}
		return x.events(eventPage{events: evs, seq: t.ActivitySeq})
	}
	if truthyParam(v, "raw") {
		rows, err := x.taskRows(x.ctx(), t)
		if err != nil {
			return err
		}
		return x.ok(rows)
	}
	detail, err := x.buildTaskDetail(x.ctx(), t, x.maxChars())
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(detail.text())
	}
	return x.ok(detail)
}

// taskRows is a task with the rows that hang on it, as stored: what the web
// app reads. Where the task is mentioned is kept to what the viewer may see.
func (who *viewer) taskRows(ctx context.Context, t core.Task) (map[string]any, error) {
	var comments []core.Comment
	var links []core.TaskLink
	var watchers []core.Watcher
	var sessions []core.AgentSession
	if err := who.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_seq"}); err != nil {
		return nil, err
	}
	if err := who.db.List(ctx, &links, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_at,id"}); err != nil {
		return nil, err
	}
	if err := who.db.List(ctx, &watchers, store.Where(store.Eq("subject_id", t.ID))); err != nil {
		return nil, err
	}
	if err := who.db.List(ctx, &sessions, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID)}, Order: "-started_at,id", Limit: 50}); err != nil {
		return nil, err
	}
	_, atts, err := who.attachments(ctx, store.Eq("task_id", t.ID))
	if err != nil {
		return nil, err
	}
	// Where this task, and each of its decisions, is mentioned: in pages,
	// in other tasks, in comments. Each says what it is called.
	targets := []string{t.ID}
	var decisions []core.Decision
	if err := who.db.List(ctx, &decisions, store.Where(store.Eq("task_id", t.ID), store.Live)); err != nil {
		return nil, err
	}
	for _, decision := range decisions {
		targets = append(targets, decision.ID)
	}
	var refs []core.Ref
	if err := who.db.List(ctx, &refs, store.Q{Where: []store.Cond{store.In("to_id", targets)}, Order: "from_id,to_id"}); err != nil {
		return nil, err
	}
	mentioned, err := who.namedRefs(ctx, refs)
	if err != nil {
		return nil, err
	}
	var outgoing, incoming []core.Relation
	if err := who.db.List(ctx, &outgoing, store.Where(store.Eq("task_id", t.ID))); err != nil {
		return nil, err
	}
	if err := who.db.List(ctx, &incoming, store.Where(store.Eq("related_task_id", t.ID))); err != nil {
		return nil, err
	}
	return map[string]any{"task": t, "comments": comments, "links": links, "watchers": watchers, "attachments": atts, "sessions": sessions,
		"mentioned_in": mentioned, "relations": visibleRelations(ctx, who, append(outgoing, incoming...))}, nil
}
