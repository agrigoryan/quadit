package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func nowMS() int64 { return time.Now().UnixMilli() }

// tx is one write to one workspace.
type tx struct {
	q
	ws  string
	seq int64 // last number handed out
}

var _ store.Store = (*Store)(nil)
var _ store.Tx = (*tx)(nil)

// Write runs fn in a transaction that holds the workspace's row lock from
// its first statement. On Postgres that lock is what makes writers to one
// workspace queue; on SQLite the write transaction already does. Either way
// event numbers are handed out in commit order, so a reader that has seen
// number N has seen everything before it.
func (s *Store) Write(ctx context.Context, workspaceID string, fn func(store.Tx) error) error {
	return s.inTx(ctx, func(x q) error {
		var seq int64
		err := x.row(ctx, `UPDATE workspaces SET seq = seq WHERE id = ? AND deleted_at IS NULL RETURNING seq`, workspaceID).Scan(&seq)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("workspace %s: %w", workspaceID, store.ErrNotFound)
		}
		if err != nil {
			return err
		}
		t := &tx{q: x, ws: workspaceID, seq: seq}
		if err := fn(t); err != nil {
			return err
		}
		if t.seq == seq {
			return nil
		}
		_, err = x.exec(ctx, `UPDATE workspaces SET seq = ?, updated_at = ? WHERE id = ?`, t.seq, nowMS(), workspaceID)
		return err
	})
}

func (t *tx) Seq() int64 { return t.seq }

func (t *tx) NextSeq() int64 {
	t.seq++
	return t.seq
}

func (t *tx) Emit(ctx context.Context, ev core.Event) error {
	if ev.Seq <= 0 || ev.Seq > t.seq {
		return fmt.Errorf("emit %s: seq %d was not handed out by this write", ev.Type, ev.Seq)
	}
	_, err := t.exec(ctx, `INSERT INTO events (workspace_id, seq, at, actor_id, change_id, type, entity_type, entity_id, scope_type, scope_id, project_id, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ws, ev.Seq, ev.At, ev.ActorID, ev.ChangeID, ev.Type, ev.EntityType, ev.EntityID, ev.ScopeType, ev.ScopeID,
		ns(ev.ProjectID), string(ev.Data))
	return err
}

func (t *tx) Change(ctx context.Context, id string) (store.AppliedChange, bool, error) {
	c := store.AppliedChange{ID: id}
	err := t.row(ctx, `SELECT actor_id, type, args_hash, first_seq, last_seq, created_at FROM changes WHERE workspace_id = ? AND id = ?`, t.ws, id).
		Scan(&c.ActorID, &c.Type, &c.ArgsHash, &c.FirstSeq, &c.LastSeq, &c.At)
	if errors.Is(err, sql.ErrNoRows) {
		return c, false, nil
	}
	return c, err == nil, err
}

func (t *tx) SaveChange(ctx context.Context, c store.AppliedChange) error {
	_, err := t.exec(ctx, `INSERT INTO changes (workspace_id, id, actor_id, type, args_hash, first_seq, last_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ws, c.ID, c.ActorID, c.Type, c.ArgsHash, c.FirstSeq, c.LastSeq, c.At)
	return conflict(err)
}

func (t *tx) InsertUser(ctx context.Context, u core.User) error { return t.insertUser(ctx, u) }

func (t *tx) User(ctx context.Context, id string) (core.User, error) {
	return scanUser(t.row(ctx, `SELECT `+userCols+` FROM users WHERE id = ? AND deleted_at IS NULL`, id))
}

func (t *tx) CountDecisions(ctx context.Context, workspaceID, taskID string) (int, error) {
	var n int
	err := t.row(ctx, `SELECT COUNT(*) FROM decisions WHERE workspace_id = ? AND task_id = ?`, workspaceID, taskID).Scan(&n)
	return n, err
}

func (t *tx) DecisionOfOption(ctx context.Context, workspaceID, optionID string) (string, error) {
	var id string
	err := t.row(ctx, `SELECT decision_id FROM decision_options WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`, workspaceID, optionID).Scan(&id)
	return id, notFound(err)
}

func (t *tx) InsertMember(ctx context.Context, m core.Member, seq int64) error {
	return t.insertMember(ctx, m, seq)
}

func (t *tx) InsertProject(ctx context.Context, p core.Project, seq int64) error {
	_, err := t.exec(ctx, `INSERT INTO projects (id, workspace_id, key, name, description, created_by, created_at, updated_at, created_seq, updated_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, t.ws, p.Key, p.Name, p.Description, p.CreatedBy, p.CreatedAt, p.CreatedAt, seq, seq)
	return conflict(err)
}

func (t *tx) NextTaskNumber(ctx context.Context, projectID string) (int, error) {
	var n int
	err := t.row(ctx, `UPDATE projects SET task_counter = task_counter + 1 WHERE workspace_id = ? AND id = ? RETURNING task_counter`, t.ws, projectID).Scan(&n)
	return n, notFound(err)
}

func (t *tx) InsertStatus(ctx context.Context, workspaceID string, s core.Status, seq int64) error {
	_, err := t.exec(ctx, `INSERT INTO statuses (id, workspace_id, project_id, name, color, category, rank, is_default, created_at, updated_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		s.ID, workspaceID, s.ProjectID, s.Name, s.Color, s.Category, s.Rank, s.IsDefault, nowMS(), seq)
	return conflict(err)
}

func (t *tx) DefaultStatus(ctx context.Context, workspaceID, projectID string) (core.Status, error) {
	return scanStatus(t.row(ctx, `SELECT `+statusCols+` FROM statuses
		WHERE workspace_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, rank LIMIT 1`, workspaceID, projectID))
}

func (t *tx) InsertLabel(ctx context.Context, workspaceID string, l core.Label, seq int64) error {
	_, err := t.exec(ctx, `INSERT INTO labels (id, workspace_id, project_id, name, color, created_at, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		l.ID, workspaceID, ns(l.ProjectID), l.Name, l.Color, nowMS(), seq)
	return conflict(err)
}

func (t *tx) InsertTask(ctx context.Context, k core.Task) error {
	_, err := t.exec(ctx, `INSERT INTO tasks (id, workspace_id, project_id, number, title, description, status_id, priority,
		assignee_id, waiting_on_id, waiting_on_note, parent_id, rank, due_on, created_by, created_at, updated_at,
		started_at, completed_at, canceled_at, created_seq, updated_seq, activity_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		k.ID, t.ws, k.ProjectID, k.Number, k.Title, k.Description, k.StatusID, k.Priority,
		ns(k.AssigneeID), ns(k.WaitingOnID), k.WaitingOnNote, ns(k.ParentID), k.Rank, ns(k.DueOn), k.CreatedBy,
		k.CreatedAt, k.UpdatedAt, ni(k.StartedAt), ni(k.CompletedAt), ni(k.CanceledAt), k.CreatedSeq, k.UpdatedSeq, k.ActivitySeq)
	if err != nil {
		return conflict(err)
	}
	for _, labelID := range k.LabelIDs {
		if err := t.AddTaskLabel(ctx, t.ws, k.ID, labelID); err != nil {
			return err
		}
	}
	return nil
}

// setter collects "column = ?" pairs for an UPDATE.
type setter struct {
	cols []string
	args []any
}

func (s *setter) str(col string, p *string, optional bool) {
	if p == nil {
		return
	}
	s.cols = append(s.cols, col+` = ?`)
	if optional {
		s.args = append(s.args, ns(*p))
	} else {
		s.args = append(s.args, *p)
	}
}

func (s *setter) ts(col string, p *int64) {
	if p != nil {
		s.cols = append(s.cols, col+` = ?`)
		s.args = append(s.args, ni(*p))
	}
}

func (t *tx) UpdateTask(ctx context.Context, workspaceID, id string, p store.TaskPatch, seq, at int64) error {
	var s setter
	s.str("title", p.Title, false)
	s.str("description", p.Description, false)
	s.str("status_id", p.StatusID, false)
	if p.Priority != nil {
		s.cols = append(s.cols, `priority = ?`)
		s.args = append(s.args, *p.Priority)
	}
	s.str("assignee_id", p.AssigneeID, true)
	s.str("waiting_on_id", p.WaitingOnID, true)
	s.str("waiting_on_note", p.WaitingOnNote, false)
	s.str("parent_id", p.ParentID, true)
	s.str("rank", p.Rank, false)
	s.str("due_on", p.DueOn, true)
	s.ts("started_at", p.StartedAt)
	s.ts("completed_at", p.CompletedAt)
	s.ts("canceled_at", p.CanceledAt)
	s.ts("deleted_at", p.DeletedAt)
	s.str("deleted_by", p.DeletedBy, true)
	s.cols = append(s.cols, `updated_at = ?`, `updated_seq = ?`, `activity_seq = ?`)
	s.args = append(s.args, at, seq, seq, workspaceID, id)
	return t.mustChangeOne(ctx, `UPDATE tasks SET `+strings.Join(s.cols, ", ")+` WHERE workspace_id = ? AND id = ?`, s.args...)
}

// mustChangeOne runs an update that has to hit exactly one row.
func (t *tx) mustChangeOne(ctx context.Context, query string, args ...any) error {
	res, err := t.exec(ctx, query, args...)
	if err != nil {
		return conflict(err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return store.ErrNotFound
	}
	return nil
}

func (t *tx) AddTaskLabel(ctx context.Context, workspaceID, taskID, labelID string) error {
	_, err := t.exec(ctx, `INSERT INTO task_labels (task_id, label_id, workspace_id) VALUES (?, ?, ?) ON CONFLICT (task_id, label_id) DO NOTHING`,
		taskID, labelID, workspaceID)
	return err
}

func (t *tx) RemoveTaskLabel(ctx context.Context, workspaceID, taskID, labelID string) error {
	_, err := t.exec(ctx, `DELETE FROM task_labels WHERE workspace_id = ? AND task_id = ? AND label_id = ?`, workspaceID, taskID, labelID)
	return err
}

func (t *tx) TouchTask(ctx context.Context, workspaceID, id string, seq int64) error {
	return t.mustChangeOne(ctx, `UPDATE tasks SET activity_seq = ? WHERE workspace_id = ? AND id = ?`, seq, workspaceID, id)
}

func (t *tx) InsertComment(ctx context.Context, workspaceID string, c core.Comment) error {
	_, err := t.exec(ctx, `INSERT INTO comments (id, workspace_id, task_id, subject_type, subject_id, parent_id, author_id, body, created_at, created_seq, updated_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, workspaceID, c.TaskID, c.SubjectType, c.SubjectID, ns(c.ParentID), c.AuthorID, c.Body, c.CreatedAt, c.CreatedSeq, c.CreatedSeq)
	return conflict(err)
}

func (t *tx) InsertDecision(ctx context.Context, workspaceID string, d core.Decision, seq int64) error {
	_, err := t.exec(ctx, `INSERT INTO decisions (id, workspace_id, task_id, kind, question, state, recommended_option_id, recommendation,
		rank, created_by, created_at, updated_at, created_seq, updated_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, workspaceID, d.TaskID, d.Kind, d.Question, d.State, ns(d.RecommendedOptionID), d.Recommendation,
		d.Rank, d.CreatedBy, d.CreatedAt, d.CreatedAt, seq, seq)
	return conflict(err)
}

func (t *tx) InsertOption(ctx context.Context, workspaceID string, o core.Option, at int64) error {
	_, err := t.exec(ctx, `INSERT INTO decision_options (id, workspace_id, decision_id, label, description, rank, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		o.ID, workspaceID, o.DecisionID, o.Label, o.Description, o.Rank, at)
	return conflict(err)
}

func (t *tx) UpdateDecision(ctx context.Context, workspaceID, id string, p store.DecisionPatch, seq, at int64) error {
	var s setter
	s.str("state", p.State, false)
	s.str("picked_option_id", p.PickedOptionID, true)
	s.str("outcome", p.Outcome, true)
	s.str("outcome_note", p.OutcomeNote, false)
	s.str("decided_by", p.DecidedBy, true)
	s.ts("decided_at", p.DecidedAt)
	s.cols = append(s.cols, `updated_at = ?`, `updated_seq = ?`)
	s.args = append(s.args, at, seq, workspaceID, id)
	return t.mustChangeOne(ctx, `UPDATE decisions SET `+strings.Join(s.cols, ", ")+` WHERE workspace_id = ? AND id = ?`, s.args...)
}
