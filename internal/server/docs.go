// Pages: the page tree, one page, its versions and who else has it open;
// pages built from data; and an agent's memory pages.

package server

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// pageRoutes are the routes of pages and agents' memory.
func (s *Server) pageRoutes() []route {
	const w = "/api/v1/w/{ws}"
	return []route{
		{"GET " + w + "/docs", s.workspaceMember(s.handleListPages), "The page tree.", "", "docs"},
		{"GET " + w + "/docs/{id}", s.workspaceMember(s.handleShowPage), "One page: rows for the editor, or Markdown with format=md. The text form ends with the page's open comment threads.",
			"format: md or text; full: true; resolved: 1 for the resolved threads too; comments: 0 for none, 1 to add them to format=md", "docs"},
		{"GET " + w + "/docs/{id}/comments", s.workspaceMember(s.handleListPageComments), "A page's comment threads: each with what it is on, its comments and replies.", "resolved: 1 for the resolved threads too (text)", "docs"},
		{"GET " + w + "/docs/{id}/versions", s.workspaceMember(s.handleListPageVersions), "A page's kept versions.", "", "docs"},
		{"GET " + w + "/docs/{id}/versions/{version}", s.workspaceMember(s.handleShowPageVersion), "One version's content.", "format: md", "docs"},
		{"POST " + w + "/docs/{id}/presence", s.workspaceMember(s.handleReportPagePresence), "Say which block I am in; returns who else is in the page. Body: {block}.", "", "docs"},
		{"GET " + w + "/docs/{id}/rows", s.workspaceMember(s.handleListDatabaseRows), "A database's rows with formulas and rollups worked out.", "filter: Prop:op:value, comma-separated; sort: Prop or -Prop; view: name", "docs"},
		{"GET " + w + "/memory", s.workspaceMember(s.handleShowAgentMemory), "An agent's notes from earlier sessions, as Markdown.", "agent: @handle (default: the caller)", "docs"},
		{"POST " + w + "/memory", s.workspaceMember(s.handleSaveAgentMemory), "Save a note: {title, markdown, mode}. dry_run=1 checks it without saving.", "", "docs"},
	}
}

// docByID loads a page the caller may see. A page the caller may not see
// is not found, as one that does not exist.
func (who *viewer) docByID(ctx context.Context, ref string) (core.Doc, error) {
	var doc core.Doc
	there, err := store.Find(ctx, who.db, &doc, store.Eq("id", ref), store.Live)
	if err != nil {
		return doc, err
	}
	if !there || !who.canSeeDoc(doc) {
		return doc, errNotFound("doc " + ref)
	}
	return doc, nil
}

// visibleDocs lists, in their order, the pages the caller may see.
func (who *viewer) visibleDocs(ctx context.Context) ([]core.Doc, error) {
	var docs []core.Doc
	if err := who.db.List(ctx, &docs, store.Q{Where: []store.Cond{store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	return keep(docs, who.canSeeDoc), nil
}

// handleListPages lists the page tree. The text form is an indented outline with ids.
func (s *Server) handleListPages(x *c) error {
	if truthyParam(x.r.URL.Query(), "trash") {
		var gone []core.Doc
		if err := x.db.List(x.ctx(), &gone, store.Q{Where: []store.Cond{store.NotNull("deleted_at")}, Order: "-deleted_at", Limit: 1000}); err != nil {
			return err
		}
		gone = keep(gone, func(d core.Doc) bool {
			return x.canSeeDoc(d) && d.Kind != core.DocRow
		})
		return x.ok(map[string]any{"docs": gone})
	}
	docs, err := x.visibleDocs(x.ctx())
	if err != nil {
		return err
	}
	docs = keep(docs, func(d core.Doc) bool { return d.Kind != core.DocRow })
	if ref := x.r.URL.Query().Get("project"); ref != "" {
		project, err := x.resolver(x.ctx()).Project(ref)
		if err != nil {
			return err
		}
		if !x.canProject(project.ID) {
			return errNotFound("project " + ref)
		}
		docs = pagesOfProject(docs, project.ID)
	}
	if since := int64(x.intParam("since", -1)); since >= 0 && x.wantText() {
		// Only the pages changed after that position, as a flat list.
		changed := keep(docs, func(d core.Doc) bool { return d.UpdatedSeq > since })
		return x.text(lines(changed, func(d core.Doc) string { return fmt.Sprintf("%s  %s  (changed at %d)", d.ID, d.Title, d.UpdatedSeq) }, "no page changed since "+strconv.FormatInt(since, 10)))
	}
	if !x.wantText() {
		return x.ok(map[string]any{"docs": docs})
	}
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	return x.text(pageOutline(docs, names.projects))
}

// pagesOfProject keeps the pages tied to a project and the pages under
// them: what the project's Docs view shows.
func pagesOfProject(docs []core.Doc, projectID string) []core.Doc {
	byID := map[string]core.Doc{}
	for _, d := range docs {
		byID[d.ID] = d
	}
	within := func(d core.Doc) bool {
		for range maxPageDepth {
			if d.ProjectID == projectID {
				return true
			}
			parent, ok := byID[d.ParentID]
			if !ok {
				return false
			}
			d = parent
		}
		return false
	}
	return keep(docs, within)
}

// maxPageDepth is deeper than any page tree goes: a walk up that long has
// met a loop.
const maxPageDepth = 60

// pageOutline writes pages as an indented tree with their ids. A page whose
// parent is not among them stands at the top. A page says its project
// where that is not its parent's: a sub-page is in its parent's project
// unless it says otherwise.
func pageOutline(docs []core.Doc, projects map[string]core.Project) string {
	byID := map[string]core.Doc{}
	for _, d := range docs {
		byID[d.ID] = d
	}
	kids := map[string][]core.Doc{}
	for _, d := range docs {
		parent := d.ParentID
		if _, ok := byID[parent]; !ok {
			parent = ""
		}
		kids[parent] = append(kids[parent], d)
	}
	var b strings.Builder
	var walk func(parent, indent string)
	walk = func(parent, indent string) {
		for _, d := range kids[parent] {
			note := ""
			switch {
			case d.Kind == core.DocDatabase:
				note = " [database]"
			case d.Generated != "":
				note = " [generated]"
			case d.MemoryOf != "":
				note = " [memory]"
			case d.OwnerID != "":
				note = " [private]"
			}
			if d.ProjectID != byID[parent].ProjectID {
				note += " [" + firstNonEmpty(projects[d.ProjectID].Key, "no project") + "]"
			}
			fmt.Fprintf(&b, "%s%s%s  (%s)\n", indent, firstNonEmpty(d.Title, "Untitled"), note, d.ID)
			walk(d.ID, indent+"  ")
		}
	}
	walk("", "")
	if b.Len() == 0 {
		b.WriteString("no pages\n")
	}
	return b.String()
}

// handleShowPage returns one page: as rows for the editor, or as Markdown.
func (s *Server) handleShowPage(x *c) error {
	page, err := x.docByID(x.ctx(), x.r.PathValue("id"))
	if err != nil {
		return err
	}
	blocks, err := x.pageBlocks(x.ctx(), page)
	if err != nil {
		return err
	}
	if format := x.r.URL.Query().Get("format"); format == "md" || x.wantText() {
		text := pageText(page, blocks, format, x.maxChars())
		// The text form, which agents read, ends with the open threads.
		// Markdown is the page alone, as it is written back, unless asked.
		q := x.r.URL.Query()
		withComments := format != "md"
		if q.Has("comments") {
			withComments = truthyParam(q, "comments")
		}
		if withComments {
			threads, err := x.pageThreads(x.ctx(), page)
			if err != nil {
				return err
			}
			if more := threadsText(threads, truthyParam(q, "resolved")); more != "" {
				text = strings.TrimRight(text, "\n") + "\n\n" + more
			}
		}
		return x.text(text)
	}
	out, err := x.pageAnswer(x.ctx(), page, blocks)
	if err != nil {
		return err
	}
	return x.ok(out)
}

// pageText is a page as Markdown, cut at maxChars: alone for format=md,
// else under a heading that names the page. The words comment threads are
// on are spans naming them, which a write of the Markdown takes back.
func pageText(page core.Doc, blocks []core.Block, format string, maxChars int) string {
	body := md.RenderWithComments(engine.BlockTree(blocks))
	text, cutOff := truncate(body, maxChars)
	if cutOff {
		text += "\n… (cut; add full=1)\n"
	}
	if format == "md" {
		return text
	}
	return fmt.Sprintf("# %s\n(doc %s, seq %d)\n\n%s", firstNonEmpty(page.Title, "Untitled"), page.ID, page.ContentSeq, text)
}

// pageAnswer is a page as the editor reads it: with its blocks, its
// sub-pages, a database's properties, views and rows, its comments, what
// mentions it and what it mentions, its files, and the source it is synced
// from.
func (who *viewer) pageAnswer(ctx context.Context, page core.Doc, blocks []core.Block) (map[string]any, error) {
	out := map[string]any{"doc": page, "blocks": blocks}
	var children []core.Doc
	if err := who.db.List(ctx, &children, store.Q{Where: []store.Cond{store.Eq("parent_id", page.ID), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	children = keep(children, who.canSeeDoc) // someone may keep a sub-page private
	if page.Kind == core.DocDatabase {
		// A database's children are its rows; any others are its sub-pages.
		var props []core.DBProperty
		var views []core.DBView
		if err := who.db.List(ctx, &props, store.Q{Where: []store.Cond{store.Eq("database_id", page.ID), store.Live}, Order: "rank"}); err != nil {
			return nil, err
		}
		if err := who.db.List(ctx, &views, store.Q{Where: []store.Cond{store.Eq("database_id", page.ID), store.Live}, Order: "rank"}); err != nil {
			return nil, err
		}
		out["properties"], out["views"] = props, views
		out["rows"] = keep(children, func(child core.Doc) bool { return child.Kind == core.DocRow })
		children = keep(children, func(child core.Doc) bool { return child.Kind != core.DocRow })
	}
	out["children"] = children
	var comments []core.Comment
	if err := who.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID), store.Live}, Order: "created_seq"}); err != nil {
		return nil, err
	}
	out["comments"] = comments
	// What mentions this page, of what the viewer may see, and what it mentions.
	var refs, back, fwd []core.Ref
	if err := who.db.List(ctx, &refs, store.Q{Where: []store.Cond{store.Eq("to_id", page.ID)}, Order: "from_id"}); err != nil {
		return nil, err
	}
	seen, err := who.namedRefs(ctx, refs)
	if err != nil {
		return nil, err
	}
	for _, ref := range seen {
		back = append(back, ref.Ref)
	}
	if err := who.db.List(ctx, &fwd, store.Q{Where: []store.Cond{store.Eq("from_scope_id", page.ID)}, Order: "from_id,to_id"}); err != nil {
		return nil, err
	}
	out["mentioned_in"], out["mentions"] = back, who.seenMentioned(ctx, fwd)
	_, atts, err := who.attachments(ctx, store.Eq("subject_id", page.ID))
	if err != nil {
		return nil, err
	}
	out["attachments"] = atts
	if page.SourceID != "" {
		var source core.DocSource
		there, err := store.Find(ctx, who.db, &source, store.Eq("id", page.SourceID))
		if err != nil {
			return nil, err
		}
		if there {
			out["source"] = source
		}
	}
	return out, nil
}

// handleListPageVersions lists a page's saved versions, newest first,
// without their content.
func (s *Server) handleListPageVersions(x *c) error {
	page, err := x.docByID(x.ctx(), x.r.PathValue("id"))
	if err != nil {
		return err
	}
	var versions []core.DocVersion
	if err := x.db.List(x.ctx(), &versions, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID)}, Order: "-seq", Limit: 500}); err != nil {
		return err
	}
	for i := range versions {
		versions[i].Snapshot = nil // listed without their content
	}
	return x.ok(map[string]any{"versions": versions})
}

// handleShowPageVersion returns one saved version of a page: as blocks and
// Markdown, or as Markdown alone.
func (s *Server) handleShowPageVersion(x *c) error {
	page, err := x.docByID(x.ctx(), x.r.PathValue("id"))
	if err != nil {
		return err
	}
	var version core.DocVersion
	if err := x.db.Get(x.ctx(), &version, store.Eq("id", x.r.PathValue("version")), store.Eq("doc_id", page.ID)); err != nil {
		return err
	}
	var tree []md.Block
	readStored(version.Snapshot, &tree)
	if x.wantText() || x.r.URL.Query().Get("format") == "md" {
		return x.text(md.Render(tree))
	}
	return x.ok(map[string]any{"version": version, "blocks": tree, "markdown": md.Render(tree)})
}

// handleReportPagePresence says "I am here, in this block" and returns who else is. A
// client calls it every few seconds while a page is open.
func (s *Server) handleReportPagePresence(x *c) error {
	var body struct {
		Block string `json:"block"`
		Leave bool   `json:"leave"`
	}
	if err := x.body(&body); err != nil {
		return err
	}
	page, err := x.docByID(x.ctx(), x.r.PathValue("id"))
	if err != nil {
		return err
	}
	// Presence is kept in the database, so every server shows the same
	// people. A row is worth knowing for a few seconds only.
	now := time.Now().UnixMilli()
	ctx := x.ctx()
	if body.Leave {
		if _, err := x.db.Delete(ctx, "doc_presence", store.Eq("doc_id", page.ID), store.Eq("user_id", x.member.UserID)); err != nil {
			// Best effort: the row is swept once it is presenceKept old.
			s.log.Warn("presence not cleared", "doc", page.ID, "err", err)
		}
	} else if err := x.db.Upsert(ctx, core.Presence{WorkspaceID: x.ws.ID, DocID: page.ID, UserID: x.member.UserID, Block: body.Block, At: now}, "doc_id", "user_id"); err != nil {
		return err
	}
	if _, err := x.db.Delete(ctx, "doc_presence", store.Eq("doc_id", page.ID), store.Lt("at", now-presenceKept.Milliseconds())); err != nil {
		s.log.Warn("old presence not swept", "doc", page.ID, "err", err) // best effort: swept again on the next call
	}
	var here []core.Presence
	if err := x.db.List(ctx, &here, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID), store.Ne("user_id", x.member.UserID)}, Order: "user_id"}); err != nil {
		return err
	}
	others := here
	if others == nil {
		others = []core.Presence{}
	}
	return x.ok(map[string]any{"others": others})
}

// presenceKept is how long a "here" from a reader stands without a new one.
const presenceKept = 15 * time.Second

// ---- generated pages ----

// pageBlocks reads a page's content as the viewer reads it. A page people
// write has the blocks stored for it. A page built from data has none
// stored: its content is built here, each time, for this viewer
// (generatedPage), as rows like the stored ones.
func (who *viewer) pageBlocks(ctx context.Context, page core.Doc) ([]core.Block, error) {
	if page.Generated == "" {
		var blocks []core.Block
		err := who.db.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID), store.Live}, Order: "rank"})
		return blocks, err
	}
	body, err := who.generatedPage(ctx, page)
	if err != nil {
		return nil, err
	}
	return engine.BlockRows(page, md.Parse(body)), nil
}

// generatedPage writes the Markdown of a page built from data: a changelog
// (the tasks done, by week), a decision log (the answered decisions, by
// month) or the open questions, each kept to the page's project when it has
// one, and all of them to the projects the viewer may read. So the page of
// the whole workspace reads differently to different members, and is never
// stored: stored once, it would show everyone what its first reader may see.
// Not stored, it is not in the search index either: what it says is found
// by searching the tasks and decisions themselves (the owner's decision).
func (who *viewer) generatedPage(ctx context.Context, page core.Doc) (string, error) {
	names, err := who.names(ctx)
	if err != nil {
		return "", err
	}
	inProject := func(projectID string) bool {
		return (page.ProjectID == "" || page.ProjectID == projectID) && who.canProject(projectID)
	}
	var b strings.Builder
	switch page.Generated {
	case "changelog":
		// The done tasks, newest first, under a heading for each week.
		tasks, err := who.db.Tasks(ctx, store.TaskFilter{Categories: []string{core.CatDone}, Archived: true, Limit: maxTasksByID})
		if err != nil {
			return "", err
		}
		tasks = keep(tasks, func(t core.Task) bool { return inProject(t.ProjectID) && t.CompletedAt != 0 })
		sort.Slice(tasks, func(i, j int) bool { return tasks[i].CompletedAt > tasks[j].CompletedAt })
		week := ""
		for _, t := range tasks {
			y, wk := time.UnixMilli(t.CompletedAt).UTC().ISOWeek()
			if w := fmt.Sprintf("%d, week %d", y, wk); w != week {
				week = w
				fmt.Fprintf(&b, "\n## %s\n\n", w)
			}
			fmt.Fprintf(&b, "- %s %s", t.Key, t.Title)
			if t.AssigneeID != "" {
				b.WriteString(" (" + names.handle(t.AssigneeID) + ")")
			}
			b.WriteString("\n")
		}
		if len(tasks) == 0 {
			b.WriteString("Nothing is done yet.\n")
		}
	case "decision_log", "open_questions":
		// The decisions, with their answer or who they wait on, and their
		// options.
		conds := []store.Cond{store.Live, store.Ne("state", core.StateOpen)}
		if page.Generated == "open_questions" {
			conds = []store.Cond{store.Live, store.Eq("state", core.StateOpen)}
		}
		var decisions []core.Decision
		if err := who.db.List(ctx, &decisions, store.Q{Where: conds, Order: "-updated_seq", Limit: 2000}); err != nil {
			return "", err
		}
		views, err := who.decisionViews(ctx, decisions)
		if err != nil {
			return "", err
		}
		projectOf := map[string]string{}
		var taskIDs []string
		for _, decision := range decisions {
			taskIDs = append(taskIDs, decision.TaskID)
		}
		tasks, err := who.db.Tasks(ctx, store.TaskFilter{IDs: taskIDs, Archived: true, Limit: maxTasksByID})
		if err != nil {
			return "", err
		}
		for _, t := range tasks {
			projectOf[t.Key] = t.ProjectID
		}
		month, n := "", 0
		for _, v := range views {
			if pid, ok := projectOf[v.Task]; !ok || !inProject(pid) {
				continue
			}
			n++
			at := firstNonEmpty(v.DecidedAt, v.AskedAt)
			if m := at[:min(7, len(at))]; m != month && page.Generated == "decision_log" {
				month = m
				fmt.Fprintf(&b, "\n## %s\n\n", m)
			}
			fmt.Fprintf(&b, "- **%s** %s", v.Task, v.Question)
			if v.State == core.StateOpen {
				fmt.Fprintf(&b, " — asked of %s by %s on %s", firstNonEmpty(v.Asked, "anyone"), v.By, at)
			} else {
				ans := firstNonEmpty(v.PickedLabel, v.Outcome)
				fmt.Fprintf(&b, " → **%s**", ans)
				if v.Outcome != "" && v.Outcome != ans && v.Outcome != core.OutcomeAsIs {
					b.WriteString(" (" + strings.ReplaceAll(v.Outcome, "_", " ") + ")")
				}
				if v.Note != "" {
					b.WriteString(": " + oneLine(v.Note, 400))
				}
				fmt.Fprintf(&b, " — %s, %s", v.DecidedBy, at)
			}
			b.WriteString("\n")
			for _, o := range v.Options {
				mark := ""
				if o.N == v.Picked {
					mark = " ✓"
				}
				fmt.Fprintf(&b, "  - %s%s\n", o.Label, mark)
			}
		}
		if n == 0 {
			b.WriteString("Nothing here yet.\n")
		}
	}
	return b.String(), nil
}

// ---- agent memory ----

// memoryRoot finds the page an agent's notes hang under, and says whether
// it has one yet.
func (who *viewer) memoryRoot(ctx context.Context, agentID string) (core.Doc, bool, error) {
	var roots []core.Doc
	if err := who.db.List(ctx, &roots, store.Q{Where: []store.Cond{store.Eq("memory_of", agentID), store.Null("parent_id"), store.Live}, Order: "created_seq", Limit: 1}); err != nil {
		return core.Doc{}, false, err
	}
	if len(roots) == 0 {
		return core.Doc{}, false, nil
	}
	return roots[0], true, nil
}

// memoryAgent is the agent whose memory is asked for: agent=, or the caller.
func (x *c) memoryAgent() (core.Member, error) {
	ref := x.r.URL.Query().Get("agent")
	if ref == "" {
		ref = "me"
	}
	agent, err := x.resolver(x.ctx()).Member("agent", ref)
	if err != nil {
		return agent, err
	}
	if agent.Kind != core.KindAgent {
		return agent, errBad("@%s is a person; memory pages belong to agents", agent.Handle)
	}
	return agent, nil
}

// handleShowAgentMemory returns an agent's notes: every page under its memory root, as
// Markdown. It is what an agent reads to pick up where it left off.
func (s *Server) handleShowAgentMemory(x *c) error {
	agent, err := x.memoryAgent()
	if err != nil {
		return err
	}
	root, ok, err := x.memoryRoot(x.ctx(), agent.UserID)
	if err != nil {
		return err
	}
	if !ok {
		if !x.wantText() {
			return x.ok(map[string]any{"pages": []any{}})
		}
		return x.text("no notes yet; write one with POST /memory {title, markdown}\n")
	}
	var pages []core.Doc
	if err := x.db.List(x.ctx(), &pages, store.Q{Where: []store.Cond{store.Eq("memory_of", agent.UserID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	type page struct {
		ID       string `json:"id"`
		Title    string `json:"title"`
		Markdown string `json:"markdown"`
		Seq      int64  `json:"seq"`
	}
	var out []page
	for _, doc := range pages {
		if doc.ID == root.ID {
			continue
		}
		var blocks []core.Block
		if err := x.db.List(x.ctx(), &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", doc.ID), store.Live}, Order: "rank"}); err != nil {
			return err
		}
		out = append(out, page{ID: doc.ID, Title: doc.Title, Markdown: md.Render(engine.BlockTree(blocks)), Seq: doc.ContentSeq})
	}
	if !x.wantText() {
		return x.ok(map[string]any{"agent": "@" + agent.Handle, "pages": out})
	}
	var b strings.Builder
	for _, note := range out {
		fmt.Fprintf(&b, "# %s\n\n%s\n", note.Title, note.Markdown)
	}
	if b.Len() == 0 {
		b.WriteString("no notes yet\n")
	}
	return x.text(b.String())
}

// handleSaveAgentMemory saves a note: the page with this title under the caller's
// memory, made if it is not there. Mode append adds to it. The memory's root
// page is made with the first note, in the same batch. dry_run=1 checks the
// note without saving it.
func (s *Server) handleSaveAgentMemory(x *c) error {
	var b struct {
		Title    string `json:"title"`
		Markdown string `json:"markdown"`
		Mode     string `json:"mode"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	if x.member.Kind != core.KindAgent {
		return errBad("memory pages are written by the agent they belong to; edit them as pages instead")
	}
	title := strings.TrimSpace(b.Title)
	if title == "" {
		return errBad("a note needs a title")
	}
	ctx := x.ctx()
	var changes []engine.Change
	add := func(typ string, args map[string]any) {
		changes = append(changes, engine.Change{ID: id.New(), Type: typ, Args: plainjson.Marshal(args)})
	}
	root, there, err := x.memoryRoot(ctx, x.member.UserID)
	if err != nil {
		return err
	}
	if !there {
		root.ID = id.New()
		add("doc.create", map[string]any{"id": root.ID, "title": x.member.Name + ": memory", "memory_of": "me", "icon": "brain"})
	}
	var page core.Doc
	if there {
		if there, err = store.Find(ctx, x.db, &page, store.Eq("parent_id", root.ID), store.Eq("title", title), store.Live); err != nil {
			return err
		}
	}
	status := http.StatusOK
	if there {
		add("doc.write", map[string]any{"doc": page.ID, "markdown": b.Markdown, "mode": b.Mode})
	} else {
		page.ID, status = id.New(), http.StatusCreated
		add("doc.create", map[string]any{"id": page.ID, "parent": root.ID, "title": title, "markdown": b.Markdown})
	}
	dry := truthyParam(x.r.URL.Query(), "dry_run")
	res, err := s.eng.Batch(ctx, x.ws.ID, x.actor, changes, dry)
	if err != nil {
		return err
	}
	out := map[string]any{"doc": page.ID, "seq": res[len(res)-1].Seq}
	if dry {
		out["dry_run"], status = true, http.StatusOK
	}
	return x.json(status, out)
}
