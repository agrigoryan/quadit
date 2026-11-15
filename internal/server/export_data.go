package server

import (
	"encoding/json"
	"reflect"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// data/ of an export: every row of the workspace as JSON, one file per kind.

// exportRows are every row the export holds: the tables of data/ in the
// order data/ holds them, and by name the ones the other parts are written
// from as well.
type exportRows struct {
	tables    []exportTable
	decisions []core.Decision
	options   []core.Option
	comments  []core.Comment
	atts      []core.Attachment
	files     []core.File
	docs      []core.Doc
	blocks    []core.Block
	tasks     []core.Task
}

// exportTable is one kind of row in data/: the name of its file, a pointer
// to the list of its rows, and how they are read (tasks and events are read
// page by page, and have none).
type exportTable struct {
	name string
	rows any
	q    store.Q
}

// load reads every row of the workspace the export holds.
func (e *exporter) load() (*exportRows, error) {
	r, live := &exportRows{}, store.Where(store.Live)
	r.tables = []exportTable{
		{"members", new([]core.Member), store.Q{}},
		{"projects", new([]core.Project), live},
		{"statuses", new([]core.Status), live},
		{"labels", new([]core.Label), live},
		{"epics", new([]core.Epic), live},
		{"milestones", new([]core.Milestone), live},
		{"cycles", new([]core.Cycle), live},
		{"decisions", &r.decisions, store.Q{Where: live.Where, Order: "created_seq"}},
		{"decision_options", &r.options, store.Q{Where: live.Where, Order: "rank"}},
		{"comments", &r.comments, store.Q{Where: live.Where, Order: "created_seq"}},
		{"relations", new([]core.Relation), store.Q{}},
		{"links", new([]core.TaskLink), live},
		{"attachments", &r.atts, live},
		{"files", &r.files, live},
		{"docs", &r.docs, store.Q{Where: live.Where, Order: "rank"}},
		{"blocks", &r.blocks, store.Q{Where: live.Where, Order: "rank"}},
		{"properties", new([]core.DBProperty), store.Q{Where: live.Where, Order: "rank"}},
		{"preferences", new([]core.Preference), live},
		{"views", new([]core.View), live},
	}
	for _, t := range r.tables {
		if err := e.who.db.List(e.ctx, t.rows, t.q); err != nil {
			return nil, err
		}
	}
	// Tasks and events are read page by page, and go last.
	var err error
	if r.tasks, err = e.everyTaskByKey(); err != nil {
		return nil, err
	}
	evs, err := e.everyEvent()
	if err != nil {
		return nil, err
	}
	r.tables = append(r.tables, exportTable{name: "tasks", rows: &r.tasks}, exportTable{name: "events", rows: &evs})
	return r, nil
}

// data writes data/: every workspace table as JSON.
func (e *exporter) data(r *exportRows) error {
	for _, t := range r.tables {
		if err := e.dump(t.name, reflect.ValueOf(t.rows).Elem().Interface()); err != nil {
			return err
		}
	}
	return nil
}

// dump writes one file of data/.
func (e *exporter) dump(name string, rows any) error {
	w, err := e.zw.Create("data/" + name + ".json")
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", " ")
	return enc.Encode(rows)
}

// everyTaskByKey reads all the tasks, archived ones too, project by project
// in the order of their numbers: the order the archive holds them in. That
// is why it does not read them with everyTask, which gives them in the
// order they were made.
func (e *exporter) everyTaskByKey() ([]core.Task, error) {
	who, ctx := e.who, e.ctx
	tasks, err := who.db.Tasks(ctx, store.TaskFilter{Archived: true, Limit: 5000, Sort: "key"})
	for more := tasks; err == nil && len(more) == 5000; {
		more, err = who.db.Tasks(ctx, store.TaskFilter{Archived: true, Limit: 5000, Offset: len(tasks), Sort: "key"})
		tasks = append(tasks, more...)
	}
	return tasks, err
}

// everyEvent reads the whole feed, oldest first.
func (e *exporter) everyEvent() ([]core.Event, error) {
	who, ctx := e.who, e.ctx
	evs, err := who.db.Events(ctx, store.EventFilter{Limit: 2000})
	for page := evs; err == nil && len(page) == 2000; {
		page, err = who.db.Events(ctx, store.EventFilter{After: evs[len(evs)-1].Seq, Limit: 2000})
		evs = append(evs, page...)
	}
	return evs, err
}
