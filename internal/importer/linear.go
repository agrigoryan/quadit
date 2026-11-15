package importer

import (
	"strconv"
	"strings"
)

// linear reads the CSV that Linear exports.
type linear struct{}

func (linear) Kind() string { return "linear" }

func (linear) Read(path string, _ Options) (Plan, error) {
	return readCSV(path, "linear", linearRow)
}

func linearRow(get csvCells) Task {
	t := Task{Ext: get("id"), Title: get("title"), Description: get("description"), Status: get("status"), Assignee: get("assignee"),
		DueOn: get("due date"), Epic: get("project"), ParentExt: get("parent issue"), Priority: priorityNames[strings.ToLower(get("priority"))]}
	t.Category = category(t.Status)
	switch {
	case get("canceled") != "":
		t.Category = "canceled"
	case get("completed") != "":
		t.Category = "done"
	case get("started") != "" && t.Category == "unstarted":
		t.Category = "started"
	}
	t.Estimate, _ = strconv.Atoi(strings.SplitN(get("estimate"), ".", 2)[0])
	if l := get("labels"); l != "" {
		t.Labels = strings.Split(l, ",")
	}
	return t
}
