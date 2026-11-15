// The Asana source: the CSV that Asana exports.

package importer

import (
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// asana reads the CSV that Asana exports.
type asana struct{}

// Kind is "asana".
func (asana) Kind() string { return "asana" }

// Read reads the CSV file at path.
func (asana) Read(path string, _ Options) (Plan, error) {
	return readCSV(path, "asana", asanaRow)
}

func asanaRow(get csvCells) Task {
	t := Task{Ext: get("task id"), Title: get("name"), Description: get("notes"), Status: get("section/column", "section"), Assignee: get("assignee email", "assignee"),
		DueOn: get("due date"), Epic: get("projects"), ParentExt: get("parent task id")}
	t.Category = category(t.Status)
	if get("completed at") != "" {
		t.Category = core.CatDone
		if t.Status == "" || category(t.Status) != core.CatDone {
			t.Status = "" // done there, whatever column it sat in
		}
	}
	if l := get("tags"); l != "" {
		t.Labels = strings.Split(l, ",")
	}
	return t
}
