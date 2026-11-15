package server

import (
	"encoding/json"

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

// exportTable is one kind of row in data/: the name of its file, and the
// list of its rows.
type exportTable struct {
	name string
	rows any
}

// load reads every row of the workspace the export holds: each kind that
// data/ has (rowKinds), as stored, then the tasks and the events, which are
// read page by page and go last.
func (e *exporter) load() (*exportRows, error) {
	r := &exportRows{}
	byName := map[string]any{}
	for _, kind := range rowKinds {
		if kind.exportQuery == nil {
			continue
		}
		rows, err := kind.all(e.ctx, e.who.db, *kind.exportQuery)
		if err != nil {
			return nil, err
		}
		r.tables = append(r.tables, exportTable{kind.name, rows})
		byName[kind.name] = rows
	}
	r.decisions, r.options, r.comments = byName["decisions"].([]core.Decision), byName["decision_options"].([]core.Option), byName["comments"].([]core.Comment)
	r.atts, r.files = byName["attachments"].([]core.Attachment), byName["files"].([]core.File)
	r.docs, r.blocks = byName["docs"].([]core.Doc), byName["blocks"].([]core.Block)
	var err error
	if r.tasks, err = e.everyTaskByKey(); err != nil {
		return nil, err
	}
	evs, err := e.everyEvent()
	if err != nil {
		return nil, err
	}
	r.tables = append(r.tables, exportTable{"tasks", r.tasks}, exportTable{"events", evs})
	return r, nil
}

// data writes data/: every workspace table as JSON.
func (e *exporter) data(r *exportRows) error {
	for _, t := range r.tables {
		if err := e.dump(t.name, t.rows); err != nil {
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
