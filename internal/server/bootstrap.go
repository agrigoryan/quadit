// The starting copy (/bootstrap): the workspace as rows, for a client that
// keeps a local copy and follows the feed from there.

package server

import (
	"net/url"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// handleBootstrapLocalCopy returns the workspace as rows, for a client that keeps a local
// copy and then follows the feed from "seq". The rows are loaded, kept to
// the tasks of the part asked for and to what the caller may see, and given.
func (s *Server) handleBootstrapLocalCopy(x *c) error {
	ctx := x.ctx()
	// Read the position first: anything committed after it will also come
	// through the feed, and applying an event twice is harmless.
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	out := map[string]any{"seq": ws.Seq, "workspace": ws, "me": x.member, "user": x.user, "server_time": time.Now().UnixMilli(), "version": s.cfg.Version}
	rows := &bootstrapRows{x: x, part: x.r.URL.Query().Get("part")}
	for _, load := range []func() error{rows.loadLists, rows.loadTasks, rows.loadAttachments} {
		if err := load(); err != nil {
			return err
		}
	}
	rows.keepToTasks()
	if rows.part == "rest" {
		// Only what part=open left out: the closed tasks and what hangs on them.
		return x.ok(map[string]any{"seq": out["seq"], "part": rows.part, "tasks": rows.tasks, "decisions": rows.decisions, "attachments": rows.attachments, "relations": rows.relations})
	}
	rows.keepToCaller()
	rows.fill(out)
	if rows.part == "open" {
		out["part"] = rows.part
		rest, err := x.db.CountTasks(ctx, store.TaskFilter{ProjectIDs: x.projects, Archived: true, Closed: true})
		if err != nil {
			return err
		}
		out["rest"] = rest
	}
	return x.ok(out)
}

// bootstrapRows is one starting copy in the making: the workspace's lists as
// they were read, then kept to the tasks of the part asked for and to what
// the caller may see.
type bootstrapRows struct {
	x *c
	// part=open brings the open work, which is what the first screen needs;
	// part=rest brings what is done, canceled or archived, to be asked for in
	// the background. Without part, everything comes at once.
	part string

	members    []core.Member
	projects   []core.Project
	statuses   []core.Status
	labels     []core.Label
	epics      []core.Epic
	milestones []core.Milestone
	cycles     []core.Cycle
	views      []core.View
	templates  []core.Template
	prefs      []core.Preference
	decisions  []core.Decision
	options    []core.Option
	relations  []core.Relation
	notes      []core.Notification
	watchers   []core.Watcher
	resources  []core.Resource
	claims     []core.ResourceClaim
	docs       []core.Doc
	sessions   []core.AgentSession

	tasks   []core.Task
	taskIDs map[string]bool // the tasks this copy brings
	// The files shown on decisions and their options, so a list can show a
	// decision's pictures without opening its task.
	attachments []core.Attachment
}

// loadLists reads every list of the copy but the tasks and the files.
func (b *bootstrapRows) loadLists() error {
	x := b.x
	live := func(order string) store.Q { return store.Q{Where: []store.Cond{store.Live}, Order: order} }
	mine := store.Eq("user_id", x.member.UserID)
	weekAgo := time.Now().Add(-7 * 24 * time.Hour).UnixMilli()
	const most = 300 // the latest notifications and agent sessions it brings
	for _, list := range []struct {
		into any
		q    store.Q
	}{
		{&b.members, store.Q{Order: "handle"}},
		{&b.projects, live("rank")},
		{&b.statuses, live("rank")},
		{&b.labels, live("name")},
		{&b.epics, live("rank")},
		{&b.milestones, live("rank")},
		{&b.cycles, live("starts_on")},
		{&b.views, live("rank")},
		{&b.templates, live("name")},
		{&b.prefs, live("")},
		{&b.decisions, live("created_seq")},
		{&b.options, live("rank")},
		{&b.relations, store.Q{}},
		{&b.notes, store.Q{Where: []store.Cond{mine, store.Null("archived_at")}, Order: "-seq", Limit: most}},
		{&b.watchers, store.Where(mine)},
		{&b.resources, live("")},
		{&b.claims, store.Where(store.Ne("state", core.ClaimReleased))},
		{&b.docs, live("rank")},
		{&b.sessions, store.Q{Where: []store.Cond{store.Gte("started_at", weekAgo)}, Order: "-started_at", Limit: most}},
	} {
		if err := x.db.List(x.ctx(), list.into, list.q); err != nil {
			return err
		}
	}
	return nil
}

// loadTasks reads the tasks of the part asked for, in the order they were
// made and without their descriptions.
func (b *bootstrapRows) loadTasks() error {
	want := store.TaskFilter{ProjectIDs: b.x.projects, Archived: true}
	switch b.part {
	case "":
	case "open":
		want.Open, want.Archived = true, false
	case "rest":
		want.Closed = true
	default:
		return &engine.Error{Code: engine.CodeInvalid, Field: "part", Message: "unknown part " + b.part, Allowed: []string{"open", "rest"}}
	}
	var err error
	if b.tasks, err = b.x.everyTask(b.x.ctx(), want); err != nil {
		return err
	}
	b.taskIDs = map[string]bool{}
	for i := range b.tasks {
		b.tasks[i].Description = "" // loaded when the task is opened
		b.taskIDs[b.tasks[i].ID] = true
	}
	return nil
}

// loadAttachments reads the files on the decisions of the copy's tasks and
// on their options, each with where it is served from.
func (b *bootstrapRows) loadAttachments() error {
	x, ctx := b.x, b.x.ctx()
	var atts []core.Attachment
	if err := x.db.List(ctx, &atts, store.Q{Where: []store.Cond{store.In("subject_type", []string{"decision", "decision_option"}), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	atts = keep(atts, func(a core.Attachment) bool { return b.taskIDs[a.TaskID] })
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
	b.attachments = atts
	return nil
}

// keepToTasks drops the decisions and relations of tasks this copy does not
// bring, and gives each decision its options.
func (b *bootstrapRows) keepToTasks() {
	byDecision := map[string][]core.Option{}
	for _, option := range b.options {
		byDecision[option.DecisionID] = append(byDecision[option.DecisionID], option)
	}
	b.decisions = keep(b.decisions, func(decision core.Decision) bool { return b.taskIDs[decision.TaskID] })
	for i := range b.decisions {
		b.decisions[i].Options = byDecision[b.decisions[i].ID]
	}
	b.relations = keep(b.relations, func(r core.Relation) bool { return b.taskIDs[r.TaskID] || b.taskIDs[r.RelatedTaskID] })
}

// keepToCaller keeps of each list what the caller may see: the rows of the
// projects it may read, its own views and the shared ones, the pages open
// to it. Each agent gets the person who answers for it.
func (b *bootstrapRows) keepToCaller() {
	x := b.x
	inScope := x.canProject
	x.s.withResponsible(x.ctx(), b.members)
	x.hideActions(x.ctx(), b.members)
	epicOK := map[string]bool{}
	for _, e := range b.epics {
		epicOK[e.ID] = inScope(e.ProjectID)
	}
	b.projects = keep(b.projects, func(project core.Project) bool { return inScope(project.ID) })
	b.statuses = keep(b.statuses, func(v core.Status) bool { return inScope(v.ProjectID) })
	b.labels = keep(b.labels, func(v core.Label) bool { return inScope(v.ProjectID) })
	b.epics = keep(b.epics, func(v core.Epic) bool { return inScope(v.ProjectID) })
	b.milestones = keep(b.milestones, func(v core.Milestone) bool { return epicOK[v.EpicID] })
	b.cycles = keep(b.cycles, func(v core.Cycle) bool { return inScope(v.ProjectID) })
	b.views = keep(b.views, func(v core.View) bool { return (v.Shared || v.OwnerID == x.member.UserID) && inScope(v.ProjectID) })
	b.templates = keep(b.templates, func(v core.Template) bool { return inScope(v.ProjectID) })
	b.prefs = keep(b.prefs, func(v core.Preference) bool { return inScope(v.ProjectID) })
	b.claims = keepByTask(x.ctx(), &x.viewer, b.claims, func(v core.ResourceClaim) string { return v.TaskID })
	b.docs = keep(b.docs, func(doc core.Doc) bool { return engine.CanSeeDoc(doc, x.member.UserID) && inScope(doc.ProjectID) })
	b.sessions = keepByTask(x.ctx(), &x.viewer, b.sessions, func(v core.AgentSession) string { return v.TaskID })
}

// fill puts the lists into the answer, each under its name.
func (b *bootstrapRows) fill(out map[string]any) {
	out["members"] = b.members
	out["projects"] = b.projects
	out["statuses"] = b.statuses
	out["labels"] = b.labels
	out["epics"] = b.epics
	out["milestones"] = b.milestones
	out["cycles"] = b.cycles
	out["views"] = b.views
	out["templates"] = b.templates
	out["preferences"] = b.prefs
	out["attachments"] = b.attachments
	out["tasks"] = b.tasks
	out["decisions"] = b.decisions
	out["relations"] = b.relations
	out["notifications"] = b.notes
	out["watchers"] = b.watchers
	out["resources"] = b.resources
	out["claims"] = b.claims
	out["docs"] = b.docs
	out["sessions"] = b.sessions
}
