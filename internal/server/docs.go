package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		const w = "/api/v1/w/{ws}"
		m.HandleFunc("GET "+w+"/docs", s.in(s.hDocs))
		m.HandleFunc("GET "+w+"/docs/{id}", s.in(s.hDoc))
		m.HandleFunc("GET "+w+"/docs/{id}/versions", s.in(s.hDocVersions))
		m.HandleFunc("GET "+w+"/docs/{id}/versions/{version}", s.in(s.hDocVersion))
		m.HandleFunc("POST "+w+"/docs/{id}/presence", s.in(s.hDocPresence))
		m.HandleFunc("GET "+w+"/docs/{id}/rows", s.in(s.hRows))
		m.HandleFunc("GET "+w+"/memory", s.in(s.hMemory))
		m.HandleFunc("POST "+w+"/memory", s.in(s.hMemoryWrite))
	})
}

// docByID loads a page the caller may see.
func (x *c) docByID(ref string) (core.Doc, error) {
	var d core.Doc
	if err := x.db.Get(x.ctx(), &d, store.Eq("id", ref), store.Live); err != nil || !engine.CanSeeDoc(d, x.member.UserID) || !x.canProject(d.ProjectID) {
		return d, errNotFound("doc " + ref)
	}
	return d, nil
}

func (x *c) visibleDocs() ([]core.Doc, error) {
	var docs []core.Doc
	if err := x.db.List(x.ctx(), &docs, store.Q{Where: []store.Cond{store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	return keep(docs, func(d core.Doc) bool { return engine.CanSeeDoc(d, x.member.UserID) && x.canProject(d.ProjectID) }), nil
}

// hDocs lists the page tree. The text form is an indented outline with ids.
func (s *Server) hDocs(x *c) error {
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
	if !x.wantText() {
		return x.ok(map[string]any{"docs": docs})
	}
	kids := map[string][]core.Doc{}
	for _, d := range docs {
		kids[d.ParentID] = append(kids[d.ParentID], d)
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
			fmt.Fprintf(&b, "%s%s%s  (%s)\n", indent, orText(d.Title, "Untitled"), note, d.ID)
			walk(d.ID, indent+"  ")
		}
	}
	walk("", "")
	if b.Len() == 0 {
		b.WriteString("no pages\n")
	}
	return x.text(b.String())
}

// hDoc returns one page: as rows for the editor, or as Markdown.
func (s *Server) hDoc(x *c) error {
	ctx := x.ctx()
	d, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	if d.Generated != "" {
		if err := s.regenerate(x, &d); err != nil {
			s.log.Error("generated page", "doc", d.ID, "err", err)
		}
	}
	var blocks []core.Block
	if err := x.db.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	format := x.r.URL.Query().Get("format")
	if format == "md" || x.wantText() {
		body := md.Render(engine.BlockTree(blocks))
		text, cutOff := cut(body, x.maxChars())
		if cutOff {
			text += "\n… (cut; add full=1)\n"
		}
		if format == "md" {
			return x.text(text)
		}
		return x.text(fmt.Sprintf("# %s\n(doc %s, seq %d)\n\n%s", orText(d.Title, "Untitled"), d.ID, d.ContentSeq, text))
	}
	out := map[string]any{"doc": d, "blocks": blocks}
	var children []core.Doc
	if err := x.db.List(ctx, &children, store.Q{Where: []store.Cond{store.Eq("parent_id", d.ID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	if d.Kind == core.DocDatabase {
		var props []core.DBProperty
		var views []core.DBView
		if err := x.db.List(ctx, &props, store.Q{Where: []store.Cond{store.Eq("database_id", d.ID), store.Live}, Order: "rank"}); err != nil {
			return err
		}
		if err := x.db.List(ctx, &views, store.Q{Where: []store.Cond{store.Eq("database_id", d.ID), store.Live}, Order: "rank"}); err != nil {
			return err
		}
		out["properties"], out["views"] = props, views
		out["rows"] = keep(children, func(c core.Doc) bool { return c.Kind == core.DocRow })
		children = keep(children, func(c core.Doc) bool { return c.Kind != core.DocRow })
	}
	out["children"] = children
	var comments []core.Comment
	if err := x.db.List(ctx, &comments, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID), store.Live}, Order: "created_seq"}); err != nil {
		return err
	}
	out["comments"] = comments
	// What mentions this page, and what it mentions.
	var back, fwd []core.Ref
	if err := x.db.List(ctx, &back, store.Where(store.Eq("to_id", d.ID))); err != nil {
		return err
	}
	if err := x.db.List(ctx, &fwd, store.Where(store.Eq("from_scope_id", d.ID))); err != nil {
		return err
	}
	out["mentioned_in"], out["mentions"] = back, fwd
	_, atts, err := x.attachments(store.Eq("subject_id", d.ID))
	if err != nil {
		return err
	}
	out["attachments"] = atts
	if d.SourceID != "" {
		var src core.DocSource
		if x.db.Get(ctx, &src, store.Eq("id", d.SourceID)) == nil {
			out["source"] = src
		}
	}
	return x.ok(out)
}

func (s *Server) hDocVersions(x *c) error {
	d, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	var vs []core.DocVersion
	if err := x.db.List(x.ctx(), &vs, store.Q{Where: []store.Cond{store.Eq("doc_id", d.ID)}, Order: "-seq", Limit: 500}); err != nil {
		return err
	}
	for i := range vs {
		vs[i].Snapshot = nil // listed without their content
	}
	return x.ok(map[string]any{"versions": vs})
}

func (s *Server) hDocVersion(x *c) error {
	d, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	var v core.DocVersion
	if err := x.db.Get(x.ctx(), &v, store.Eq("id", x.r.PathValue("version")), store.Eq("doc_id", d.ID)); err != nil {
		return errNotFound("version")
	}
	var tree []md.Block
	json.Unmarshal(v.Snapshot, &tree)
	if x.wantText() || x.r.URL.Query().Get("format") == "md" {
		return x.text(md.Render(tree))
	}
	return x.ok(map[string]any{"version": v, "blocks": tree, "markdown": md.Render(tree)})
}

// presence is who has a page open and which block they are in. It is kept
// in memory: it is only worth knowing for a few seconds.
type presence struct {
	mu   sync.Mutex
	docs map[string]map[string]presenceEntry // doc id -> user id
}

type presenceEntry struct {
	UserID string `json:"user_id"`
	Block  string `json:"block,omitempty"`
	At     int64  `json:"at"`
}

var pagePresence = presence{docs: map[string]map[string]presenceEntry{}}

// hDocPresence says "I am here, in this block" and returns who else is. A
// client calls it every few seconds while a page is open.
func (s *Server) hDocPresence(x *c) error {
	var b struct {
		Block string `json:"block"`
		Leave bool   `json:"leave"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	d, err := x.docByID(x.r.PathValue("id"))
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	pagePresence.mu.Lock()
	defer pagePresence.mu.Unlock()
	here := pagePresence.docs[d.ID]
	if here == nil {
		here = map[string]presenceEntry{}
		pagePresence.docs[d.ID] = here
	}
	if b.Leave {
		delete(here, x.member.UserID)
	} else {
		here[x.member.UserID] = presenceEntry{UserID: x.member.UserID, Block: b.Block, At: now}
	}
	others := []presenceEntry{}
	for uid, e := range here {
		if now-e.At > 15_000 {
			delete(here, uid)
		} else if uid != x.member.UserID {
			others = append(others, e)
		}
	}
	if len(here) == 0 {
		delete(pagePresence.docs, d.ID)
	}
	return x.ok(map[string]any{"others": others})
}

// ---- generated pages ----

// regenerate rebuilds a page that is made from data, when the data it shows
// has changed since it was last built.
func (s *Server) regenerate(x *c, d *core.Doc) error {
	ctx := x.ctx()
	var meta struct {
		BuiltSeq int64 `json:"built_seq"`
	}
	json.Unmarshal(d.Props, &meta)
	var projects []string
	if d.ProjectID != "" {
		projects = []string{d.ProjectID}
	}
	if meta.BuiltSeq > 0 {
		news, err := x.db.Events(ctx, store.EventFilter{After: meta.BuiltSeq, ProjectIDs: projects, Limit: 1,
			Types: []string{"decision.opened", "decision.picked", "decision.unclear", "decision.deleted", "task.updated", "task.created"}})
		if err != nil || len(news) == 0 {
			return err
		}
	}
	body, err := s.generated(x, *d)
	if err != nil {
		return err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	props, _ := json.Marshal(map[string]int64{"built_seq": ws.Seq})
	err = s.eng.System(ctx, x.ws.ID, d.CreatedBy, func(sys *engine.Sys) error {
		if err := sys.Do("doc.write", map[string]any{"doc": d.ID, "markdown": body}); err != nil {
			return err
		}
		_, err := sys.Tx().Update(ctx, "docs", map[string]any{"props": json.RawMessage(props)}, store.Eq("id", d.ID))
		return err
	})
	if err == nil {
		d.Props = props
	}
	return err
}

// generated writes the Markdown of a page built from data.
func (s *Server) generated(x *c, d core.Doc) (string, error) {
	ctx := x.ctx()
	nm, err := x.names()
	if err != nil {
		return "", err
	}
	inProject := func(projectID string) bool { return d.ProjectID == "" || d.ProjectID == projectID }
	var b strings.Builder
	switch d.Generated {
	case "changelog":
		tasks, err := x.db.Tasks(ctx, store.TaskFilter{Categories: []string{core.CatDone}, Archived: true, Limit: 5000})
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
				b.WriteString(" (" + nm.handle(t.AssigneeID) + ")")
			}
			b.WriteString("\n")
		}
		if len(tasks) == 0 {
			b.WriteString("Nothing is done yet.\n")
		}
	case "decision_log", "open_questions":
		conds := []store.Cond{store.Live, store.Ne("state", core.StateOpen)}
		if d.Generated == "open_questions" {
			conds = []store.Cond{store.Live, store.Eq("state", core.StateOpen)}
		}
		var ds []core.Decision
		if err := x.db.List(ctx, &ds, store.Q{Where: conds, Order: "-updated_seq", Limit: 2000}); err != nil {
			return "", err
		}
		views, err := x.decisionViews(ds, false)
		if err != nil {
			return "", err
		}
		projectOf := map[string]string{}
		var tids []string
		for _, dc := range ds {
			tids = append(tids, dc.TaskID)
		}
		ts, err := x.db.Tasks(ctx, store.TaskFilter{IDs: tids, Archived: true, Limit: 5000})
		if err != nil {
			return "", err
		}
		for _, t := range ts {
			projectOf[t.Key] = t.ProjectID
		}
		month, n := "", 0
		for _, v := range views {
			if pid, ok := projectOf[v.Task]; !ok || !inProject(pid) {
				continue
			}
			n++
			at := orText(v.DecidedAt, v.AskedAt)
			if m := at[:min(7, len(at))]; m != month && d.Generated == "decision_log" {
				month = m
				fmt.Fprintf(&b, "\n## %s\n\n", m)
			}
			fmt.Fprintf(&b, "- **%s** %s", v.Task, v.Question)
			if v.State == core.StateOpen {
				fmt.Fprintf(&b, " — asked of %s by %s on %s", orText(v.Asked, "anyone"), v.By, at)
			} else {
				ans := orText(v.PickedLabel, v.Outcome)
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

// memoryRoot finds the page an agent's notes hang under.
func (x *c) memoryRoot(agentID string) (core.Doc, bool) {
	var roots []core.Doc
	x.db.List(x.ctx(), &roots, store.Q{Where: []store.Cond{store.Eq("memory_of", agentID), store.Null("parent_id"), store.Live}, Order: "created_seq", Limit: 1})
	if len(roots) == 0 {
		return core.Doc{}, false
	}
	return roots[0], true
}

func (x *c) memoryAgent() (core.Member, error) {
	ref := x.r.URL.Query().Get("agent")
	if ref == "" {
		ref = "me"
	}
	m, err := x.resolver().Member("agent", ref)
	if err != nil {
		return m, err
	}
	if m.Kind != core.KindAgent {
		return m, errBad("@%s is a person; memory pages belong to agents", m.Handle)
	}
	return m, nil
}

// hMemory returns an agent's notes: every page under its memory root, as
// Markdown. It is what an agent reads to pick up where it left off.
func (s *Server) hMemory(x *c) error {
	m, err := x.memoryAgent()
	if err != nil {
		return err
	}
	root, ok := x.memoryRoot(m.UserID)
	if !ok {
		return x.text("no notes yet; write one with POST /memory {title, markdown}\n")
	}
	var pages []core.Doc
	if err := x.db.List(x.ctx(), &pages, store.Q{Where: []store.Cond{store.Eq("memory_of", m.UserID), store.Live}, Order: "rank"}); err != nil {
		return err
	}
	type page struct {
		ID       string `json:"id"`
		Title    string `json:"title"`
		Markdown string `json:"markdown"`
		Seq      int64  `json:"seq"`
	}
	var out []page
	for _, p := range pages {
		if p.ID == root.ID {
			continue
		}
		var blocks []core.Block
		if err := x.db.List(x.ctx(), &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", p.ID), store.Live}, Order: "rank"}); err != nil {
			return err
		}
		out = append(out, page{ID: p.ID, Title: p.Title, Markdown: md.Render(engine.BlockTree(blocks)), Seq: p.ContentSeq})
	}
	if !x.wantText() {
		return x.ok(map[string]any{"agent": "@" + m.Handle, "pages": out})
	}
	var b strings.Builder
	for _, p := range out {
		fmt.Fprintf(&b, "# %s\n\n%s\n", p.Title, p.Markdown)
	}
	if b.Len() == 0 {
		b.WriteString("no notes yet\n")
	}
	return x.text(b.String())
}

// hMemoryWrite saves a note: the page with this title under the caller's
// memory, made if it is not there. Mode append adds to it.
func (s *Server) hMemoryWrite(x *c) error {
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
	mk := func(typ string, args map[string]any) (*engine.Result, error) {
		raw, _ := json.Marshal(args)
		return s.eng.Apply(ctx, x.ws.ID, x.actor, engine.Change{ID: id.New(), Type: typ, Args: raw})
	}
	root, ok := x.memoryRoot(x.member.UserID)
	if !ok {
		res, err := mk("doc.create", map[string]any{"title": x.member.Name + ": memory", "memory_of": "me", "icon": "brain"})
		if err != nil {
			return err
		}
		root.ID = res.Ref
	}
	var page core.Doc
	err := x.db.Get(ctx, &page, store.Eq("parent_id", root.ID), store.Eq("title", strings.TrimSpace(b.Title)), store.Live)
	if err != nil {
		res, err := mk("doc.create", map[string]any{"parent": root.ID, "title": strings.TrimSpace(b.Title), "markdown": b.Markdown})
		if err != nil {
			return err
		}
		return x.json(201, map[string]any{"doc": res.Ref, "seq": res.Seq})
	}
	res, err := mk("doc.write", map[string]any{"doc": page.ID, "markdown": b.Markdown, "mode": b.Mode})
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"doc": page.ID, "seq": res.Seq})
}

var _ = context.Background
