package server

import (
	"archive/zip"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/formula"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/w/{ws}/export", s.in(s.hExport))
	})
}

const exportReadme = `This is an export of one workspace, in open formats.

tasks/   one Markdown file per task: its fields, description, decisions and comments
docs/    one Markdown file per page, in folders that follow the page tree;
         a database is a CSV file beside a folder of its rows
data/    every row of the workspace as JSON, one file per kind, for programs
files/   the uploaded files, as they were uploaded

Nothing here needs this product to be read.
`

func fileSafe(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 {
			return '-'
		}
		return r
	}, strings.TrimSpace(s))
	if len(s) > 80 {
		s = strings.TrimSpace(s[:80])
	}
	if s == "" || s == "." || s == ".." {
		s = "untitled"
	}
	return s
}

// hExport writes the whole workspace as a zip of Markdown, JSON and the
// original files.
func (s *Server) hExport(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	ctx := x.ctx()
	nm, err := x.names()
	if err != nil {
		return err
	}
	s.audit(x.r, x.ws.ID, x.user, "workspace.exported", "workspace", x.ws.ID, nil)
	x.w.Header().Set("Content-Type", "application/zip")
	x.w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.zip"`, x.ws.Slug, time.Now().UTC().Format("2006-01-02")))
	zw := zip.NewWriter(x.w)
	defer zw.Close()
	put := func(name, body string) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(w, body)
		return err
	}
	if err := put("README.txt", exportReadme); err != nil {
		return err
	}

	// data/: every workspace table as JSON.
	dump := func(name string, rows any) error {
		w, err := zw.Create("data/" + name + ".json")
		if err != nil {
			return err
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", " ")
		return enc.Encode(rows)
	}
	list := func(name string, dst any, q store.Q) error {
		if err := x.db.List(ctx, dst, q); err != nil {
			return err
		}
		return dump(name, reflect.ValueOf(dst).Elem().Interface())
	}
	var (
		members   []core.Member
		projects  []core.Project
		statuses  []core.Status
		labels    []core.Label
		epics     []core.Epic
		miles     []core.Milestone
		cycles    []core.Cycle
		decisions []core.Decision
		options   []core.Option
		comments  []core.Comment
		relations []core.Relation
		links     []core.TaskLink
		atts      []core.Attachment
		files     []core.File
		docs      []core.Doc
		blocks    []core.Block
		props     []core.DBProperty
		prefs     []core.Preference
		views     []core.View
	)
	live := store.Where(store.Live)
	for _, step := range []func() error{
		func() error { return list("members", &members, store.Q{}) },
		func() error { return list("projects", &projects, live) },
		func() error { return list("statuses", &statuses, live) },
		func() error { return list("labels", &labels, live) },
		func() error { return list("epics", &epics, live) },
		func() error { return list("milestones", &miles, live) },
		func() error { return list("cycles", &cycles, live) },
		func() error { return list("decisions", &decisions, store.Q{Where: live.Where, Order: "created_seq"}) },
		func() error { return list("decision_options", &options, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return list("comments", &comments, store.Q{Where: live.Where, Order: "created_seq"}) },
		func() error { return list("relations", &relations, store.Q{}) },
		func() error { return list("links", &links, live) },
		func() error { return list("attachments", &atts, live) },
		func() error { return list("files", &files, live) },
		func() error { return list("docs", &docs, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return list("blocks", &blocks, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return list("properties", &props, store.Q{Where: live.Where, Order: "rank"}) },
		func() error { return list("preferences", &prefs, live) },
		func() error { return list("views", &views, live) },
	} {
		if err := step(); err != nil {
			return err
		}
	}
	tasks, err := x.db.Tasks(ctx, store.TaskFilter{Archived: true, Limit: 5000, Sort: "key"})
	for more := tasks; err == nil && len(more) == 5000; {
		more, err = x.db.Tasks(ctx, store.TaskFilter{Archived: true, Limit: 5000, Offset: len(tasks), Sort: "key"})
		tasks = append(tasks, more...)
	}
	if err != nil {
		return err
	}
	if err := dump("tasks", tasks); err != nil {
		return err
	}
	evs, err := x.db.Events(ctx, store.EventFilter{Limit: 2000})
	for page := evs; err == nil && len(page) == 2000; {
		page, err = x.db.Events(ctx, store.EventFilter{After: evs[len(evs)-1].Seq, Limit: 2000})
		evs = append(evs, page...)
	}
	if err != nil {
		return err
	}
	if err := dump("events", evs); err != nil {
		return err
	}

	// tasks/: one readable file each.
	optsOf := map[string][]core.Option{}
	for _, o := range options {
		optsOf[o.DecisionID] = append(optsOf[o.DecisionID], o)
	}
	fileOf := map[string]core.File{}
	for _, f := range files {
		fileOf[f.ID] = f
	}
	filesOn := map[string][]string{}
	for _, a := range atts {
		if f, ok := fileOf[a.FileID]; ok {
			filesOn[a.SubjectID] = append(filesOn[a.SubjectID], "files/"+f.ID+"/"+fileSafe(f.Name))
		}
	}
	keyOf := map[string]string{}
	for _, t := range tasks {
		keyOf[t.ID] = t.Key
	}
	for _, t := range tasks {
		var b strings.Builder
		st := nm.statuses[t.StatusID]
		fmt.Fprintf(&b, "---\nkey: %s\ntitle: %q\nstatus: %q\n", t.Key, t.Title, st.Name)
		if t.AssigneeID != "" {
			fmt.Fprintf(&b, "assignee: %q\n", nm.handle(t.AssigneeID))
		}
		if t.WaitingOnID != "" {
			fmt.Fprintf(&b, "waiting_on: %q\n", nm.handle(t.WaitingOnID))
		}
		if t.Priority > 0 {
			fmt.Fprintf(&b, "priority: %s\n", priorityNames[t.Priority])
		}
		if ls := nm.labelNames(t.LabelIDs); len(ls) > 0 {
			fmt.Fprintf(&b, "labels: [%s]\n", strings.Join(ls, ", "))
		}
		if e, ok := nm.epics[t.EpicID]; ok {
			fmt.Fprintf(&b, "epic: %q\n", e.Name)
		}
		if t.ParentID != "" {
			fmt.Fprintf(&b, "parent: %s\n", keyOf[t.ParentID])
		}
		if t.DueOn != "" {
			fmt.Fprintf(&b, "due: %s\n", t.DueOn)
		}
		fmt.Fprintf(&b, "created: %s\ncreated_by: %q\n", time.UnixMilli(t.CreatedAt).UTC().Format(time.RFC3339), nm.handle(t.CreatedBy))
		if t.CompletedAt != 0 {
			fmt.Fprintf(&b, "completed: %s\n", time.UnixMilli(t.CompletedAt).UTC().Format(time.RFC3339))
		}
		fmt.Fprintf(&b, "---\n\n# %s\n\n%s\n", t.Title, t.Description)
		for _, f := range filesOn[t.ID] {
			fmt.Fprintf(&b, "\n- file: ../../%s", f)
		}
		n := 0
		for _, d := range decisions {
			if d.TaskID != t.ID {
				continue
			}
			n++
			fmt.Fprintf(&b, "\n\n## Decision %d: %s\n\n", n, d.Question)
			if d.Details != "" {
				b.WriteString(d.Details + "\n\n")
			}
			for i, o := range optsOf[d.ID] {
				mark := ""
				if o.ID == d.PickedOptionID {
					mark = " **(picked)**"
				} else if o.ID == d.RecommendedOptionID {
					mark = " (recommended)"
				}
				fmt.Fprintf(&b, "%d. %s%s", i+1, o.Label, mark)
				if o.Description != "" {
					b.WriteString(": " + o.Description)
				}
				for _, f := range filesOn[o.ID] {
					fmt.Fprintf(&b, " [file](../../%s)", f)
				}
				b.WriteString("\n")
			}
			fmt.Fprintf(&b, "\nAsked by %s", nm.handle(d.CreatedBy))
			if d.AskedID != "" {
				b.WriteString(" of " + nm.handle(d.AskedID))
			}
			if d.Outcome != "" {
				fmt.Fprintf(&b, ". Answer: %s by %s on %s", strings.ReplaceAll(d.Outcome, "_", " "), nm.handle(d.DecidedBy), when(d.DecidedAt))
				if d.OutcomeNote != "" {
					b.WriteString(": " + d.OutcomeNote)
				}
			}
			b.WriteString("\n")
		}
		first := true
		for _, cm := range comments {
			if cm.TaskID != t.ID {
				continue
			}
			if first {
				b.WriteString("\n\n## Comments\n")
				first = false
			}
			fmt.Fprintf(&b, "\n**%s**, %s", nm.handle(cm.AuthorID), when(cm.CreatedAt))
			if cm.Kind == "result" {
				b.WriteString(" (result)")
			}
			b.WriteString("\n\n" + cm.Body + "\n")
			if e := cm.Evidence; e != nil {
				fmt.Fprintf(&b, "\n- checked: %s\n- measured: %s\n- not verified: %s\n", e.Checked, e.Measured, e.NotVerified)
			}
		}
		if err := put(fmt.Sprintf("tasks/%s/%s %s.md", nm.projects[t.ProjectID].Key, t.Key, fileSafe(t.Title)), b.String()); err != nil {
			return err
		}
	}

	// docs/: the page tree as folders of Markdown; private pages of others stay out.
	blocksOf := map[string][]core.Block{}
	for _, bl := range blocks {
		blocksOf[bl.DocID] = append(blocksOf[bl.DocID], bl)
	}
	byID := map[string]core.Doc{}
	for _, d := range docs {
		byID[d.ID] = d
	}
	var pathOf func(d core.Doc, depth int) string
	pathOf = func(d core.Doc, depth int) string {
		name := fileSafe(orText(d.Title, "Untitled"))
		if p, ok := byID[d.ParentID]; ok && depth < 30 {
			return pathOf(p, depth+1) + "/" + name
		}
		return name
	}
	used := map[string]bool{}
	for _, d := range docs {
		if !engine.CanSeeDoc(d, x.member.UserID) {
			continue
		}
		path := "docs/" + pathOf(d, 0)
		for n := 2; used[path]; n++ {
			path = fmt.Sprintf("docs/%s (%d)", pathOf(d, 0), n)
		}
		used[path] = true
		if d.Kind == core.DocDatabase {
			t, err := x.loadTable(d)
			if err != nil {
				return err
			}
			cells, err := x.computed(t)
			if err != nil {
				return err
			}
			w, err := zw.Create(path + ".csv")
			if err != nil {
				return err
			}
			cw := csv.NewWriter(w)
			head := []string{"Title"}
			for _, p := range t.props {
				head = append(head, p.Name)
			}
			cw.Write(head)
			for _, r := range t.rows {
				row := []string{r.Title}
				for _, p := range t.props {
					row = append(row, formula.Text(cells[r.ID][p.ID]))
				}
				cw.Write(row)
			}
			cw.Flush()
			continue
		}
		if err := put(path+".md", md.Render(engine.BlockTree(blocksOf[d.ID]))); err != nil {
			return err
		}
	}

	// files/: as uploaded.
	for _, f := range files {
		if f.State != "ready" {
			continue
		}
		r, _, err := s.fileStore().Open(ctx, f.StorageKey)
		if err != nil {
			continue
		}
		w, err := zw.CreateHeader(&zip.FileHeader{Name: "files/" + f.ID + "/" + fileSafe(f.Name), Method: zip.Store, Modified: time.UnixMilli(f.CreatedAt)})
		if err == nil {
			_, err = io.Copy(w, r)
		}
		r.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
