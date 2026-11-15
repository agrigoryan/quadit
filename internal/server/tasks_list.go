// The task list: GET /tasks, a page at a time, and the cursor that continues it.

package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// listFields are the fields of a listed task when the request names none.
var listFields = []string{"key", "title", "status", "priority", "assignee", "waiting_on", "held_by", "labels", "due_on", "parent", "seq"}

// handleListTasks answers a task query. count=1 returns only how many match.
func (s *Server) handleListTasks(x *c) error {
	query, err := x.queryFromRequest()
	if err != nil {
		return err
	}
	f, err := x.filter(query)
	if err != nil {
		return err
	}
	v := x.r.URL.Query()
	if truthyParam(v, "count") {
		return x.taskCount(f)
	}
	if f.Limit <= 0 {
		f.Limit = defaultTaskPage
	}
	if f.Limit > maxTaskPage {
		f.Limit = maxTaskPage
	}
	if tok := v.Get("cursor"); tok != "" {
		cur, err := parseTaskCursor(tok, f.Sort)
		if err != nil {
			return err
		}
		f.After, f.MadeUpTo, f.Offset = cur.K, cur.S, 0
	}
	page, err := x.readTaskPage(f)
	if err != nil {
		return err
	}
	if truthyParam(v, "raw") {
		return x.ok(map[string]any{"tasks": page.tasks, "more": page.more})
	}
	x.narrowedAlready()
	fields := splitList(v.Get("fields"))
	viewsOf := x.taskViews
	if has(fields, "description") || has(fields, "id") || has(fields, "project") {
		viewsOf = x.detailedTaskViews
	}
	views, err := viewsOf(page.tasks)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(page.text(views, x.staleView))
	}
	if len(fields) == 0 {
		fields = listFields
	}
	out := map[string]any{"tasks": pickFields(views, fields)}
	if page.more {
		if len(f.After) == 0 {
			out["next_offset"] = f.Offset + f.Limit
		}
		out["next_cursor"] = page.next
	}
	if page.changedMeanwhile > 0 {
		out["changed_while_reading"] = page.changedMeanwhile
	}
	if x.staleView != "" {
		out["note"] = x.staleView
	}
	return x.ok(out)
}

// A page of tasks is defaultTaskPage long unless limit= says otherwise, and
// never more than maxTaskPage.
const (
	defaultTaskPage = 50
	maxTaskPage     = 1000
)

// taskCount answers a task query with only how many tasks match.
func (x *c) taskCount(f store.TaskFilter) error {
	n, err := x.db.CountTasks(x.ctx(), f)
	if err != nil {
		return err
	}
	if x.wantText() {
		return x.text(fmt.Sprintf("%d\n", n))
	}
	out := map[string]any{"count": n}
	if x.staleView != "" {
		out["note"] = x.staleView
	}
	return x.ok(out)
}

// taskCursor is what a cursor= token holds. cursor= continues a list from
// where the last page ended: after the last row it gave, in the list's own
// order, so rows that close or are added meanwhile shift nothing. The token
// also holds where the feed stood when the first page was read: tasks made
// since are left for the next read. A task whose own place in the order
// changes during the walk (its priority is raised while the list is read by
// priority) could have moved behind the reader; the last page therefore ends
// with every matching task that changed since the walk began. Nothing is
// missed; a task that changed may come a second time, with its new values.
type taskCursor struct {
	K    []any  `json:"k"`
	S    int64  `json:"s"`
	Sort string `json:"q"`
}

// parseTaskCursor reads the token of a list sorted this way.
func parseTaskCursor(tok, sortedBy string) (taskCursor, error) {
	var cur taskCursor
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil || json.Unmarshal(raw, &cur) != nil || len(cur.K) != len(store.TaskSortKeys[sortedBy]) || cur.Sort != sortedBy {
		return cur, &engine.Error{Code: engine.CodeInvalid, Field: "cursor", Message: "this cursor does not belong to this list (same filters and sort as the page it came from); start again without one"}
	}
	for i, k := range cur.K {
		// Whole numbers went through JSON as floats.
		if n, ok := k.(float64); ok && n == float64(int64(n)) {
			cur.K[i] = int64(n)
		}
	}
	return cur, nil
}

// token is the cursor as a list gives it, to be sent back in cursor=.
func (cur taskCursor) token() string {
	raw, _ := json.Marshal(cur) // cannot fail: numbers and strings
	return base64.RawURLEncoding.EncodeToString(raw)
}

// taskPage is one page of a task list.
type taskPage struct {
	tasks []core.Task
	more  bool
	// next is the cursor that continues after this page, when there is more.
	next string
	// changedMeanwhile counts the tasks at the end of the last page that are
	// there because they changed while the list was being read.
	changedMeanwhile int
}

// readTaskPage reads the page a filter asks for: up to f.Limit tasks, and
// whether more follow.
func (x *c) readTaskPage(f store.TaskFilter) (taskPage, error) {
	var page taskPage
	limit := f.Limit
	f.Limit++ // one extra row says whether there are more
	tasks, err := x.db.Tasks(x.ctx(), f)
	if err != nil {
		return page, err
	}
	page.tasks = tasks
	if page.more = len(page.tasks) > limit; page.more {
		page.tasks = page.tasks[:limit]
		next, err := x.cursorAfter(f, page.tasks[limit-1])
		if err != nil {
			return page, err
		}
		page.next = next.token()
		return page, nil
	}
	if len(f.After) > 0 && f.MadeUpTo > 0 {
		moved, err := x.changedDuringWalk(f, page.tasks)
		if err != nil {
			return page, err
		}
		page.tasks, page.changedMeanwhile = append(page.tasks, moved...), len(moved)
	}
	return page, nil
}

// changedDuringWalk finds the tasks of a list that changed since a walk
// through it by cursor began, leaving out those of its last page.
func (x *c) changedDuringWalk(f store.TaskFilter, lastPage []core.Task) ([]core.Task, error) {
	again := f
	again.After, again.Offset, again.Limit, again.UpdatedAfter = nil, 0, maxTaskPage, max(f.UpdatedAfter, f.MadeUpTo)
	moved, err := x.db.Tasks(x.ctx(), again)
	if err != nil {
		return nil, err
	}
	here := map[string]bool{}
	for _, t := range lastPage {
		here[t.ID] = true
	}
	return keep(moved, func(t core.Task) bool { return !here[t.ID] }), nil
}

// cursorAfter makes the cursor that continues a list after one of its rows.
// The first page's cursor notes where the feed stands.
func (x *c) cursorAfter(f store.TaskFilter, last core.Task) (taskCursor, error) {
	cur := taskCursor{S: f.MadeUpTo, Sort: f.Sort}
	if cur.S == 0 {
		var ws core.Workspace
		if err := x.s.st.Get(x.ctx(), &ws, store.Eq("id", x.ws.ID)); err != nil {
			return cur, err
		}
		cur.S = ws.Seq
	}
	for _, k := range store.TaskSortKeys[f.Sort] {
		cur.K = append(cur.K, k.Val(last))
	}
	return cur, nil
}

// text is the page as lines, one task each. note says a view named in the
// query was out of date.
func (page taskPage) text(views []taskView, note string) string {
	out := lines(views, taskView.line, "no tasks match")
	if page.more {
		out += fmt.Sprintf("… more: add cursor=%s\n", page.next)
	}
	if note != "" {
		out = "note: " + note + "\n" + out
	}
	if page.changedMeanwhile > 0 {
		out += fmt.Sprintf("… the last %d changed while you were reading; you may have seen them before\n", page.changedMeanwhile)
	}
	return out
}
