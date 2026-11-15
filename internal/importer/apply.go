// Apply, the run of it that the apply_*.go files add steps to, and the
// refusals a run gets past.

package importer

import (
	"encoding/json"
	"strings"

	"github.com/agrigoryan/quadit/internal/id"
)

// Apply makes everything in a plan. project is the key that tasks with no
// project of their own go into.
func Apply(sink Sink, plan Plan, project string) (Summary, error) {
	a := &applier{sink: sink, plan: plan, project: strings.ToUpper(project), fresh: true}
	for _, n := range plan.Notes {
		sink.Logf("note: %s", n)
	}
	steps := []func() error{
		a.makeProjects, // apply_workflow.go
		a.loadLayout,
		a.makeWorkflow,
		a.indexFiles, // apply_files.go
		a.makeTasks,  // apply_tasks.go
		a.relateTasks,
		a.makeDocs, // apply_docs.go
		a.makeTables,
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return a.sum, err
		}
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
	// fresh says whether the last change made something, or found it there
	// already from an earlier run of the same import.
	fresh bool

	// The workspace as it is, kept up as the import adds to it.
	projectID   map[string]string // key -> id
	madeProject map[string]bool   // keys of the projects this run made
	statuses    []row
	labels      []row
	epics       []row
	members     []row

	files fileSet // apply_files.go

	tasks     map[string]Task // by Ext
	taskDone  map[string]bool
	unmatched map[string]bool // assignees with no member here

	docs    map[string]Doc // by Ext
	docDone map[string]bool
	titleID map[string]string // a page's title in lower case -> its id here
}

// row is a row of any of the lists the import reads: only the fields it
// uses.
type row struct {
	ID, Key, Name, Handle, Category, Email, Rank string
	ProjectID                                    string `json:"project_id"`
	UserID                                       string `json:"user_id"`
	IsDefault                                    bool   `json:"is_default"`
}

// uid is the id a thing of the source has here: always the same one, which
// is what lets an import be run again.
func (a *applier) uid(kind, ext string) string {
	return id.From("import", a.plan.Source, kind, ext)
}

// change sends one change, under an id made from what it says, and notes
// whether it made something.
func (a *applier) change(typ string, args map[string]any) error {
	raw, _ := json.Marshal(args)
	err := a.sink.Change(id.From("import-change", a.plan.Source, typ, string(raw)), typ, args)
	a.fresh = true
	if d, ok := a.sink.(duplicateTeller); ok && d.WasDuplicate() {
		a.fresh = false
		a.sum.Already++
	}
	// The same thing from an earlier run, but changed at the source since
	// (an edited description, say): what is here stays as it is.
	if refusedFor(err, refusalAlreadyInUse) {
		a.fresh = false
		a.sum.Already++
		return nil
	}
	return err
}

// The refusals an import gets past, each matched by what its message
// says (see refusedFor).
const (
	// refusalAlreadyInUse: the thing's id is in use, by the same thing
	// made by an earlier run of the import.
	refusalAlreadyInUse = "is already in use"
	// refusalNumberTaken: the task number asked for is someone else's here.
	refusalNumberTaken = "is taken"
)

// refusedFor says whether err is the API refusing a change for reason.
//
// It matches the refusal's message, which the code style otherwise forbids,
// because nothing else tells these refusals apart: the API answers both with
// the code "conflict" and no field. The refusal reaches an import as
// internal/cli's APIError over the network and as internal/engine's Error
// from inside the server, and the importer depends on neither. Once the
// engine gives each refusal a code of its own, this matches on the code
// (with errors.As on an interface both error types satisfy) instead.
func refusedFor(err error, reason string) bool {
	return err != nil && strings.Contains(err.Error(), reason)
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
