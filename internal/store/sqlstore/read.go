package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// Optional values: "" and 0 are stored as NULL.

func ns(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func ni(i int64) any {
	if i == 0 {
		return nil
	}
	return i
}

// nstr and nint scan a nullable column into a plain Go value.
type nstr struct{ p *string }

func (n nstr) Scan(v any) error {
	var s sql.NullString
	if err := s.Scan(v); err != nil {
		return err
	}
	*n.p = s.String
	return nil
}

type nint struct{ p *int64 }

func (n nint) Scan(v any) error {
	var i sql.NullInt64
	if err := i.Scan(v); err != nil {
		return err
	}
	*n.p = i.Int64
	return nil
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return store.ErrNotFound
	}
	return err
}

// conflict maps a broken unique rule to store.ErrConflict on either database.
func conflict(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") || strings.Contains(msg, "SQLSTATE 23505") {
		return fmt.Errorf("%w: %v", store.ErrConflict, err)
	}
	return err
}

// marks returns "?, ?, ?" for n values, and the values as arguments.
func marks(vals []string) (string, []any) {
	args := make([]any, len(vals))
	for i, v := range vals {
		args[i] = v
	}
	return strings.TrimSuffix(strings.Repeat("?, ", len(vals)), ", "), args
}

// ---- users and workspaces ----

const userCols = `id, kind, name, email, workspace_id, responsible_id, created_by, created_at, disabled_at`

func scanUser(row interface{ Scan(...any) error }) (core.User, error) {
	var u core.User
	err := row.Scan(&u.ID, &u.Kind, &u.Name, nstr{&u.Email}, nstr{&u.WorkspaceID}, nstr{&u.ResponsibleID},
		nstr{&u.CreatedBy}, &u.CreatedAt, nint{&u.DisabledAt})
	return u, notFound(err)
}

func (x q) insertUser(ctx context.Context, u core.User) error {
	_, err := x.exec(ctx, `INSERT INTO users (id, kind, name, email, workspace_id, responsible_id, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Kind, u.Name, ns(u.Email), ns(u.WorkspaceID), ns(u.ResponsibleID), ns(u.CreatedBy), u.CreatedAt, u.CreatedAt)
	return conflict(err)
}

func (s *Store) CreateUser(ctx context.Context, u core.User) error {
	return s.read().insertUser(ctx, u)
}

func (s *Store) User(ctx context.Context, id string) (core.User, error) {
	return scanUser(s.read().row(ctx, `SELECT `+userCols+` FROM users WHERE id = ? AND deleted_at IS NULL`, id))
}

func (s *Store) UserByEmail(ctx context.Context, email string) (core.User, error) {
	return scanUser(s.read().row(ctx, `SELECT `+userCols+` FROM users WHERE email = ? AND deleted_at IS NULL`, email))
}

func (s *Store) CreateWorkspace(ctx context.Context, w core.Workspace, owner core.Member) error {
	return s.inTx(ctx, func(x q) error {
		if _, err := x.exec(ctx, `INSERT INTO workspaces (id, slug, name, seq, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`,
			w.ID, w.Slug, w.Name, w.CreatedAt, w.CreatedAt); err != nil {
			return conflict(err)
		}
		return x.insertMember(ctx, owner, 0)
	})
}

const workspaceCols = `id, slug, name, seq, created_at`

func scanWorkspace(row *sql.Row) (core.Workspace, error) {
	var w core.Workspace
	return w, notFound(row.Scan(&w.ID, &w.Slug, &w.Name, &w.Seq, &w.CreatedAt))
}

func (s *Store) Workspace(ctx context.Context, id string) (core.Workspace, error) {
	return scanWorkspace(s.read().row(ctx, `SELECT `+workspaceCols+` FROM workspaces WHERE id = ? AND deleted_at IS NULL`, id))
}

func (s *Store) WorkspaceBySlug(ctx context.Context, slug string) (core.Workspace, error) {
	return scanWorkspace(s.read().row(ctx, `SELECT `+workspaceCols+` FROM workspaces WHERE slug = ? AND deleted_at IS NULL`, slug))
}

// ---- members ----

const memberSelect = `SELECT m.workspace_id, m.user_id, m.role, m.handle, u.kind, u.name, m.created_at
	FROM members m JOIN users u ON u.id = m.user_id
	WHERE m.removed_at IS NULL AND u.deleted_at IS NULL AND m.workspace_id = ?`

func scanMember(row interface{ Scan(...any) error }) (core.Member, error) {
	var m core.Member
	return m, notFound(row.Scan(&m.WorkspaceID, &m.UserID, &m.Role, &m.Handle, &m.Kind, &m.Name, &m.CreatedAt))
}

func (x q) insertMember(ctx context.Context, m core.Member, seq int64) error {
	_, err := x.exec(ctx, `INSERT INTO members (workspace_id, user_id, role, handle, created_at, updated_seq) VALUES (?, ?, ?, ?, ?, ?)`,
		m.WorkspaceID, m.UserID, string(m.Role), m.Handle, m.CreatedAt, seq)
	return conflict(err)
}

func (x q) Member(ctx context.Context, workspaceID, userID string) (core.Member, error) {
	return scanMember(x.row(ctx, memberSelect+` AND m.user_id = ?`, workspaceID, userID))
}

func (s *Store) Member(ctx context.Context, workspaceID, userID string) (core.Member, error) {
	return s.read().Member(ctx, workspaceID, userID)
}

func (s *Store) Members(ctx context.Context, workspaceID string) ([]core.Member, error) {
	rows, err := s.read().query(ctx, memberSelect+` ORDER BY m.handle`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Member
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ---- projects, statuses, labels ----

const projectCols = `id, workspace_id, key, name, description, created_by, created_at, updated_seq`

func scanProject(row interface{ Scan(...any) error }) (core.Project, error) {
	var p core.Project
	return p, notFound(row.Scan(&p.ID, &p.WorkspaceID, &p.Key, &p.Name, &p.Description, &p.CreatedBy, &p.CreatedAt, &p.UpdatedSeq))
}

func (x q) Project(ctx context.Context, workspaceID, id string) (core.Project, error) {
	return scanProject(x.row(ctx, `SELECT `+projectCols+` FROM projects WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceID, id))
}

func (x q) ProjectByKey(ctx context.Context, workspaceID, key string) (core.Project, error) {
	return scanProject(x.row(ctx, `SELECT `+projectCols+` FROM projects WHERE workspace_id = ? AND key = ? AND deleted_at IS NULL`, workspaceID, key))
}

func (s *Store) Project(ctx context.Context, workspaceID, id string) (core.Project, error) {
	return s.read().Project(ctx, workspaceID, id)
}

func (s *Store) ProjectByKey(ctx context.Context, workspaceID, key string) (core.Project, error) {
	return s.read().ProjectByKey(ctx, workspaceID, key)
}

func (s *Store) Projects(ctx context.Context, workspaceID string) ([]core.Project, error) {
	rows, err := s.read().query(ctx, `SELECT `+projectCols+` FROM projects WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY key`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

const statusCols = `id, project_id, name, color, category, rank, is_default`

func scanStatus(row interface{ Scan(...any) error }) (core.Status, error) {
	var st core.Status
	return st, notFound(row.Scan(&st.ID, &st.ProjectID, &st.Name, &st.Color, &st.Category, &st.Rank, &st.IsDefault))
}

func (x q) Status(ctx context.Context, workspaceID, id string) (core.Status, error) {
	return scanStatus(x.row(ctx, `SELECT `+statusCols+` FROM statuses WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceID, id))
}

func (s *Store) Status(ctx context.Context, workspaceID, id string) (core.Status, error) {
	return s.read().Status(ctx, workspaceID, id)
}

func (s *Store) Statuses(ctx context.Context, workspaceID, projectID string) ([]core.Status, error) {
	rows, err := s.read().query(ctx, `SELECT `+statusCols+` FROM statuses
		WHERE workspace_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY rank`, workspaceID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Status
	for rows.Next() {
		st, err := scanStatus(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

func scanLabel(row interface{ Scan(...any) error }) (core.Label, error) {
	var l core.Label
	return l, notFound(row.Scan(&l.ID, nstr{&l.ProjectID}, &l.Name, &l.Color))
}

func (x q) Label(ctx context.Context, workspaceID, id string) (core.Label, error) {
	return scanLabel(x.row(ctx, `SELECT id, project_id, name, color FROM labels WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceID, id))
}

func (s *Store) Label(ctx context.Context, workspaceID, id string) (core.Label, error) {
	return s.read().Label(ctx, workspaceID, id)
}

func (s *Store) Labels(ctx context.Context, workspaceID string) ([]core.Label, error) {
	rows, err := s.read().query(ctx, `SELECT id, project_id, name, color FROM labels WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY name`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Label
	for rows.Next() {
		l, err := scanLabel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ---- tasks ----

const taskSelect = `SELECT t.id, t.workspace_id, t.project_id, t.number, p.key, t.title, t.description, t.status_id,
	t.priority, t.assignee_id, t.waiting_on_id, t.waiting_on_note, t.parent_id, t.rank, t.due_on, t.created_by,
	t.created_at, t.updated_at, t.started_at, t.completed_at, t.canceled_at, t.created_seq, t.updated_seq,
	t.activity_seq, t.deleted_at
	FROM tasks t JOIN projects p ON p.id = t.project_id`

func scanTask(row interface{ Scan(...any) error }) (core.Task, error) {
	var t core.Task
	var key string
	err := row.Scan(&t.ID, &t.WorkspaceID, &t.ProjectID, &t.Number, &key, &t.Title, &t.Description, &t.StatusID,
		&t.Priority, nstr{&t.AssigneeID}, nstr{&t.WaitingOnID}, &t.WaitingOnNote, nstr{&t.ParentID}, &t.Rank,
		nstr{&t.DueOn}, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, nint{&t.StartedAt}, nint{&t.CompletedAt},
		nint{&t.CanceledAt}, &t.CreatedSeq, &t.UpdatedSeq, &t.ActivitySeq, nint{&t.DeletedAt})
	t.Key = fmt.Sprintf("%s-%d", key, t.Number)
	return t, notFound(err)
}

// loadLabels fills LabelIDs for the given tasks.
func (x q) loadLabels(ctx context.Context, tasks []core.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	byID := make(map[string]*core.Task, len(tasks))
	ids := make([]string, len(tasks))
	for i := range tasks {
		byID[tasks[i].ID] = &tasks[i]
		ids[i] = tasks[i].ID
	}
	const chunk = 500 // stays well under every database's parameter limit
	for len(ids) > 0 {
		n := min(chunk, len(ids))
		in, args := marks(ids[:n])
		ids = ids[n:]
		rows, err := x.query(ctx, `SELECT task_id, label_id FROM task_labels WHERE task_id IN (`+in+`) ORDER BY label_id`, args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var taskID, labelID string
			if err := rows.Scan(&taskID, &labelID); err != nil {
				rows.Close()
				return err
			}
			byID[taskID].LabelIDs = append(byID[taskID].LabelIDs, labelID)
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

func (x q) oneTask(ctx context.Context, where string, args ...any) (core.Task, error) {
	t, err := scanTask(x.row(ctx, taskSelect+` WHERE `+where, args...))
	if err != nil {
		return t, err
	}
	one := []core.Task{t}
	if err := x.loadLabels(ctx, one); err != nil {
		return t, err
	}
	return one[0], nil
}

func (x q) Task(ctx context.Context, workspaceID, id string) (core.Task, error) {
	return x.oneTask(ctx, `t.workspace_id = ? AND t.id = ?`, workspaceID, id)
}

func (x q) TaskByNumber(ctx context.Context, workspaceID, projectID string, number int) (core.Task, error) {
	return x.oneTask(ctx, `t.workspace_id = ? AND t.project_id = ? AND t.number = ?`, workspaceID, projectID, number)
}

func (s *Store) Task(ctx context.Context, workspaceID, id string) (core.Task, error) {
	return s.read().Task(ctx, workspaceID, id)
}

func (s *Store) TaskByNumber(ctx context.Context, workspaceID, projectID string, number int) (core.Task, error) {
	return s.read().TaskByNumber(ctx, workspaceID, projectID, number)
}

func (s *Store) Tasks(ctx context.Context, workspaceID string, f store.TaskFilter) ([]core.Task, error) {
	where := []string{`t.workspace_id = ?`}
	args := []any{workspaceID}
	add := func(cond string, a ...any) {
		where = append(where, cond)
		args = append(args, a...)
	}
	if f.InTrash {
		add(`t.deleted_at IS NOT NULL`)
	} else {
		add(`t.deleted_at IS NULL`)
	}
	if f.ProjectID != "" {
		add(`t.project_id = ?`, f.ProjectID)
	}
	if f.Unassigned {
		add(`t.assignee_id IS NULL`)
	} else if len(f.AssigneeIDs) > 0 {
		in, a := marks(f.AssigneeIDs)
		add(`t.assignee_id IN (`+in+`)`, a...)
	}
	if f.WaitingOnID != "" {
		add(`t.waiting_on_id = ?`, f.WaitingOnID)
	}
	if len(f.StatusIDs) > 0 {
		in, a := marks(f.StatusIDs)
		add(`t.status_id IN (`+in+`)`, a...)
	}
	if len(f.Categories) > 0 {
		in, a := marks(f.Categories)
		add(`t.status_id IN (SELECT id FROM statuses WHERE workspace_id = t.workspace_id AND category IN (`+in+`))`, a...)
	}
	if f.LabelID != "" {
		add(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)`, f.LabelID)
	}
	if f.ParentID != "" {
		add(`t.parent_id = ?`, f.ParentID)
	}
	if f.ActivityAfter > 0 {
		add(`t.activity_seq > ?`, f.ActivityAfter)
	}
	if f.OpenDecision {
		add(`EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.id AND d.state = 'open' AND d.deleted_at IS NULL)`)
	}
	if f.AfterID != "" {
		add(`t.id > ?`, f.AfterID)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	// Ids are time-ordered, so "ORDER BY id" is creation order and a stable
	// page cursor.
	rows, err := s.read().query(ctx, taskSelect+` WHERE `+strings.Join(where, ` AND `)+` ORDER BY t.id LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return out, s.read().loadLabels(ctx, out)
}

// ---- comments ----

func (s *Store) Comments(ctx context.Context, workspaceID, taskID string) ([]core.Comment, error) {
	rows, err := s.read().query(ctx, `SELECT id, task_id, subject_type, subject_id, parent_id, author_id, body, created_at, created_seq
		FROM comments WHERE workspace_id = ? AND task_id = ? AND deleted_at IS NULL ORDER BY created_seq`, workspaceID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Comment
	for rows.Next() {
		var c core.Comment
		if err := rows.Scan(&c.ID, &c.TaskID, &c.SubjectType, &c.SubjectID, nstr{&c.ParentID}, &c.AuthorID, &c.Body, &c.CreatedAt, &c.CreatedSeq); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ---- decisions ----

const decisionCols = `id, task_id, kind, question, state, recommended_option_id, recommendation, picked_option_id,
	outcome, outcome_note, decided_by, decided_at, rank, created_by, created_at, updated_seq`

func scanDecision(row interface{ Scan(...any) error }) (core.Decision, error) {
	var d core.Decision
	err := row.Scan(&d.ID, &d.TaskID, &d.Kind, &d.Question, &d.State, nstr{&d.RecommendedOptionID}, &d.Recommendation,
		nstr{&d.PickedOptionID}, nstr{&d.Outcome}, &d.OutcomeNote, nstr{&d.DecidedBy}, nint{&d.DecidedAt}, &d.Rank,
		&d.CreatedBy, &d.CreatedAt, &d.UpdatedSeq)
	return d, notFound(err)
}

func (x q) options(ctx context.Context, decisionID string) ([]core.Option, error) {
	rows, err := x.query(ctx, `SELECT id, decision_id, label, description, rank FROM decision_options
		WHERE decision_id = ? AND deleted_at IS NULL ORDER BY rank`, decisionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Option
	for rows.Next() {
		var o core.Option
		if err := rows.Scan(&o.ID, &o.DecisionID, &o.Label, &o.Description, &o.Rank); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (x q) Decision(ctx context.Context, workspaceID, id string) (core.Decision, error) {
	d, err := scanDecision(x.row(ctx, `SELECT `+decisionCols+` FROM decisions WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceID, id))
	if err != nil {
		return d, err
	}
	d.Options, err = x.options(ctx, d.ID)
	return d, err
}

func (s *Store) Decision(ctx context.Context, workspaceID, id string) (core.Decision, error) {
	return s.read().Decision(ctx, workspaceID, id)
}

func (s *Store) Decisions(ctx context.Context, workspaceID, taskID string) ([]core.Decision, error) {
	x := s.read()
	rows, err := x.query(ctx, `SELECT `+decisionCols+` FROM decisions WHERE workspace_id = ? AND task_id = ? AND deleted_at IS NULL ORDER BY rank`, workspaceID, taskID)
	if err != nil {
		return nil, err
	}
	var out []core.Decision
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Options, err = x.options(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ---- events and cursors ----

func (s *Store) Events(ctx context.Context, workspaceID string, f store.EventFilter) ([]core.Event, error) {
	where := []string{`workspace_id = ?`, `seq > ?`}
	args := []any{workspaceID, f.After}
	if f.ScopeID != "" {
		where = append(where, `scope_type = ?`, `scope_id = ?`)
		args = append(args, f.ScopeType, f.ScopeID)
	}
	if f.ProjectID != "" {
		where = append(where, `project_id = ?`)
		args = append(args, f.ProjectID)
	}
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.read().query(ctx, `SELECT seq, at, actor_id, change_id, type, entity_type, entity_id, scope_type, scope_id, project_id, data
		FROM events WHERE `+strings.Join(where, ` AND `)+` ORDER BY seq LIMIT ?`, append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []core.Event
	for rows.Next() {
		ev := core.Event{WorkspaceID: workspaceID}
		var data []byte
		if err := rows.Scan(&ev.Seq, &ev.At, &ev.ActorID, &ev.ChangeID, &ev.Type, &ev.EntityType, &ev.EntityID,
			&ev.ScopeType, &ev.ScopeID, nstr{&ev.ProjectID}, &data); err != nil {
			return nil, err
		}
		ev.Data = data
		out = append(out, ev)
	}
	return out, rows.Err()
}

func (s *Store) Cursor(ctx context.Context, workspaceID, userID, name string) (int64, error) {
	var seq int64
	err := s.read().row(ctx, `SELECT seq FROM cursors WHERE workspace_id = ? AND user_id = ? AND name = ?`, workspaceID, userID, name).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return seq, err
}

func (s *Store) SetCursor(ctx context.Context, workspaceID, userID, name string, seq int64) error {
	_, err := s.read().exec(ctx, `INSERT INTO cursors (workspace_id, user_id, name, seq, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (workspace_id, user_id, name) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
		WHERE excluded.seq > cursors.seq`, workspaceID, userID, name, seq, nowMS())
	return err
}
