// Apply, the workspace as an import run knows it, and the refusals a run
// gets past.

package importer

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
)

// Apply makes everything in a plan. project is the key that tasks with no
// project of their own go into.
func Apply(sink Sink, plan Plan, project string) (Summary, error) {
	for _, n := range plan.Notes {
		sink.Logf("note: %s", n)
	}
	a, err := newApplier(sink, plan, project)
	if err != nil {
		return Summary{}, err
	}
	if err := a.makeProjects(); err != nil { // apply_workflow.go
		return a.sum, err
	}
	if err := a.loadLayout(); err != nil {
		return a.sum, err
	}
	if err := a.makeWorkflow(); err != nil {
		return a.sum, err
	}
	if err := a.makeTasks(); err != nil { // apply_tasks.go
		return a.sum, err
	}
	if err := a.relateTasks(); err != nil {
		return a.sum, err
	}
	if err := a.makeDocs(); err != nil { // apply_docs.go
		return a.sum, err
	}
	if err := a.makeTables(); err != nil {
		return a.sum, err
	}
	return a.sum, nil
}

// applier is one run of Apply: the plan, where it is written, and what is
// known so far about the workspace it is written into.
type applier struct {
	sink    Sink
	plan    Plan
	project string // the key for tasks that name no project
	sum     Summary

	// The workspace as it is, kept up as the import adds to it.
	projectID   map[string]string // key -> id
	madeProject map[string]bool   // keys of the projects this run made
	statuses    []row
	labels      []row
	epics       []row
	members     []row

	files fileSet // apply_files.go

	tasks     map[string]Task // the plan's, by Ext
	taskDone  map[string]bool
	unmatched map[string]bool // assignees with no member here

	docs    map[string]Doc // the plan's, by Ext
	docDone map[string]bool
	titleID map[string]string // a page's title in lower case -> its id here
}

// newApplier starts a run of Apply: the plan's tasks, pages and files
// indexed, and the workspace's projects read.
func newApplier(sink Sink, plan Plan, project string) (*applier, error) {
	a := &applier{sink: sink, plan: plan, project: strings.ToUpper(project),
		projectID: map[string]string{}, madeProject: map[string]bool{},
		files: fileSet{byExt: map[string]File{}, sent: map[string]string{}},
		tasks: map[string]Task{}, taskDone: map[string]bool{}, unmatched: map[string]bool{},
		docs: map[string]Doc{}, docDone: map[string]bool{}, titleID: map[string]string{}}
	projects, err := a.list("projects")
	if err != nil {
		return nil, err
	}
	for _, p := range projects {
		a.projectID[p.Key] = p.ID
	}
	if a.plan.Origin != "" {
		earlier, err := a.importedBeforeOrigins()
		if err != nil {
			return nil, err
		}
		if earlier {
			sink.Logf("note: pages of this %s import are here from when imports were not named; this run goes on with that import, adding only what it lacks", plan.Source)
			a.plan.Origin = ""
		}
	}
	for _, t := range plan.Tasks {
		a.tasks[t.Ext] = t
	}
	for _, d := range plan.Docs {
		a.docs[d.Ext] = d
		a.titleID[strings.ToLower(d.Title)] = a.uid("doc", d.Ext)
	}
	for _, f := range plan.Files {
		a.files.byExt[f.Ext] = f
		for _, l := range f.Links {
			if l != "" {
				a.files.links = append(a.files.links, fileLink{l, f.Ext})
			}
		}
	}
	// Longest first: an address with the server's name before the same one
	// without it.
	sort.SliceStable(a.files.links, func(i, j int) bool { return len(a.files.links[i].text) > len(a.files.links[j].text) })
	return a, nil
}

// row is a row of any of the lists the import reads: only the fields it
// uses.
type row struct {
	ID, Key, Name, Handle, Category, Email, Rank string
	ProjectID                                    string `json:"project_id"`
	UserID                                       string `json:"user_id"`
	IsDefault                                    bool   `json:"is_default"`
}

// importedBeforeOrigins reports whether the workspace holds pages this
// plan made when imports had no origin: the ids of the plan's pages
// without its origin. Such an import is gone on with, not made a second
// time beside itself.
func (a *applier) importedBeforeOrigins() (bool, error) {
	raw, err := a.sink.Get("/docs", nil)
	if err != nil {
		return false, err
	}
	var tree struct{ Docs []struct{ ID string } }
	if err := json.Unmarshal(raw, &tree); err != nil {
		return false, err
	}
	here := map[string]bool{}
	for _, d := range tree.Docs {
		here[d.ID] = true
	}
	for _, d := range a.plan.Docs {
		if here[id.From("import", a.plan.Source, "doc", d.Ext)] {
			return true, nil
		}
	}
	return false, nil
}

// uid is the id a thing of the source has here: always the same one, which
// is what lets an import be run again. A plan with an origin names it too;
// one without keeps the ids imports had before origins were known.
func (a *applier) uid(kind, ext string) string {
	if a.plan.Origin != "" {
		return id.From("import", a.plan.Source, a.plan.Origin, kind, ext)
	}
	return id.From("import", a.plan.Source, kind, ext)
}

// change sends one change, under an id made from what it says. made is
// false when an earlier run of the same import had made it, which is
// counted in the summary.
func (a *applier) change(typ string, args map[string]any) (made bool, err error) {
	raw := plainjson.Marshal(args)
	made, err = a.sink.Change(id.From("import-change", a.plan.Source, typ, string(raw)), typ, args)
	// The same thing from an earlier run, but changed at the source since
	// (an edited description, say): what is here stays as it is.
	if refusedFor(err, refusalAlreadyInUse) {
		a.sum.Already++
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !made {
		a.sum.Already++
	}
	return made, nil
}

// The refusals an import gets past, by the reason the API gives them
// (internal/engine's Reason*; see refusedFor).
const (
	// refusalAlreadyInUse: the thing's id is in use, by the same thing
	// made by an earlier run of the import.
	refusalAlreadyInUse = "in_use"
	// refusalNumberTaken: the task number asked for is someone else's here.
	refusalNumberTaken = "number_taken"
)

// refusal is a refused change as an import meets it: internal/engine's
// Error from inside the server, or internal/cli's APIError over the
// network. The importer depends on neither; both say why they refused.
type refusal interface {
	error
	RefusalReason() string
}

// refusedFor says whether err is the API refusing a change for reason.
func refusedFor(err error, reason string) bool {
	var r refusal
	return errors.As(err, &r) && r.RefusalReason() == reason
}

// list reads one of the workspace's lists: projects, statuses, members.
func (a *applier) list(name string) ([]row, error) {
	raw, err := a.sink.Get("/list/"+name, nil)
	if err != nil {
		return nil, err
	}
	var out map[string][]row
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out[name], nil
}

// has reports whether a project has a row of that name, its own or one
// shared by the whole workspace.
func (a *applier) has(rows []row, projectKey, name string) bool {
	for _, r := range rows {
		if strings.EqualFold(r.Name, name) && (r.ProjectID == a.projectID[projectKey] || r.ProjectID == "") {
			return true
		}
	}
	return false
}

// keyOf is the key of the project a task or status of the plan goes in.
func (a *applier) keyOf(project string) string {
	return strings.ToUpper(orStr(project, a.project))
}
