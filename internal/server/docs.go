// Pages: the page tree, one page, its versions and who else has it open;
// pages built from data; and an agent's memory pages.

package server

import (
	"encoding/json"
	"errors"
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
	"github.com/agrigoryan/quadit/internal/store"
)

// init adds the page routes to the server's routes.
func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		const w = "/api/v1/w/{ws}"
		m.HandleFunc("GET "+w+"/docs", s.workspaceMember(s.handleListPages))
		m.HandleFunc("GET "+w+"/docs/{id}", s.workspaceMember(s.handleShowPage))
		m.HandleFunc("GET "+w+"/docs/{id}/versions", s.workspaceMember(s.handleListPageVersions))
		m.HandleFunc("GET "+w+"/docs/{id}/versions/{version}", s.workspaceMember(s.handleShowPageVersion))
		m.HandleFunc("POST "+w+"/docs/{id}/presence", s.workspaceMember(s.handleReportPagePresence))
		m.HandleFunc("GET "+w+"/docs/{id}/rows", s.workspaceMember(s.handleListDatabaseRows))
		m.HandleFunc("GET "+w+"/memory", s.workspaceMember(s.handleShowAgentMemory))
		m.HandleFunc("POST "+w+"/memory", s.workspaceMember(s.handleSaveAgentMemory))
	})
}

// docByID loads a page the caller may see. A page the caller may not see
// is not found, as one that does not exist.
func (x *c) docByID(ref string) (core.Doc, error) {
	var doc core.Doc
	err := x.db.Get(x.ctx(), &doc, store.Eq("id", ref), store.Live)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return doc, err
	}
	if err != nil || !engine.CanSeeDoc(doc, x.member.UserID) || !x.canProject(doc.ProjectID) {
		return doc, errNotFound("doc " + ref)
	}
	return doc, nil
}

// visibleDocs lists, in their order, the pages the caller may see.
func (x *c) visibleDocs() ([]core.Doc, error) {
	var docs []core.Doc
	if err := x.db.List(x.ctx(), &docs, store.Q{Where: []store.Cond{store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	return keep(docs, func(d core.Doc) bool { return engine.CanSeeDoc(d, x.member.UserID) && x.canProject(d.ProjectID) }), nil
}

// handleListPages lists the page tree. The text form is an indented outline with ids.
func (s *Server) handleListPages(x *c) error {
	if truthyParam(x.r.URL.Query(), "trash") {
		var gone []core.Doc
		if err := x.db.List(x.ctx(), &gone, store.Q{Where: []store.Cond{store.NotNull("deleted_at")}, Order: "-deleted_at", Limit: 1000}); err != nil {
			return err
		}
		gone = keep(gone, func(d core.Doc) bool {
			return engine.CanSeeDoc(d, x.member.UserID) && x.canProject(d.ProjectID) && d.Kind != core.DocRow
		})
		return x.ok(map[string]any{"docs": gone})
	}
	docs, err := x.visibleDocs()
	if err != nil {
		return err
	}
	docs = keep(docs, func(d core.Doc) bool { return d.Kind != core.DocRow })
	if ref := x.r.URL.Query().Get("project"); ref != "" {
		project, err := x.resolver().Project(ref)
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
	names, err := x.names()
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
// A page built from data is rebuilt first when its data changed.
func (s *Server) handleShowPage(x *c) error {
	page, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	if page.Generated != "" {
		if err := s.regenerate(x, &page); err != nil {
			s.log.Error("generated page", "doc", page.ID, "err", err)
		}
	}
	var blocks []core.Block
	if err := x.db.List(x.ctx(), &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	if format := x.r.URL.Query().Get("format"); format == "md" || x.wantText() {
		return x.text(pageText(page, blocks, format, x.maxChars()))
	}
	out, err := x.pageAnswer(page, blocks)
	if err != nil {
		return err
	}
	return x.ok(out)
}

// pageText is a page as Markdown, cut at maxChars: alone for format=md,
// else under a heading that names the page.
func pageText(page core.Doc, blocks []core.Block, format string, maxChars int) string {
	body := md.Render(engine.BlockTree(blocks))
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
func (x *c) pageAnswer(page core.Doc, blocks []core.Block) (map[string]any, error) {
	ctx := x.ctx()
	out := map[string]any{"doc": page, "blocks": blocks}
	var children []core.Doc
	if err := x.db.List(ctx, &children, store.Q{Where: []store.Cond{store.Eq("parent_id", page.ID), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	if page.Kind == core.DocDatabase {
		// A database's children are its rows; any others are its sub-pages.
		var props []core.DBProperty
		var views []core.DBView
		if err := x.db.List(ctx, &props, store.Q{Where: []store.Cond{store.Eq("database_id", page.ID), store.Live}, Order: "rank"}); err != nil {
			return nil, err
		}
		if err := x.db.List(ctx, &views, store.Q{Where: []store.Cond{store.Eq("database_id", page.ID), store.Live}, Order: "rank"}); err != nil {
			return nil, err
		}
		out["properties"], out["views"] = props, views
		out["rows"] = keep(children, func(child core.Doc) bool { return child.Kind == core.DocRow })
		children = keep(children, func(child core.Doc) bool { return child.Kind != core.DocRow })
	}
	out["children"] = children
	var comments []core.Comment
	if err := x.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("doc_id", page.ID), store.Live}, Order: "created_seq"}); err != nil {
		return nil, err
	}
	out["comments"] = comments
	// What mentions this page, and what it mentions.
	var back, fwd []core.Ref
	if err := x.db.List(ctx, &back, store.Where(store.Eq("to_id", page.ID))); err != nil {
		return nil, err
	}
	if err := x.db.List(ctx, &fwd, store.Where(store.Eq("from_scope_id", page.ID))); err != nil {
		return nil, err
	}
	out["mentioned_in"], out["mentions"] = back, fwd
	_, atts, err := x.attachments(store.Eq("subject_id", page.ID))
	if err != nil {
		return nil, err
	}
	out["attachments"] = atts
	if page.SourceID != "" {
		var source core.DocSource
		err := x.db.Get(ctx, &source, store.Eq("id", page.SourceID))
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		if err == nil {
			out["source"] = source
		}
	}
	return out, nil
}

// handleListPageVersions lists a page's saved versions, newest first,
// without their content.
func (s *Server) handleListPageVersions(x *c) error {
	page, err := x.docByID(x.r.PathValue("id"))
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
	page, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	var version core.DocVersion
	err = x.db.Get(x.ctx(), &version, store.Eq("id", x.r.PathValue("version")), store.Eq("doc_id", page.ID))
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("version")
	}
	if err != nil {
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
	page, err := x.docByID(x.r.PathValue("id"))
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

// regenerate rebuilds a page that is made from data, when the data it shows
// has changed since it was last built.
func (s *Server) regenerate(x *c, page *core.Doc) error {
	ctx := x.ctx()
	var meta struct {
		BuiltSeq int64 `json:"built_seq"`
	}
	readStored(page.Props, &meta)
	var projects []string
	if page.ProjectID != "" {
		projects = []string{page.ProjectID}
	}
	if meta.BuiltSeq > 0 {
		news, err := x.db.Events(ctx, store.EventFilter{After: meta.BuiltSeq, ProjectIDs: projects, Limit: 1,
			Types: []string{"decision.opened", "decision.picked", "decision.unclear", "decision.deleted", "task.updated", "task.created"}})
		if err != nil || len(news) == 0 {
			return err
		}
	}
	body, err := s.generated(x, *page)
	if err != nil {
		return err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	props, _ := json.Marshal(map[string]int64{"built_seq": ws.Seq}) // cannot fail: a map of numbers
	err = s.eng.System(ctx, x.ws.ID, page.CreatedBy, func(sys *engine.Sys) error {
		if err := sys.Do("doc.write", map[string]any{"doc": page.ID, "markdown": body}); err != nil {
			return err
		}
		_, err := sys.Tx().Update(ctx, "docs", map[string]any{"props": json.RawMessage(props)}, store.Eq("id", page.ID))
		return err
	})
	if err == nil {
		page.Props = props
	}
	return err
}

// generated writes the Markdown of a page built from data: a changelog (the
// tasks done, by week), a decision log (the answered decisions, by month) or
// the open questions, each kept to the page's project when it has one.
func (s *Server) generated(x *c, page core.Doc) (string, error) {
	ctx := x.ctx()
	names, err := x.names()
	if err != nil {
		return "", err
	}
	inProject := func(projectID string) bool { return page.ProjectID == "" || page.ProjectID == projectID }
	var b strings.Builder
	switch page.Generated {
	case "changelog":
		// The done tasks, newest first, under a heading for each week.
		tasks, err := x.db.Tasks(ctx, store.TaskFilter{Categories: []string{core.CatDone}, Archived: true, Limit: maxTasksByID})
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
		if err := x.db.List(ctx, &decisions, store.Q{Where: conds, Order: "-updated_seq", Limit: 2000}); err != nil {
			return "", err
		}
		views, err := x.decisionViews(decisions)
		if err != nil {
			return "", err
		}
		projectOf := map[string]string{}
		var taskIDs []string
		for _, decision := range decisions {
			taskIDs = append(taskIDs, decision.TaskID)
		}
		tasks, err := x.db.Tasks(ctx, store.TaskFilter{IDs: taskIDs, Archived: true, Limit: maxTasksByID})
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
func (x *c) memoryRoot(agentID string) (core.Doc, bool, error) {
	var roots []core.Doc
	if err := x.db.List(x.ctx(), &roots, store.Q{Where: []store.Cond{store.Eq("memory_of", agentID), store.Null("parent_id"), store.Live}, Order: "created_seq", Limit: 1}); err != nil {
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
	agent, err := x.resolver().Member("agent", ref)
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
	root, ok, err := x.memoryRoot(agent.UserID)
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
// page is made with the first note.
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
	if strings.TrimSpace(b.Title) == "" {
		return errBad("a note needs a title")
	}
	ctx := x.ctx()
	apply := func(typ string, args map[string]any) (*engine.Result, error) {
		raw, _ := json.Marshal(args) // cannot fail: strings
		return s.eng.Apply(ctx, x.ws.ID, x.actor, engine.Change{ID: id.New(), Type: typ, Args: raw})
	}
	root, ok, err := x.memoryRoot(x.member.UserID)
	if err != nil {
		return err
	}
	if !ok {
		res, err := apply("doc.create", map[string]any{"title": x.member.Name + ": memory", "memory_of": "me", "icon": "brain"})
		if err != nil {
			return err
		}
		root.ID = res.Ref
	}
	var page core.Doc
	err = x.db.Get(ctx, &page, store.Eq("parent_id", root.ID), store.Eq("title", strings.TrimSpace(b.Title)), store.Live)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err != nil {
		res, err := apply("doc.create", map[string]any{"parent": root.ID, "title": strings.TrimSpace(b.Title), "markdown": b.Markdown})
		if err != nil {
			return err
		}
		return x.json(http.StatusCreated, map[string]any{"doc": res.Ref, "seq": res.Seq})
	}
	res, err := apply("doc.write", map[string]any{"doc": page.ID, "markdown": b.Markdown, "mode": b.Mode})
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"doc": page.ID, "seq": res.Seq})
}
