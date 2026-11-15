package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

var listFields = []string{"key", "title", "status", "priority", "assignee", "waiting_on", "held_by", "labels", "due_on", "parent", "seq"}

// handleListTasks answers a task query. count=1 returns only how many match.
func (s *Server) handleListTasks(x *c) error {
	q, err := x.queryFromRequest()
	if err != nil {
		return err
	}
	f, err := x.filter(q)
	if err != nil {
		return err
	}
	v := x.r.URL.Query()
	if truthyParam(v, "count") {
		return x.taskCount(f)
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	if f.Limit > 1000 {
		f.Limit = 1000
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
	views, err := x.taskViews(page.tasks, has(fields, "description") || has(fields, "id") || has(fields, "project"))
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
	raw, _ := json.Marshal(cur)
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
	var p taskPage
	limit := f.Limit
	f.Limit++ // one extra row says whether there are more
	tasks, err := x.db.Tasks(x.ctx(), f)
	if err != nil {
		return p, err
	}
	p.tasks = tasks
	if p.more = len(p.tasks) > limit; p.more {
		p.tasks = p.tasks[:limit]
		p.next = x.cursorAfter(f, p.tasks[limit-1]).token()
		return p, nil
	}
	if len(f.After) > 0 && f.MadeUpTo > 0 {
		moved, err := x.changedDuringWalk(f, p.tasks)
		if err != nil {
			return p, err
		}
		p.tasks, p.changedMeanwhile = append(p.tasks, moved...), len(moved)
	}
	return p, nil
}

// changedDuringWalk finds the tasks of a list that changed since a walk
// through it by cursor began, leaving out those of its last page.
func (x *c) changedDuringWalk(f store.TaskFilter, lastPage []core.Task) ([]core.Task, error) {
	again := f
	again.After, again.Offset, again.Limit, again.UpdatedAfter = nil, 0, 1000, max(f.UpdatedAfter, f.MadeUpTo)
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
func (x *c) cursorAfter(f store.TaskFilter, last core.Task) taskCursor {
	cur := taskCursor{S: f.MadeUpTo, Sort: f.Sort}
	if cur.S == 0 {
		var ws core.Workspace
		if err := x.s.st.Get(x.ctx(), &ws, store.Eq("id", x.ws.ID)); err == nil {
			cur.S = ws.Seq
		}
	}
	for _, k := range store.TaskSortKeys[f.Sort] {
		cur.K = append(cur.K, k.Val(last))
	}
	return cur
}

// text is the page as lines, one task each. note says a view named in the
// query was out of date.
func (p taskPage) text(views []taskView, note string) string {
	out := lines(views, taskView.line, "no tasks match")
	if p.more {
		out += fmt.Sprintf("… more: add cursor=%s\n", p.next)
	}
	if note != "" {
		out = "note: " + note + "\n" + out
	}
	if p.changedMeanwhile > 0 {
		out += fmt.Sprintf("… the last %d changed while you were reading; you may have seen them before\n", p.changedMeanwhile)
	}
	return out
}
