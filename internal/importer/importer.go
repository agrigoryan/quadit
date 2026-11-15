// Package importer brings work in from other tools. Each source is read
// into the same plain plan (tasks, comments, pages), and one function turns
// a plan into changes. Imports go through the API like any other client,
// and can be run again: the same source item always becomes the same task
// or page, so a second run adds nothing twice.
package importer

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/id"
)

// Task is one task as it comes from another tool.
type Task struct {
	// Number is the task's number where it lived; it keeps it here when
	// that number is free.
	Number      int
	Ext         string // its id there
	Project     string // key of the project it goes in; empty = the one asked for
	Title       string
	Description string
	Status      string // the status's name there
	Category    string // backlog, unstarted, started, waiting, done or canceled
	Priority    int    // 0 none, 1 urgent … 4 low
	Assignee    string // a name or an email address
	Labels      []string
	DueOn       string
	Estimate    int
	Epic        string
	ParentExt   string
	URL         string // where it lived
	Comments    []Comment
	// WasKey is what the task was called where it lived (ENG-12), kept in its
	// text so that old links and habits still find it.
	WasKey string
	// Blocks and Relates name other tasks of the same import by their Ext.
	Blocks  []string
	Relates []string
	// Files names the plan's files that were attached to the task there.
	Files []string
}

type Comment struct {
	Author string
	At     string
	Body   string
	Files  []string // the plan's files attached to the comment there
}

// File is a file that lived at the source: a copy of it on this machine,
// and the addresses that text there used for it.
type File struct {
	Ext   string   // its id there
	Path  string   // where the copy is
	Links []string // how descriptions, comments and pages there point at it
}

// Status is a status of a project's workflow there, and Label a label:
// they come over whether or not a task uses them, in the order they had.
type Status struct {
	Project, Name, Category, Color string
}

type Label struct {
	Project, Name, Color string
}

// Doc is one page.
type Doc struct {
	Ext       string
	ParentExt string
	Title     string
	Markdown  string
	Dir       string // where its relative images are, for Markdown folders
}

// Table is a database: columns and rows of text.
type Table struct {
	Ext       string
	ParentExt string
	Title     string
	Columns   []string
	Rows      [][]string // the first cell is the row's title
}

// Project is a project to make if it is not there.
type Project struct {
	Key, Name string
}

// Plan is everything one import will make.
type Plan struct {
	Source   string // linear, trello, …
	Projects []Project
	Tasks    []Task
	Docs     []Doc
	Tables   []Table
	Files    []File
	Statuses []Status
	Labels   []Label
	// Notes say what the source could not give, for the one running the import.
	Notes []string
	// Tmp is a folder of copies made while reading; Close removes it.
	Tmp string
}

// Close removes what reading the source left on this machine.
func (p Plan) Close() {
	if p.Tmp != "" {
		os.RemoveAll(p.Tmp)
	}
}

// FileUploader is a Sink that can send a file under an id of the caller's
// making: a file sent again under the same id is not stored twice, which is
// what keeps a second run of an import from leaving copies behind. fresh
// says whether the file was sent now, or was there from an earlier run.
type FileUploader interface {
	UploadAs(fileID, path string) (fileURL string, fresh bool, err error)
}

// Sink is where an import writes: the API, through the command-line client.
// Change takes the id to send the change under; the same id sent again is
// applied once, which is what makes an import safe to run twice.
type Sink interface {
	Change(changeID, typ string, args any) error
	Get(path string, q url.Values) ([]byte, error)
	Upload(path string) (fileURL string, err error)
	Logf(format string, a ...any)
}

// Summary says what an import did.
type Summary struct {
	Tasks, Comments, Docs, Rows, Files int
	Unmatched                          []string // assignees with no member here
	// Already counts what an earlier run of the same import had made.
	Already int
}

func (s Summary) String() string {
	out := fmt.Sprintf("imported %d tasks, %d comments, %d pages, %d rows, %d files", s.Tasks, s.Comments, s.Docs, s.Rows, s.Files)
	if s.Already > 0 {
		out += fmt.Sprintf("\n%d things were here already from an earlier run and were left as they are", s.Already)
	}
	if len(s.Unmatched) > 0 {
		out += "\nno member here for: " + strings.Join(s.Unmatched, ", ") + " (their tasks are unassigned and say who had them)"
	}
	return out
}

var keyClean = regexp.MustCompile(`[^A-Z0-9]`)

// KeyFrom makes a project key out of a name.
func KeyFrom(name string) string {
	k := keyClean.ReplaceAllString(strings.ToUpper(name), "")
	if len(k) > 6 {
		k = k[:6]
	}
	for len(k) < 2 || k[0] < 'A' || k[0] > 'Z' {
		k = "P" + k
	}
	return k
}

// Apply makes everything in a plan. project is the key that tasks with no
// project of their own go into.
func Apply(sink Sink, plan Plan, project string) (Summary, error) {
	var sum Summary
	for _, n := range plan.Notes {
		sink.Logf("note: %s", n)
	}
	uid := func(kind, ext string) string { return id.From("import", plan.Source, kind, ext) }
	// fresh says whether the last change made something, or found it there
	// already from an earlier run of the same import.
	fresh := true
	change := func(typ string, args map[string]any) error {
		raw, _ := json.Marshal(args)
		err := sink.Change(id.From("import-change", plan.Source, typ, string(raw)), typ, args)
		fresh = true
		if d, ok := sink.(interface{ WasDuplicate() bool }); ok && d.WasDuplicate() {
			fresh = false
			sum.Already++
		}
		// The same thing from an earlier run, but changed at the source
		// since (an edited description, say): what is here stays as it is.
		if err != nil && strings.Contains(err.Error(), "is already in use") {
			fresh = false
			sum.Already++
			return nil
		}
		return err
	}
	project = strings.ToUpper(project)

	// What is there already.
	type row struct {
		ID, Key, Name, Handle, Category, Email string
		ProjectID                              string `json:"project_id"`
		UserID                                 string `json:"user_id"`
	}
	list := func(name string) ([]row, error) {
		raw, err := sink.Get("/list/"+name, nil)
		if err != nil {
			return nil, err
		}
		var out map[string][]row
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, err
		}
		return out[name], nil
	}
	projects, err := list("projects")
	if err != nil {
		return sum, err
	}
	projectID := map[string]string{}
	for _, p := range projects {
		projectID[p.Key] = p.ID
	}
	want := append([]Project(nil), plan.Projects...)
	needed := map[string]bool{}
	for _, t := range plan.Tasks {
		needed[strings.ToUpper(orStr(t.Project, project))] = true
	}
	for k := range needed {
		if k == "" {
			return sum, fmt.Errorf("say which project the tasks go in: project=KEY")
		}
		found := false
		for _, p := range want {
			found = found || strings.EqualFold(p.Key, k)
		}
		if !found {
			want = append(want, Project{Key: k, Name: k})
		}
	}
	for _, p := range want {
		key := strings.ToUpper(p.Key)
		if projectID[key] != "" {
			continue
		}
		pid := uid("project", key)
		if err := change("project.create", map[string]any{"id": pid, "key": key, "name": orStr(p.Name, key)}); err != nil {
			return sum, fmt.Errorf("project %s: %w", key, err)
		}
		projectID[key] = pid
		sink.Logf("made project %s", key)
	}
	statuses, err := list("statuses")
	if err != nil {
		return sum, err
	}
	labels, err := list("labels")
	if err != nil {
		return sum, err
	}
	epics, err := list("epics")
	if err != nil {
		return sum, err
	}
	members, err := list("members")
	if err != nil {
		return sum, err
	}
	has := func(rows []row, projectKey, name string) bool {
		for _, r := range rows {
			if strings.EqualFold(r.Name, name) && (r.ProjectID == projectID[projectKey] || r.ProjectID == "") {
				return true
			}
		}
		return false
	}
	member := func(who string) string {
		w := strings.ToLower(strings.TrimSpace(who))
		local := strings.SplitN(w, "@", 2)[0]
		for _, m := range members {
			if w != "" && (strings.ToLower(m.Email) == w || strings.ToLower(m.Name) == w || m.Handle == w || m.Handle == local || strings.ToLower(m.Name) == strings.ReplaceAll(local, ".", " ")) {
				return m.UserID
			}
		}
		// A first name alone ("Ann" for Ann Lee), when only one member has it.
		found := ""
		for _, m := range members {
			if w != "" && !strings.Contains(w, "@") && (strings.HasPrefix(strings.ToLower(m.Name), w+" ") || strings.HasPrefix(m.Handle, w+"-")) {
				if found != "" && found != m.UserID {
					return ""
				}
				found = m.UserID
			}
		}
		return found
	}
	unmatched := map[string]bool{}

	// The workflow as it was there: every status and label, used or not.
	for _, st := range plan.Statuses {
		key := strings.ToUpper(orStr(st.Project, project))
		if st.Name == "" || projectID[key] == "" || has(statuses, key, st.Name) {
			continue
		}
		args := map[string]any{"id": uid("status", key+"/"+strings.ToLower(st.Name)), "project": projectID[key], "name": st.Name, "category": orStr(st.Category, "unstarted")}
		if st.Color != "" {
			args["color"] = st.Color
		}
		if err := change("status.create", args); err != nil {
			return sum, fmt.Errorf("status %q: %w", st.Name, err)
		}
		statuses = append(statuses, row{Name: st.Name, ProjectID: projectID[key]})
	}
	for _, l := range plan.Labels {
		key := strings.ToUpper(orStr(l.Project, project))
		if l.Name == "" || projectID[key] == "" || has(labels, key, l.Name) {
			continue
		}
		args := map[string]any{"id": uid("label", key+"/"+strings.ToLower(l.Name)), "project": projectID[key], "name": l.Name}
		if l.Color != "" {
			args["color"] = l.Color
		}
		if err := change("label.create", args); err != nil {
			return sum, fmt.Errorf("label %q: %w", l.Name, err)
		}
		labels = append(labels, row{Name: l.Name, ProjectID: projectID[key]})
	}

	// Files that lived at the source. Each is sent once, the first time
	// something needs it, and text that pointed at it there points at the
	// copy here.
	fileOf := map[string]File{}
	for _, f := range plan.Files {
		fileOf[f.Ext] = f
	}
	sent := map[string]string{} // ext -> its address here ("" when it could not be sent)
	send := func(ext string) string {
		if u, ok := sent[ext]; ok {
			return u
		}
		f, u, isNew := fileOf[ext], "", true
		var err error
		if up, ok := sink.(FileUploader); ok {
			u, isNew, err = up.UploadAs(uid("file", ext), f.Path)
		} else {
			u, err = sink.Upload(f.Path)
		}
		if err != nil {
			sink.Logf("note: the file %s did not come over: %v", filepath.Base(f.Path), err)
			u = ""
		} else if isNew {
			sum.Files++
		}
		// The address without the server's name, so that it still holds
		// when the install moves to another one.
		if i := strings.Index(u, "/f/"); i > 0 {
			u = u[i:]
		}
		sent[ext] = u
		return u
	}
	type link struct{ text, ext string }
	var links []link
	for _, f := range plan.Files {
		for _, l := range f.Links {
			if l != "" {
				links = append(links, link{l, f.Ext})
			}
		}
	}
	// Longest first: an address with the server's name before the same one without.
	sort.SliceStable(links, func(i, j int) bool { return len(links[i].text) > len(links[j].text) })
	here := func(text string) string {
		for _, l := range links {
			if strings.Contains(text, l.text) {
				if u := send(l.ext); u != "" {
					text = strings.ReplaceAll(text, l.text, u)
				}
			}
		}
		return text
	}
	attach := func(exts []string, on, subject, was string) error {
		for _, ext := range exts {
			if _, ok := fileOf[ext]; !ok || send(ext) == "" {
				continue
			}
			if err := change("attachment.add", map[string]any{"id": uid("attachment", was+"/"+ext), "file": uid("file", ext), on: subject}); err != nil {
				return fmt.Errorf("file %s: %w", filepath.Base(fileOf[ext].Path), err)
			}
		}
		return nil
	}

	// Tasks: parents before their sub-tasks.
	byExt := map[string]Task{}
	for _, t := range plan.Tasks {
		byExt[t.Ext] = t
	}
	done := map[string]bool{}
	var mk func(t Task, depth int) error
	mk = func(t Task, depth int) error {
		if done[t.Ext] {
			return nil
		}
		done[t.Ext] = true
		key := strings.ToUpper(orStr(t.Project, project))
		args := map[string]any{"id": uid("task", t.Ext), "project": projectID[key], "title": orStr(strings.TrimSpace(t.Title), "Untitled"), "priority": t.Priority}
		if t.ParentExt != "" && depth < 20 {
			if p, ok := byExt[t.ParentExt]; ok {
				if err := mk(p, depth+1); err != nil {
					return err
				}
				args["parent"] = uid("task", p.Ext)
			}
		}
		// A status keeps its name; one that is new here is made in the
		// right category.
		if t.Status != "" {
			if !has(statuses, key, t.Status) {
				cat := orStr(t.Category, "unstarted")
				if err := change("status.create", map[string]any{"id": uid("status", key+"/"+strings.ToLower(t.Status)), "project": projectID[key], "name": t.Status, "category": cat}); err != nil {
					return fmt.Errorf("status %q: %w", t.Status, err)
				}
				statuses = append(statuses, row{Name: t.Status, ProjectID: projectID[key]})
			}
			args["status"] = t.Status
		} else if t.Category != "" {
			args["status"] = t.Category
		}
		var names []string
		for _, l := range t.Labels {
			if l = strings.TrimSpace(l); l == "" {
				continue
			}
			if !has(labels, key, l) {
				if err := change("label.create", map[string]any{"id": uid("label", key+"/"+strings.ToLower(l)), "project": projectID[key], "name": l}); err != nil {
					return fmt.Errorf("label %q: %w", l, err)
				}
				labels = append(labels, row{Name: l, ProjectID: projectID[key]})
			}
			names = append(names, l)
		}
		if len(names) > 0 {
			args["labels"] = names
		}
		if t.Epic != "" {
			if !has(epics, key, t.Epic) {
				if err := change("epic.create", map[string]any{"id": uid("epic", key+"/"+strings.ToLower(t.Epic)), "project": projectID[key], "name": t.Epic}); err != nil {
					return fmt.Errorf("epic %q: %w", t.Epic, err)
				}
				epics = append(epics, row{Name: t.Epic, ProjectID: projectID[key]})
			}
			args["epic"] = t.Epic
		}
		desc := here(t.Description)
		var notes []string
		if t.Assignee != "" {
			if m := member(t.Assignee); m != "" {
				args["assignee"] = m
			} else {
				unmatched[t.Assignee] = true
				notes = append(notes, "Assigned there to "+t.Assignee+".")
			}
		}
		// What it was called there is said only when it is called
		// something else here.
		describe := func(sameKey bool) string {
			ns := notes
			if t.WasKey != "" && !sameKey {
				ns = append(ns[:len(ns):len(ns)], "Was "+t.WasKey+" there.")
			}
			if t.URL != "" {
				ns = append(ns[:len(ns):len(ns)], "Imported from "+t.URL)
			} else if t.Ext != "" {
				ns = append(ns[:len(ns):len(ns)], "Imported from "+plan.Source+" "+t.Ext+".")
			}
			if len(ns) == 0 {
				return desc
			}
			return strings.TrimSpace(desc + "\n\n" + strings.Join(ns, " "))
		}
		args["description"] = describe(t.Number > 0 && strings.EqualFold(t.WasKey, fmt.Sprintf("%s-%d", key, t.Number)))
		if len(t.DueOn) >= 10 {
			args["due_on"] = t.DueOn[:10]
		}
		if t.Estimate > 0 {
			args["estimate"] = t.Estimate
		}
		if t.Number > 0 {
			args["number"] = t.Number
		}
		err := change("task.create", args)
		if err != nil && t.Number > 0 && strings.Contains(err.Error(), "is taken") {
			// Someone here has that number already: it gets the next one,
			// and its description says what it was called.
			delete(args, "number")
			args["description"] = describe(false)
			err = change("task.create", args)
		}
		if err != nil {
			return fmt.Errorf("task %q: %w", t.Title, err)
		}
		if fresh {
			sum.Tasks++
		}
		if err := attach(t.Files, "task", uid("task", t.Ext), t.Ext); err != nil {
			return err
		}
		for i, cm := range t.Comments {
			if strings.TrimSpace(cm.Body) == "" && len(cm.Files) == 0 {
				continue
			}
			body := here(cm.Body)
			if cm.Author != "" {
				head := "**" + cm.Author + "**"
				if cm.At != "" {
					head += ", " + cm.At[:min(len(cm.At), 10)]
				}
				body = head + ":\n\n" + body
			}
			if err := change("comment.create", map[string]any{"id": uid("comment", fmt.Sprintf("%s/%d", t.Ext, i)), "task": uid("task", t.Ext), "body": body}); err != nil {
				return fmt.Errorf("comment on %q: %w", t.Title, err)
			}
			if fresh {
				sum.Comments++
			}
			if err := attach(cm.Files, "comment", uid("comment", fmt.Sprintf("%s/%d", t.Ext, i)), fmt.Sprintf("%s/%d", t.Ext, i)); err != nil {
				return err
			}
		}
		return nil
	}
	for _, t := range plan.Tasks {
		if err := mk(t, 0); err != nil {
			return sum, err
		}
		if sum.Tasks > 0 && sum.Tasks%100 == 0 {
			sink.Logf("%d tasks…", sum.Tasks)
		}
	}
	for who := range unmatched {
		sum.Unmatched = append(sum.Unmatched, who)
	}
	sort.Strings(sum.Unmatched)

	// How the tasks hang together, once they are all there.
	for _, t := range plan.Tasks {
		for typ, others := range map[string][]string{"blocks": t.Blocks, "relates": t.Relates} {
			for _, o := range others {
				if _, ok := byExt[o]; !ok {
					continue
				}
				if err := change("relation.add", map[string]any{"id": uid("relation", t.Ext+"/"+typ+"/"+o), "task": uid("task", t.Ext), "other": uid("task", o), "type": typ}); err != nil {
					return sum, fmt.Errorf("relation of %q: %w", t.Title, err)
				}
			}
		}
	}

	// Pages: [[wiki links]] and links between files become links between
	// pages; images beside a file are uploaded.
	titleID := map[string]string{}
	for _, d := range plan.Docs {
		titleID[strings.ToLower(d.Title)] = uid("doc", d.Ext)
	}
	docDone := map[string]bool{}
	docByExt := map[string]Doc{}
	for _, d := range plan.Docs {
		docByExt[d.Ext] = d
	}
	var makeDoc func(d Doc, depth int) error
	makeDoc = func(d Doc, depth int) error {
		if docDone[d.Ext] {
			return nil
		}
		docDone[d.Ext] = true
		args := map[string]any{"id": uid("doc", d.Ext), "title": orStr(d.Title, "Untitled")}
		if p, ok := docByExt[d.ParentExt]; ok && depth < 30 {
			if err := makeDoc(p, depth+1); err != nil {
				return err
			}
			args["parent"] = uid("doc", p.Ext)
		}
		body := wikiLink.ReplaceAllStringFunc(here(d.Markdown), func(m string) string {
			sub := wikiLink.FindStringSubmatch(m)
			target, label, _ := strings.Cut(sub[2], "|")
			target = strings.TrimSpace(strings.SplitN(target, "#", 2)[0])
			if sub[1] == "!" { // an embedded file
				return "![" + target + "](" + target + ")"
			}
			if did, ok := titleID[strings.ToLower(filepath.Base(target))]; ok {
				return "[" + orStr(label, target) + "](doc:" + did + ")"
			}
			return orStr(label, target)
		})
		body = localImage.ReplaceAllStringFunc(body, func(m string) string {
			sub := localImage.FindStringSubmatch(m)
			ref, _ := url.PathUnescape(sub[2])
			if strings.Contains(ref, "://") || d.Dir == "" {
				return m
			}
			for _, p := range []string{filepath.Join(d.Dir, ref), filepath.Join(d.Dir, filepath.Base(ref))} {
				if st, err := os.Stat(p); err == nil && !st.IsDir() {
					if u, err := sink.Upload(p); err == nil {
						sum.Files++
						return "![" + sub[1] + "](" + u + ")"
					}
				}
			}
			return m
		})
		args["markdown"] = body
		if err := change("doc.create", args); err != nil {
			return fmt.Errorf("page %q: %w", d.Title, err)
		}
		if fresh {
			sum.Docs++
		}
		return nil
	}
	for _, d := range plan.Docs {
		if err := makeDoc(d, 0); err != nil {
			return sum, err
		}
	}
	for _, tb := range plan.Tables {
		dbID := uid("db", tb.Ext)
		args := map[string]any{"id": dbID, "title": orStr(tb.Title, "Untitled"), "kind": "database"}
		if _, ok := docByExt[tb.ParentExt]; ok {
			args["parent"] = uid("doc", tb.ParentExt)
		}
		if err := change("doc.create", args); err != nil {
			return sum, fmt.Errorf("database %q: %w", tb.Title, err)
		}
		if fresh {
			sum.Docs++
		}
		cols := tb.Columns
		if len(cols) > 0 {
			cols = cols[1:] // the first column is the row's title
		}
		for i, c := range cols {
			if err := change("property.create", map[string]any{"id": uid("prop", tb.Ext+"/"+c), "database": dbID, "name": orStr(c, fmt.Sprintf("Column %d", i+2)), "type": "text"}); err != nil {
				return sum, fmt.Errorf("column %q: %w", c, err)
			}
		}
		for i, r := range tb.Rows {
			props := map[string]any{}
			for j, c := range cols {
				if j+1 < len(r) && r[j+1] != "" {
					props[uid("prop", tb.Ext+"/"+c)] = r[j+1]
				}
			}
			title := ""
			if len(r) > 0 {
				title = r[0]
			}
			if err := change("doc.create", map[string]any{"id": uid("row", fmt.Sprintf("%s/%d", tb.Ext, i)), "parent": dbID, "title": title, "props": props}); err != nil {
				return sum, fmt.Errorf("row %d of %q: %w", i+1, tb.Title, err)
			}
			if fresh {
				sum.Rows++
			}
		}
	}
	return sum, nil
}

var (
	wikiLink   = regexp.MustCompile(`(!?)\[\[([^\]\n]+)\]\]`)
	localImage = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)\)`)
)

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
