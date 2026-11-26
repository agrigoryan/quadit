// The task and event lists, the two reads a Q cannot express:
// a task filter's conditions, keyset paging, and the feed.

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

// The number of rows a list returns when its filter asks for none, and the
// most it returns whatever it asks for.
const (
	defaultTaskLimit  = 100
	maxTaskLimit      = 5000
	defaultEventLimit = 200
	maxEventLimit     = 2000
)

// limitOr is asked, held to most; byDefault when nothing is asked.
func limitOr(asked, byDefault, most int) int {
	if asked <= 0 {
		return byDefault
	}
	return min(asked, most)
}

// taskWhere builds the WHERE of a task filter on the tasks table under the
// alias t: the workspace, then each condition the filter asks for, always in
// this order, so that one filter always makes the same statement. Values
// that should be ids and are not select nothing rather than fail (idOrNone).
func (c conn) taskWhere(filter store.TaskFilter) *clause {
	where := &clause{}
	if c.workspaceID != "" {
		where.add(`t.workspace_id = ?`, c.workspaceID)
	}
	// Live tasks, or with InTrash only deleted ones; archived ones only with
	// Archived.
	if filter.InTrash {
		where.add(`t.deleted_at IS NOT NULL`)
	} else {
		where.add(`t.deleted_at IS NULL`)
		if !filter.Archived {
			where.add(`t.archived_at IS NULL`)
		}
	}
	// Which tasks: by id, by key, by project.
	if len(filter.IDs) > 0 {
		where.inIDs(`t.id`, filter.IDs)
	}
	if len(filter.Keys) > 0 {
		where.in(`t.key`, filter.Keys)
	}
	if len(filter.ProjectIDs) > 0 {
		where.inIDs(`t.project_id`, filter.ProjectIDs)
	}
	// People: the assignee, who made the task, what it waits on, who holds
	// its lease.
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
	// State: the status or its category, open or closed, made at or before a
	// feed position.
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
	// Labels: every one of them.
	for _, label := range filter.LabelIDs {
		where.add(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)`, idOrNone(label))
	}
	// The plan: parent, epic, milestone, cycle.
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
	// Priority.
	if len(filter.Priorities) > 0 {
		args := make([]any, len(filter.Priorities))
		for i, priority := range filter.Priorities {
			args[i] = priority
		}
		where.add(`t.priority IN (`+placeholders(len(filter.Priorities))+`)`, args...)
	}
	// Estimate: one of these, or none.
	if len(filter.Estimates) > 0 || filter.NoEstimate {
		var choices []string
		var args []any
		if filter.NoEstimate {
			choices = append(choices, `t.estimate IS NULL`)
		}
		if len(filter.Estimates) > 0 {
			choices = append(choices, `t.estimate IN (`+placeholders(len(filter.Estimates))+`)`)
			for _, estimate := range filter.Estimates {
				args = append(args, estimate)
			}
		}
		where.add(`(`+strings.Join(choices, ` OR `)+`)`, args...)
	}
	// Due in a range of dates.
	if filter.DueBefore != "" {
		where.add(`t.due_on <= ?`, filter.DueBefore)
	}
	if filter.DueAfter != "" {
		where.add(`t.due_on >= ?`, filter.DueAfter)
	}
	// Mentioning a member, watched by one, or one's own: assigned to them,
	// waiting on them, mentioning them or watched by them.
	if filter.MentionsID != "" {
		where.add(`EXISTS (SELECT 1 FROM refs r WHERE r.from_scope_id = t.id AND r.to_id = ?)`, idOrNone(filter.MentionsID))
	}
	if filter.WatchedBy != "" {
		where.add(`EXISTS (SELECT 1 FROM watchers wt WHERE wt.subject_id = t.id AND wt.user_id = ?)`, idOrNone(filter.WatchedBy))
	}
	if filter.Involves != "" {
		who := idOrNone(filter.Involves)
		where.add(`(t.assignee_id = ? OR t.waiting_on_id = ? OR EXISTS (SELECT 1 FROM refs r WHERE r.from_scope_id = t.id AND r.to_id = ?) OR EXISTS (SELECT 1 FROM watchers wt WHERE wt.subject_id = t.id AND wt.user_id = ?))`,
			who, who, who, who)
	}
	// Something happened in the task, or its own fields changed, after a
	// feed position.
	if filter.ActivityAfter > 0 {
		where.add(`t.activity_seq > ?`, filter.ActivityAfter)
	}
	if filter.UpdatedAfter > 0 {
		where.add(`t.updated_seq > ?`, filter.UpdatedAfter)
	}
	// An open decision, or one asked of a member.
	if filter.OpenDecision {
		where.add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL)`)
	}
	if filter.AskedID != "" {
		where.add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL AND d.asked_id = ?)`, idOrNone(filter.AskedID))
	}
	// Text in the title or the key, in any case. LIKE's wildcards in the
	// text are taken out ("%") or made a space ("_").
	if filter.Text != "" {
		like := "%" + strings.ToLower(strings.NewReplacer("%", "", "_", " ").Replace(filter.Text)) + "%"
		where.add(`(LOWER(t.title) LIKE ? OR LOWER(t.key) LIKE ?)`, like, like)
	}
	return where
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
	var args []any               // the values to pass, in placeholder order
	numbered := map[int]string{} // key index -> its numbered placeholder
	// param is the placeholder of the i-th key's value: a plain "?" with the
	// value passed again, or the value's own "?N", passed the first time.
	param := func(i int) string {
		if !c.dialect.NamesRepeats {
			args = append(args, after[i])
			return "?"
		}
		if name, ok := numbered[i]; ok {
			return name
		}
		args = append(args, after[i])
		numbered[i] = "?" + strconv.Itoa(len(where.args)+len(args))
		return numbered[i]
	}
	alternatives := make([]string, 0, len(keys))
	for i, key := range keys {
		var parts []string
		for j := range i {
			parts = append(parts, keys[j].Expr+" = "+param(j))
		}
		op := " > "
		if key.Desc {
			op = " < "
		}
		parts = append(parts, key.Expr+op+param(i))
		alternatives = append(alternatives, "("+strings.Join(parts, " AND ")+")")
	}
	where.add("("+strings.Join(alternatives, " OR ")+")", args...)
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
// the alias e: the workspace, then each condition the filter asks for, in a
// fixed order.
func (c conn) eventWhere(filter store.EventFilter) *clause {
	where := &clause{}
	if c.workspaceID != "" {
		where.add(`e.workspace_id = ?`, c.workspaceID)
	}
	// After, or before, a sequence number.
	if filter.After > 0 {
		where.add(`e.seq > ?`, filter.After)
	}
	if filter.Before > 0 {
		where.add(`e.seq < ?`, filter.Before)
	}
	// One object's timeline, or the events of some projects (and with
	// AllowNoProject those of no project), or not of others.
	if filter.ScopeID != "" {
		where.add(`e.scope_id = ?`, idOrNone(filter.ScopeID))
		if filter.ScopeType != "" {
			where.add(`e.scope_type = ?`, filter.ScopeType)
		}
	}
	if len(filter.ProjectIDs) > 0 {
		where.inOrNone(`e.project_id`, filter.ProjectIDs, filter.AllowNoProject)
	}
	if leave := onlyIDs(filter.NotProjectIDs); len(leave) > 0 {
		list, args := placeholdersFor(leave)
		where.add(`(e.project_id IS NULL OR e.project_id NOT IN (`+list+`))`, args...)
	}
	// Of some types, or by (or not by) an actor.
	if len(filter.Types) > 0 {
		where.in(`e.type`, filter.Types)
	}
	if filter.ActorID != "" {
		where.add(`e.actor_id = ?`, idOrNone(filter.ActorID))
	}
	if filter.NotActorID != "" {
		where.add(`e.actor_id <> ?`, idOrNone(filter.NotActorID))
	}
	// Only the events addressed to one member, or, for a viewer: public
	// events, the viewer's own, and those of private pages that are shared
	// with the viewer.
	if filter.OnlyAudience != "" {
		where.add(`e.audience_id = ?`, idOrNone(filter.OnlyAudience))
	} else if filter.Viewer != "" {
		where.add(`(e.audience_id IS NULL OR e.audience_id = ? OR (e.scope_type = 'doc' AND e.scope_id IN
			(SELECT d.id FROM docs d WHERE d.workspace_id = e.workspace_id AND CAST(d.shared_with AS TEXT) LIKE ?)))`,
			idOrNone(filter.Viewer), `%"`+idOrNone(filter.Viewer)+`"%`)
	}
	// Events in the tasks a task filter selects.
	if filter.Tasks != nil {
		tasks := c.taskWhere(*filter.Tasks)
		where.add(`e.scope_type = 'task' AND e.scope_id IN (SELECT t.id FROM tasks t WHERE `+tasks.sql()+`)`, tasks.args...)
	}
	return where
}
