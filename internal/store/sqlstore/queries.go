package sqlstore

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// clause collects WHERE parts and their arguments.
type clause struct {
	parts []string
	args  []any
}

func (c *clause) add(cond string, a ...any) {
	c.parts = append(c.parts, cond)
	c.args = append(c.args, a...)
}

// in adds "col IN (...)" for ids, dropping values that cannot be ids.
func (c *clause) in(col string, vals []string, ids bool) {
	var keep []string
	for _, v := range vals {
		if !ids || looksUUID(v) {
			keep = append(keep, v)
		}
	}
	if len(keep) == 0 {
		c.add("1 = 0")
		return
	}
	m, a := marks(keep)
	c.add(col+" IN ("+m+")", a...)
}

func (c *clause) sql() string {
	if len(c.parts) == 0 {
		return "1 = 1"
	}
	return strings.Join(c.parts, " AND ")
}

// id returns v if it is an id, else a value no row has, so a bad reference
// selects nothing instead of failing on Postgres.
func idOrNone(v string) string {
	if looksUUID(v) {
		return v
	}
	return "00000000-0000-0000-0000-000000000000"
}

// taskWhere builds the conditions of a task filter on alias t.
func (c conn) taskWhere(f store.TaskFilter) *clause {
	w := &clause{}
	if c.ws != "" {
		w.add(`t.workspace_id = ?`, c.ws)
	}
	if f.InTrash {
		w.add(`t.deleted_at IS NOT NULL`)
	} else {
		w.add(`t.deleted_at IS NULL`)
		if !f.Archived {
			w.add(`t.archived_at IS NULL`)
		}
	}
	if len(f.IDs) > 0 {
		w.in(`t.id`, f.IDs, true)
	}
	if len(f.Keys) > 0 {
		w.in(`t.key`, f.Keys, false)
	}
	if len(f.ProjectIDs) > 0 {
		w.in(`t.project_id`, f.ProjectIDs, true)
	}
	if f.Unassigned {
		w.add(`t.assignee_id IS NULL`)
	} else if len(f.AssigneeIDs) > 0 {
		w.in(`t.assignee_id`, f.AssigneeIDs, true)
	}
	if f.CreatedBy != "" {
		w.add(`t.created_by = ?`, idOrNone(f.CreatedBy))
	}
	if f.WaitingOnID != "" {
		w.add(`t.waiting_on_id = ?`, idOrNone(f.WaitingOnID))
	}
	if f.LeaseHolderID != "" {
		w.add(`t.lease_holder_id = ?`, idOrNone(f.LeaseHolderID))
	}
	if len(f.StatusIDs) > 0 {
		w.in(`t.status_id`, f.StatusIDs, true)
	}
	if len(f.Categories) > 0 {
		m, a := marks(f.Categories)
		w.add(`t.status_id IN (SELECT id FROM statuses WHERE workspace_id = t.workspace_id AND category IN (`+m+`))`, a...)
	}
	if f.Open {
		w.add(`t.status_id IN (SELECT id FROM statuses WHERE workspace_id = t.workspace_id AND category NOT IN ('done', 'canceled'))`)
	}
	for _, l := range f.LabelIDs {
		w.add(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)`, idOrNone(l))
	}
	if f.ParentID != "" {
		w.add(`t.parent_id = ?`, idOrNone(f.ParentID))
	}
	if f.TopLevel {
		w.add(`t.parent_id IS NULL`)
	}
	if f.NoEpic {
		w.add(`t.epic_id IS NULL`)
	} else if len(f.EpicIDs) > 0 {
		w.in(`t.epic_id`, f.EpicIDs, true)
	}
	if f.MilestoneID != "" {
		w.add(`t.milestone_id = ?`, idOrNone(f.MilestoneID))
	}
	if f.NoCycle {
		w.add(`t.cycle_id IS NULL`)
	} else if len(f.CycleIDs) > 0 {
		w.in(`t.cycle_id`, f.CycleIDs, true)
	}
	if len(f.Priorities) > 0 {
		m := placeholders(len(f.Priorities))
		a := make([]any, len(f.Priorities))
		for i, p := range f.Priorities {
			a[i] = p
		}
		w.add(`t.priority IN (`+m+`)`, a...)
	}
	if f.DueBefore != "" {
		w.add(`t.due_on <= ?`, f.DueBefore)
	}
	if f.DueAfter != "" {
		w.add(`t.due_on >= ?`, f.DueAfter)
	}
	if f.MentionsID != "" {
		w.add(`EXISTS (SELECT 1 FROM refs r WHERE r.from_scope_id = t.id AND r.to_id = ?)`, idOrNone(f.MentionsID))
	}
	if f.WatchedBy != "" {
		w.add(`EXISTS (SELECT 1 FROM watchers wt WHERE wt.subject_id = t.id AND wt.user_id = ?)`, idOrNone(f.WatchedBy))
	}
	if f.ActivityAfter > 0 {
		w.add(`t.activity_seq > ?`, f.ActivityAfter)
	}
	if f.UpdatedAfter > 0 {
		w.add(`t.updated_seq > ?`, f.UpdatedAfter)
	}
	if f.OpenDecision {
		w.add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL)`)
	}
	if f.AskedID != "" {
		w.add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL AND d.asked_id = ?)`, idOrNone(f.AskedID))
	}
	if f.Text != "" {
		like := "%" + strings.ToLower(strings.NewReplacer("%", "", "_", " ").Replace(f.Text)) + "%"
		w.add(`(LOWER(t.title) LIKE ? OR LOWER(t.key) LIKE ?)`, like, like)
	}
	return w
}

var taskSorts = map[string]string{
	"":          "t.id",
	"created":   "t.id",
	"-created":  "t.id DESC",
	"rank":      "t.rank, t.id",
	"priority":  "CASE t.priority WHEN 0 THEN 5 ELSE t.priority END, t.id",
	"due":       "CASE WHEN t.due_on IS NULL THEN 1 ELSE 0 END, t.due_on, t.id",
	"-activity": "t.activity_seq DESC",
	"-updated":  "t.updated_seq DESC",
	"key":       "t.project_id, t.number",
}

// TaskSorts lists the accepted values of TaskFilter.Sort.
func TaskSorts() []string {
	return []string{"created", "-created", "rank", "priority", "due", "-activity", "-updated", "key"}
}

func (c conn) Tasks(ctx context.Context, f store.TaskFilter) ([]core.Task, error) {
	m, err := metaOf(reflect.TypeFor[core.Task]())
	if err != nil {
		return nil, err
	}
	order, ok := taskSorts[f.Sort]
	if !ok {
		return nil, fmt.Errorf("unknown sort %q", f.Sort)
	}
	limit := f.Limit
	if limit <= 0 || limit > 5000 {
		limit = 100
	}
	w := c.taskWhere(f)
	query := "SELECT t." + strings.ReplaceAll(m.cols, ", ", ", t.") + " FROM tasks t WHERE " + w.sql() +
		" ORDER BY " + order + fmt.Sprintf(" LIMIT %d", limit)
	if f.Offset > 0 {
		query += fmt.Sprintf(" OFFSET %d", f.Offset)
	}
	rows, err := c.query(ctx, query, w.args...)
	if err != nil {
		return nil, err
	}
	var out []core.Task
	return out, scanAll(rows, m, reflect.ValueOf(&out).Elem())
}

func (c conn) CountTasks(ctx context.Context, f store.TaskFilter) (int, error) {
	w := c.taskWhere(f)
	var n int
	err := c.row(ctx, "SELECT COUNT(*) FROM tasks t WHERE "+w.sql(), w.args...).Scan(&n)
	return n, err
}

func (c conn) Events(ctx context.Context, f store.EventFilter) ([]core.Event, error) {
	m, err := metaOf(reflect.TypeFor[core.Event]())
	if err != nil {
		return nil, err
	}
	w := &clause{}
	if c.ws != "" {
		w.add(`e.workspace_id = ?`, c.ws)
	}
	if f.After > 0 {
		w.add(`e.seq > ?`, f.After)
	}
	if f.Before > 0 {
		w.add(`e.seq < ?`, f.Before)
	}
	if f.ScopeID != "" {
		w.add(`e.scope_id = ?`, idOrNone(f.ScopeID))
		if f.ScopeType != "" {
			w.add(`e.scope_type = ?`, f.ScopeType)
		}
	}
	if len(f.ProjectIDs) > 0 {
		w.in(`e.project_id`, f.ProjectIDs, true)
	}
	if len(f.Types) > 0 {
		w.in(`e.type`, f.Types, false)
	}
	if f.ActorID != "" {
		w.add(`e.actor_id = ?`, idOrNone(f.ActorID))
	}
	if f.NotActorID != "" {
		w.add(`e.actor_id <> ?`, idOrNone(f.NotActorID))
	}
	if f.OnlyAudience != "" {
		w.add(`e.audience_id = ?`, idOrNone(f.OnlyAudience))
	} else if f.Viewer != "" {
		w.add(`(e.audience_id IS NULL OR e.audience_id = ?)`, idOrNone(f.Viewer))
	}
	if f.Tasks != nil {
		tw := c.taskWhere(*f.Tasks)
		w.add(`e.scope_type = 'task' AND e.scope_id IN (SELECT t.id FROM tasks t WHERE `+tw.sql()+`)`, tw.args...)
	}
	limit := f.Limit
	if limit <= 0 || limit > 2000 {
		limit = 200
	}
	order := "e.seq"
	if f.Desc {
		order = "e.seq DESC"
	}
	rows, err := c.query(ctx, "SELECT e."+strings.ReplaceAll(m.cols, ", ", ", e.")+" FROM events e WHERE "+w.sql()+
		" ORDER BY "+order+fmt.Sprintf(" LIMIT %d", limit), w.args...)
	if err != nil {
		return nil, err
	}
	var out []core.Event
	return out, scanAll(rows, m, reflect.ValueOf(&out).Elem())
}

// ---- full-text search ----

// searchTerms cuts free text into words safe to hand to either database.
func searchTerms(text string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r > 127)
	}) {
		if len(out) < 12 {
			out = append(out, w)
		}
	}
	return out
}

func (c conn) Index(ctx context.Context, d store.SearchDoc) error {
	ws := c.ws
	if ws == "" {
		return fmt.Errorf("store: Index needs a workspace-bound DB")
	}
	if c.d.Name == "postgres" {
		_, err := c.exec(ctx, `INSERT INTO search_index (workspace_id, kind, entity_id, scope_type, scope_id, project_id, audience_id, title, body)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (entity_id) DO UPDATE SET kind = excluded.kind, scope_type = excluded.scope_type, scope_id = excluded.scope_id,
			project_id = excluded.project_id, audience_id = excluded.audience_id, title = excluded.title, body = excluded.body`,
			ws, d.Kind, d.EntityID, d.ScopeType, d.ScopeID, nz(d.ProjectID), nz(d.AudienceID), d.Title, d.Body)
		return err
	}
	if err := c.Unindex(ctx, d.EntityID); err != nil {
		return err
	}
	res, err := c.exec(ctx, `INSERT INTO search_index (title, body, workspace_id, kind, entity_id, scope_type, scope_id, project_id, audience_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.Title, d.Body, ws, d.Kind, d.EntityID, d.ScopeType, d.ScopeID, d.ProjectID, d.AudienceID)
	if err != nil {
		return err
	}
	rid, err := res.LastInsertId()
	if err != nil {
		return err
	}
	_, err = c.exec(ctx, `INSERT INTO search_map (entity_id, rid) VALUES (?, ?)`, d.EntityID, rid)
	return err
}

func nz(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (c conn) Unindex(ctx context.Context, entityID string) error {
	if !looksUUID(entityID) {
		return nil
	}
	if c.d.Name == "postgres" {
		_, err := c.exec(ctx, `DELETE FROM search_index WHERE entity_id = ?`, entityID)
		return err
	}
	var rid int64
	if err := c.row(ctx, `SELECT rid FROM search_map WHERE entity_id = ?`, entityID).Scan(&rid); err != nil {
		return nil // not indexed
	}
	if _, err := c.exec(ctx, `DELETE FROM search_index WHERE rowid = ?`, rid); err != nil {
		return err
	}
	_, err := c.exec(ctx, `DELETE FROM search_map WHERE entity_id = ?`, entityID)
	return err
}

func (c conn) Search(ctx context.Context, sq store.SearchQuery) ([]store.SearchHit, error) {
	terms := searchTerms(sq.Text)
	if len(terms) == 0 || c.ws == "" {
		return nil, nil
	}
	limit := sq.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	w := &clause{}
	var query string
	if c.d.Name == "postgres" {
		for i := range terms {
			terms[i] += ":*"
		}
		tsq := strings.Join(terms, " & ")
		w.add(`tsv @@ to_tsquery('simple', ?)`, tsq)
		w.add(`workspace_id = ?`, c.ws)
		query = `SELECT kind, entity_id, scope_type, scope_id, COALESCE(CAST(project_id AS TEXT), ''), title,
			ts_headline('simple', body, to_tsquery('simple', ?), 'MaxWords=18, MinWords=6, StartSel=**, StopSel=**')
			FROM search_index WHERE `
		w.args = append([]any{tsq}, w.args...)
	} else {
		for i := range terms {
			terms[i] = `"` + terms[i] + `"*`
		}
		w.add(`search_index MATCH ?`, strings.Join(terms, " "))
		w.add(`workspace_id = ?`, c.ws)
		query = `SELECT kind, entity_id, scope_type, scope_id, COALESCE(project_id, ''), title,
			snippet(search_index, 1, '**', '**', '…', 18) FROM search_index WHERE `
	}
	if len(sq.Kinds) > 0 {
		w.in(`kind`, sq.Kinds, false)
	}
	if len(sq.ProjectIDs) > 0 {
		w.in(`project_id`, sq.ProjectIDs, true)
	}
	if c.d.Name == "postgres" {
		w.add(`(audience_id IS NULL OR audience_id = ?)`, idOrNone(sq.Viewer))
		query += w.sql() + ` ORDER BY ts_rank(tsv, to_tsquery('simple', ?)) DESC`
		w.args = append(w.args, w.args[0])
	} else {
		w.add(`(audience_id = '' OR audience_id = ?)`, sq.Viewer)
		query += w.sql() + ` ORDER BY rank`
	}
	rows, err := c.query(ctx, query+fmt.Sprintf(" LIMIT %d", limit), w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.SearchHit
	for rows.Next() {
		var h store.SearchHit
		if err := rows.Scan(&h.Kind, &h.EntityID, &h.ScopeType, &h.ScopeID, &h.ProjectID, &h.Title, &h.Snippet); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// ---- backups ----

// Dump calls each with every row of a table as column -> value.
func (s *Store) Dump(ctx context.Context, table string, each func(row map[string]any) error) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	rows, err := s.query(ctx, "SELECT "+m.cols+" FROM "+table)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		el := reflect.New(m.table.Type).Elem()
		if err := rows.Scan(m.dests(el)...); err != nil {
			return err
		}
		row := make(map[string]any, len(m.fields))
		for i := range m.fields {
			f := &m.fields[i]
			v := el.Field(f.idx)
			if v.IsZero() {
				continue
			}
			row[f.col] = v.Interface()
		}
		if err := each(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

// Load inserts rows produced by Dump (after a trip through JSON).
func (s *Store) Load(ctx context.Context, table string, rows []map[string]any) error {
	m, err := metaNamed(table)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(x q) error {
		for _, row := range rows {
			args := make([]any, len(m.fields))
			for i := range m.fields {
				f := &m.fields[i]
				val, ok := row[f.col]
				if !ok || val == nil {
					// Absent = the zero value, which a NOT NULL column needs.
					val = reflect.Zero(m.table.Type.Field(f.idx).Type).Interface()
				}
				var a any
				if f.json {
					// The value went through JSON, so write it back as JSON.
					if b, err := json.Marshal(val); err == nil && string(b) != "null" && !reflect.ValueOf(val).IsZero() {
						a = string(b)
					}
				} else if a, err = toDB(f, reflect.ValueOf(val)); err != nil {
					return fmt.Errorf("%s.%s: %w", table, f.col, err)
				}
				if a == nil && !f.null && !f.json {
					a = reflect.Zero(m.table.Type.Field(f.idx).Type).Interface()
				}
				args[i] = a
			}
			if _, err := x.exec(ctx, "INSERT INTO "+table+" ("+m.cols+") VALUES ("+placeholders(len(args))+")", args...); err != nil {
				return fmt.Errorf("%s: %w", table, err)
			}
		}
		return nil
	})
}
