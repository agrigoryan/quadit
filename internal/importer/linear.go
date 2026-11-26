// The Linear source: the CSV that Linear exports.

package importer

import (
	"net/http"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// linear reads the CSV that Linear exports.
type linear struct{}

func (linear) Kind() string { return "linear" }

// Read reads the CSV file at path.
func (linear) Read(path string, _ Options, _ *http.Client) (Plan, error) {
	return readCSV(path, "linear", linearRow)
}

// linearRow makes a task of one row of Linear's CSV.
func linearRow(get csvCells) Task {
	t := Task{Ext: get("id"), Title: get("title"), Description: get("description"), Status: get("status"), Assignee: get("assignee"),
		DueOn: get("due date"), Epic: get("project"), ParentExt: get("parent issue"), Priority: priorityNames[strings.ToLower(get("priority"))]}
	t.Category = category(t.Status)
	switch {
	case get("canceled") != "":
		t.Category = core.CatCanceled
	case get("completed") != "":
		t.Category = core.CatDone
	case get("started") != "" && t.Category == core.CatUnstarted:
		t.Category = core.CatStarted
	}
	t.Estimate = linearEstimate(get("estimate"))
	if l := get("labels"); l != "" {
		t.Labels = strings.Split(l, ",")
	}
	return t
}

// linearEstimate reads an estimate as Linear writes it: a number of points
// (cut to a whole one), or a T-shirt size, which stands for its number.
// Anything else, or nothing, is no estimate.
func linearEstimate(cell string) *int {
	whole, _, _ := strings.Cut(cell, ".")
	if n, ok := core.EstimatePoints(whole); ok {
		return &n
	}
	return nil
}
