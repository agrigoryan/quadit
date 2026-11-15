// The task and event lists, the two reads a Q cannot express:
// a task filter's conditions group by group, keyset paging, and the feed.

package sqlstore

import (
	"context"
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// The number of rows a list returns when its filter asks for none, or for
// more than the most it may have.
const (
	defaultTaskLimit  = 100
	maxTaskLimit      = 5000
	defaultEventLimit = 200
	maxEventLimit     = 2000
)

// limitOr is asked when it is in 1..most, else byDefault.
func limitOr(asked, byDefault, most int) int {
	if asked <= 0 || asked > most {
		return byDefault
	}
	return asked
}

// taskWhere builds the WHERE of a task filter on the tasks table under the
// alias t: the workspace, then each group of conditions below in a fixed
// order, so that one filter always makes the same statement. Values that
// should be ids and are not select nothing rather than fail (idOrNone).
func (c conn) taskWhere(filter store.TaskFilter) *clause {
	where := &clause{}
	if c.workspaceID != "" {
		where.add(`t.workspace_id = ?`, c.workspaceID)
	}
	taskLife(where, &filter)
	taskWhich(where, &filter)
	taskWho(where, &filter)
	taskState(where, &filter)
	taskLabels(where, &filter)
	taskPlace(where, &filter)
	taskDue(where, &filter)
	taskFollowers(where, &filter)
	taskChangedAfter(where, &filter)
	taskDecisions(where, &filter)
	taskText(where, &filter)
	return where
}

// taskLife keeps live tasks, or with InTrash only deleted ones; archived
// tasks only with Archived.
func taskLife(where *clause, filter *store.TaskFilter) {
	if filter.InTrash {
		where.add(`t.deleted_at IS NOT NULL`)
		return
	}
	where.add(`t.deleted_at IS NULL`)
	if !filter.Archived {
		where.add(`t.archived_at IS NULL`)
	}
}

// taskWhich keeps the tasks named by id or key, or in the projects.
func taskWhich(where *clause, filter *store.TaskFilter) {
	if len(filter.IDs) > 0 {
		where.inIDs(`t.id`, filter.IDs)
	}
	if len(filter.Keys) > 0 {
		where.in(`t.key`, filter.Keys)
	}
	if len(filter.ProjectIDs) > 0 {
		where.inIDs(`t.project_id`, filter.ProjectIDs)
	}
}

// taskWho is about people: the assignee, who made the task, what it waits
// on, and who holds its lease.
func taskWho(where *clause, filter *store.TaskFilter) {
	where.inOrNone(`t.assignee_id`, filter.AssigneeIDs, filter.Unassigned)
	if filter.CreatedBy != "" {
		where.add(`t.created_by = ?`, idOrNone(filter.CreatedBy))
	}
	if filter.WaitingOutside {
		where.add(`t.waiting_outside`)
	}
	if filter.WaitingNobody {
		where.add(`t.waiting_on_id IS NULL AND NOT t.waiting_outside`)
	}
	if filter.WaitingOnID != "" {
		where.add(`t.waiting_on_id = ?`, idOrNone(filter.WaitingOnID))
	}
	if filter.LeaseHolderID != "" {
		where.add(`t.lease_holder_id = ?`, idOrNone(filter.LeaseHolderID))
	}
}

// taskState is about where a task is in its life: its status or the
// status's category, open or closed, and made at or before a feed position.
func taskState(where *clause, filter *store.TaskFilter) {
	if len(filter.StatusIDs) > 0 {
		where.inIDs(`t.status_id`, filter.StatusIDs)
	}
	if len(filter.Categories) > 0 {
		list, args := placeholdersFor(filter.Categories)
		where.add(`t.status_id IN (SELECT id FROM statuses WHERE workspace_id = t.workspace_id AND category IN (`+list+`))`, args...)
	}
	if filter.Open {
		where.add(`t.status_id IN (SELECT id FROM statuses WHERE workspace_id = t.workspace_id AND category NOT IN ('done', 'canceled'))`)
	}
	if filter.MadeUpTo > 0 {
		where.add(`t.created_seq <= ?`, filter.MadeUpTo)
	}
	if filter.Closed {
		where.add(`(t.archived_at IS NOT NULL OR t.status_id IN (SELECT id FROM statuses WHERE workspace_id = t.workspace_id AND category IN ('done', 'canceled')))`)
	}
}

// taskLabels keeps the tasks that have every one of the labels.
func taskLabels(where *clause, filter *store.TaskFilter) {
	for _, label := range filter.LabelIDs {
		where.add(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)`, idOrNone(label))
	}
}

// taskPlace is about where a task sits in the plan: its parent, epic,
// milestone and cycle, and its priority.
func taskPlace(where *clause, filter *store.TaskFilter) {
	if filter.ParentID != "" {
		where.add(`t.parent_id = ?`, idOrNone(filter.ParentID))
	}
	if filter.TopLevel {
		where.add(`t.parent_id IS NULL`)
	}
	where.inOrNone(`t.epic_id`, filter.EpicIDs, filter.NoEpic)
	if filter.MilestoneID != "" {
		where.add(`t.milestone_id = ?`, idOrNone(filter.MilestoneID))
	}
	where.inOrNone(`t.cycle_id`, filter.CycleIDs, filter.NoCycle)
	if len(filter.Priorities) > 0 {
		args := make([]any, len(filter.Priorities))
		for i, priority := range filter.Priorities {
			args[i] = priority
		}
		where.add(`t.priority IN (`+placeholders(len(filter.Priorities))+`)`, args...)
	}
}

// taskDue keeps the tasks due in a range of dates.
func taskDue(where *clause, filter *store.TaskFilter) {
	if filter.DueBefore != "" {
		where.add(`t.due_on <= ?`, filter.DueBefore)
	}
	if filter.DueAfter != "" {
		where.add(`t.due_on >= ?`, filter.DueAfter)
	}
}

// taskFollowers keeps the tasks that mention a member, or that a member
// watches.
func taskFollowers(where *clause, filter *store.TaskFilter) {
	if filter.MentionsID != "" {
		where.add(`EXISTS (SELECT 1 FROM refs r WHERE r.from_scope_id = t.id AND r.to_id = ?)`, idOrNone(filter.MentionsID))
	}
	if filter.WatchedBy != "" {
		where.add(`EXISTS (SELECT 1 FROM watchers wt WHERE wt.subject_id = t.id AND wt.user_id = ?)`, idOrNone(filter.WatchedBy))
	}
}

// taskChangedAfter keeps the tasks in which something happened, or whose
// own fields changed, after a feed position.
func taskChangedAfter(where *clause, filter *store.TaskFilter) {
	if filter.ActivityAfter > 0 {
		where.add(`t.activity_seq > ?`, filter.ActivityAfter)
	}
	if filter.UpdatedAfter > 0 {
		where.add(`t.updated_seq > ?`, filter.UpdatedAfter)
	}
}

// taskDecisions keeps the tasks with an open decision, or one asked of a
// member.
func taskDecisions(where *clause, filter *store.TaskFilter) {
	if filter.OpenDecision {
		where.add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL)`)
	}
	if filter.AskedID != "" {
		where.add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL AND d.asked_id = ?)`, idOrNone(filter.AskedID))
	}
}

// taskText keeps the tasks whose title or key holds the text, in any case.
// LIKE's wildcards in the text are taken out ("%") or made a space ("_").
func taskText(where *clause, filter *store.TaskFilter) {
	if filter.Text == "" {
		return
	}
	like := "%" + strings.ToLower(strings.NewReplacer("%", "", "_", " ").Replace(filter.Text)) + "%"
	where.add(`(LOWER(t.title) LIKE ? OR LOWER(t.key) LIKE ?)`, like, like)
}

// TaskSorts lists the accepted values of TaskFilter.Sort.
func TaskSorts() []string {
	return []string{"created", "-created", "rank", "priority", "due", "-activity", "-updated", "key"}
}

// Tasks lists the tasks a filter selects, in its sort order. With After it
// continues past the last row of the previous page (see afterRow).
func (c conn) Tasks(ctx context.Context, filter store.TaskFilter) ([]core.Task, error) {
	m, err := metaOf(reflect.TypeFor[core.Task]())
	if err != nil {
		return nil, err
	}
	keys, ok := store.TaskSortKeys[filter.Sort]
	if !ok {
		return nil, fmt.Errorf("unknown sort %q", filter.Sort)
	}
	where := c.taskWhere(filter)
	if len(filter.After) == len(keys) && len(keys) > 0 {
		c.afterRow(where, keys, filter.After)
	}
	query := "SELECT t." + strings.ReplaceAll(m.cols, ", ", ", t.") + " FROM tasks t WHERE " + where.sql() +
		" ORDER BY " + sortOrder(keys) + fmt.Sprintf(" LIMIT %d", limitOr(filter.Limit, defaultTaskLimit, maxTaskLimit))
	if filter.Offset > 0 {
		query += fmt.Sprintf(" OFFSET %d", filter.Offset)
	}
	rows, err := c.query(ctx, query, where.args...)
	if err != nil {
		return nil, err
	}
	var out []core.Task
	// Fill first, then return: in one statement Go may read out before the
	// call has filled it.
	if err := scanAll(rows, m, reflect.ValueOf(&out).Elem()); err != nil {
		return nil, err
	}
	return out, nil
}

// sortOrder is the ORDER BY list of a task sort.
func sortOrder(keys []store.SortKey) string {
	orders := make([]string, 0, len(keys))
	for _, key := range keys {
		if key.Desc {
			orders = append(orders, key.Expr+" DESC")
		} else {
			orders = append(orders, key.Expr)
		}
	}
	return strings.Join(orders, ", ")
}

// afterRow adds keyset paging to where: "sorts after the last row read",
// which is later in the first key, or equal there and later in the second,
// and so on:
//
//	((k1 > ?) OR (k1 = ? AND k2 > ?) OR (k1 = ? AND k2 = ? AND k3 > ?))
//
// with "<" for a descending key. The page then does not shift when rows are
// added or closed between reads, which an OFFSET would.
//
// A value appears in several alternatives. On SQLite (Dialect.NamesRepeats)
// it is passed once and named by its number, "?3", wherever it repeats:
// SQLite reads the alternatives as a range of an index on k1 only when both
// k1 values are the same parameter. Numbers count from the start of the
// query, so where must be the query's first clause.
func (c conn) afterRow(where *clause, keys []store.SortKey, after []any) {
	params := keysetParams{after: after, numbered: c.dialect.NamesRepeats, before: len(where.args), named: map[int]string{}}
	alternatives := make([]string, 0, len(keys))
	for i, key := range keys {
		var parts []string
		for j := range i {
			parts = append(parts, keys[j].Expr+" = "+params.param(j))
		}
		op := " > "
		if key.Desc {
			op = " < "
		}
		parts = append(parts, key.Expr+op+params.param(i))
		alternatives = append(alternatives, "("+strings.Join(parts, " AND ")+")")
	}
	where.add("("+strings.Join(alternatives, " OR ")+")", params.args...)
}

// keysetParams hands out the placeholders of afterRow's condition and
// collects their values.
type keysetParams struct {
	after    []any          // the last row's sort key values
	numbered bool           // name a repeated value by its number
	before   int            // how many placeholders the query has before these
	args     []any          // the values to pass, in placeholder order
	named    map[int]string // key index -> its numbered placeholder
}

// param returns the placeholder of the i-th key's value: a plain "?" with
// the value passed again, or the value's own "?N", passed the first time.
func (p *keysetParams) param(i int) string {
	if !p.numbered {
		p.args = append(p.args, p.after[i])
		return "?"
	}
	if name, ok := p.named[i]; ok {
		return name
	}
	p.args = append(p.args, p.after[i])
	p.named[i] = "?" + strconv.Itoa(p.before+len(p.args))
	return p.named[i]
}

// CountTasks counts the tasks a filter selects.
func (c conn) CountTasks(ctx context.Context, filter store.TaskFilter) (int, error) {
	where := c.taskWhere(filter)
	var n int
	err := c.row(ctx, "SELECT COUNT(*) FROM tasks t WHERE "+where.sql(), where.args...).Scan(&n)
	return n, err
}

// Events reads the feed: the events a filter selects, by sequence number.
func (c conn) Events(ctx context.Context, filter store.EventFilter) ([]core.Event, error) {
	m, err := metaOf(reflect.TypeFor[core.Event]())
	if err != nil {
		return nil, err
	}
	where := c.eventWhere(filter)
	order := "e.seq"
	if filter.Desc {
		order = "e.seq DESC"
	}
	rows, err := c.query(ctx, "SELECT e."+strings.ReplaceAll(m.cols, ", ", ", e.")+" FROM events e WHERE "+where.sql()+
		" ORDER BY "+order+fmt.Sprintf(" LIMIT %d", limitOr(filter.Limit, defaultEventLimit, maxEventLimit)), where.args...)
	if err != nil {
		return nil, err
	}
	var out []core.Event
	// Fill first, then return: in one statement Go may read out before the
	// call has filled it.
	if err := scanAll(rows, m, reflect.ValueOf(&out).Elem()); err != nil {
		return nil, err
	}
	return out, nil
}

// eventWhere builds the WHERE of an event filter on the events table under
// the alias e: the workspace, then each group of conditions in a fixed
// order.
func (c conn) eventWhere(filter store.EventFilter) *clause {
	where := &clause{}
	if c.workspaceID != "" {
		where.add(`e.workspace_id = ?`, c.workspaceID)
	}
	eventRange(where, &filter)
	eventPlace(where, &filter)
	eventKind(where, &filter)
	eventAudience(where, &filter)
	if filter.Tasks != nil {
		tasks := c.taskWhere(*filter.Tasks)
		where.add(`e.scope_type = 'task' AND e.scope_id IN (SELECT t.id FROM tasks t WHERE `+tasks.sql()+`)`, tasks.args...)
	}
	return where
}

// eventRange keeps the events after, or before, a sequence number.
func eventRange(where *clause, filter *store.EventFilter) {
	if filter.After > 0 {
		where.add(`e.seq > ?`, filter.After)
	}
	if filter.Before > 0 {
		where.add(`e.seq < ?`, filter.Before)
	}
}

// eventPlace keeps one object's timeline, or the events of some projects
// (and with AllowNoProject those of no project).
func eventPlace(where *clause, filter *store.EventFilter) {
	if filter.ScopeID != "" {
		where.add(`e.scope_id = ?`, idOrNone(filter.ScopeID))
		if filter.ScopeType != "" {
			where.add(`e.scope_type = ?`, filter.ScopeType)
		}
	}
	if len(filter.ProjectIDs) > 0 {
		where.inOrNone(`e.project_id`, filter.ProjectIDs, filter.AllowNoProject)
	}
}

// eventKind keeps events of some types, or by (or not by) an actor.
func eventKind(where *clause, filter *store.EventFilter) {
	if len(filter.Types) > 0 {
		where.in(`e.type`, filter.Types)
	}
	if filter.ActorID != "" {
		where.add(`e.actor_id = ?`, idOrNone(filter.ActorID))
	}
	if filter.NotActorID != "" {
		where.add(`e.actor_id <> ?`, idOrNone(filter.NotActorID))
	}
}

// eventAudience keeps only the events addressed to one member, or hides
// from a viewer the events addressed to someone else.
func eventAudience(where *clause, filter *store.EventFilter) {
	if filter.OnlyAudience != "" {
		where.add(`e.audience_id = ?`, idOrNone(filter.OnlyAudience))
	} else if filter.Viewer != "" {
		// Public events, the viewer's own, and those of private pages that
		// are shared with the viewer.
		where.add(`(e.audience_id IS NULL OR e.audience_id = ? OR (e.scope_type = 'doc' AND e.scope_id IN
			(SELECT d.id FROM docs d WHERE d.workspace_id = e.workspace_id AND CAST(d.shared_with AS TEXT) LIKE ?)))`,
			idOrNone(filter.Viewer), `%"`+idOrNone(filter.Viewer)+`"%`)
	}
}
