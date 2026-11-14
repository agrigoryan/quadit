// Package store defines the data layer in the product's own terms. The rest
// of the code talks to these interfaces and never to SQL; each database is an
// implementation that must pass the shared suite in storetest.
package store

import (
	"context"
	"errors"

	"github.com/agrigoryan/quadit/internal/core"
)

// ErrNotFound is returned when the row asked for does not exist, or is not
// in the workspace it was asked for in.
var ErrNotFound = errors.New("not found")

// ErrConflict is returned when a unique rule would be broken, for example a
// second project with the same key.
var ErrConflict = errors.New("conflict")

// Store is one database.
type Store interface {
	Dialect() string
	Close() error

	// Outside any workspace.
	CreateUser(ctx context.Context, u core.User) error
	User(ctx context.Context, id string) (core.User, error)
	UserByEmail(ctx context.Context, email string) (core.User, error)
	CreateWorkspace(ctx context.Context, w core.Workspace, owner core.Member) error
	Workspace(ctx context.Context, id string) (core.Workspace, error)
	WorkspaceBySlug(ctx context.Context, slug string) (core.Workspace, error)

	// Write runs fn in one transaction. Writes to the same workspace run one
	// at a time on every database, so "read, check, then write" inside fn is
	// safe, and events get their numbers in the order they commit.
	Write(ctx context.Context, workspaceID string, fn func(Tx) error) error

	Reader

	// Events returns events with seq greater than f.After, oldest first.
	Events(ctx context.Context, workspaceID string, f EventFilter) ([]core.Event, error)
	Tasks(ctx context.Context, workspaceID string, f TaskFilter) ([]core.Task, error)
	Comments(ctx context.Context, workspaceID, taskID string) ([]core.Comment, error)
	Decisions(ctx context.Context, workspaceID, taskID string) ([]core.Decision, error)
	Members(ctx context.Context, workspaceID string) ([]core.Member, error)
	Projects(ctx context.Context, workspaceID string) ([]core.Project, error)
	Statuses(ctx context.Context, workspaceID, projectID string) ([]core.Status, error)
	Labels(ctx context.Context, workspaceID string) ([]core.Label, error)

	// Cursor returns a member's saved place in the feed, 0 if none.
	Cursor(ctx context.Context, workspaceID, userID, name string) (int64, error)
	// SetCursor saves it. A cursor never moves backwards.
	SetCursor(ctx context.Context, workspaceID, userID, name string, seq int64) error
}

// Reader is the single-row lookups shared by Store and Tx. Each is scoped to
// a workspace: a row in another workspace is ErrNotFound.
type Reader interface {
	Member(ctx context.Context, workspaceID, userID string) (core.Member, error)
	Project(ctx context.Context, workspaceID, id string) (core.Project, error)
	ProjectByKey(ctx context.Context, workspaceID, key string) (core.Project, error)
	Status(ctx context.Context, workspaceID, id string) (core.Status, error)
	Label(ctx context.Context, workspaceID, id string) (core.Label, error)
	Task(ctx context.Context, workspaceID, id string) (core.Task, error)
	TaskByNumber(ctx context.Context, workspaceID, projectID string, number int) (core.Task, error)
	Decision(ctx context.Context, workspaceID, id string) (core.Decision, error)
}

// Tx is what a write may do. It also reads, seeing its own writes.
type Tx interface {
	Reader

	// Seq is the last number handed out in the workspace's event sequence.
	Seq() int64
	// NextSeq hands out the next one.
	NextSeq() int64
	// Emit stores an event. Its Seq must come from NextSeq in this Tx.
	Emit(ctx context.Context, ev core.Event) error

	// Change returns a change already applied under this id, if any.
	Change(ctx context.Context, id string) (AppliedChange, bool, error)
	SaveChange(ctx context.Context, c AppliedChange) error

	// User loads any user; users live outside workspaces.
	User(ctx context.Context, id string) (core.User, error)
	InsertUser(ctx context.Context, u core.User) error
	InsertMember(ctx context.Context, m core.Member, seq int64) error

	InsertProject(ctx context.Context, p core.Project, seq int64) error
	// NextTaskNumber hands out the project's next task number. Numbers are
	// never reused, even after a task is deleted.
	NextTaskNumber(ctx context.Context, projectID string) (int, error)
	InsertStatus(ctx context.Context, workspaceID string, s core.Status, seq int64) error
	DefaultStatus(ctx context.Context, workspaceID, projectID string) (core.Status, error)
	InsertLabel(ctx context.Context, workspaceID string, l core.Label, seq int64) error

	InsertTask(ctx context.Context, t core.Task) error
	// UpdateTask writes the fields set in p and moves updated_seq and
	// activity_seq to seq.
	UpdateTask(ctx context.Context, workspaceID, id string, p TaskPatch, seq int64, at int64) error
	AddTaskLabel(ctx context.Context, workspaceID, taskID, labelID string) error
	RemoveTaskLabel(ctx context.Context, workspaceID, taskID, labelID string) error
	// TouchTask moves only activity_seq: something happened in the task (a
	// comment, a decision) without its own fields changing.
	TouchTask(ctx context.Context, workspaceID, id string, seq int64) error

	InsertComment(ctx context.Context, workspaceID string, c core.Comment) error

	// CountDecisions counts every decision ever opened on a task.
	CountDecisions(ctx context.Context, workspaceID, taskID string) (int, error)
	// DecisionOfOption returns the id of the decision an option belongs to.
	DecisionOfOption(ctx context.Context, workspaceID, optionID string) (string, error)
	InsertDecision(ctx context.Context, workspaceID string, d core.Decision, seq int64) error
	InsertOption(ctx context.Context, workspaceID string, o core.Option, at int64) error
	UpdateDecision(ctx context.Context, workspaceID, id string, p DecisionPatch, seq int64, at int64) error
}

// AppliedChange records that a change id was used, and what it produced.
type AppliedChange struct {
	ID       string
	ActorID  string
	Type     string
	ArgsHash string
	FirstSeq int64
	LastSeq  int64
	At       int64
}

// TaskPatch names the task fields to write. A nil field is left alone; a
// pointer to "" clears an optional reference.
type TaskPatch struct {
	Title         *string
	Description   *string
	StatusID      *string
	Priority      *int
	AssigneeID    *string
	WaitingOnID   *string
	WaitingOnNote *string
	ParentID      *string
	Rank          *string
	DueOn         *string
	StartedAt     *int64
	CompletedAt   *int64
	CanceledAt    *int64
	DeletedAt     *int64
	DeletedBy     *string
}

// DecisionPatch names the decision fields to write.
type DecisionPatch struct {
	State          *string
	PickedOptionID *string
	Outcome        *string
	OutcomeNote    *string
	DecidedBy      *string
	DecidedAt      *int64
}

// TaskFilter selects tasks. Conditions combine with AND; inside a list, OR.
type TaskFilter struct {
	ProjectID     string
	AssigneeIDs   []string // any of these
	Unassigned    bool     // only tasks with no assignee
	WaitingOnID   string
	StatusIDs     []string
	Categories    []string // status categories, e.g. started, waiting
	LabelID       string
	ParentID      string
	ActivityAfter int64 // only tasks where something happened after this seq
	OpenDecision  bool  // only tasks with an open decision
	InTrash       bool  // only deleted tasks; default is only live ones
	AfterID       string
	Limit         int
}

// EventFilter selects events from the feed.
type EventFilter struct {
	After     int64  // seq to start after
	ScopeType string // with ScopeID: one object's timeline
	ScopeID   string
	ProjectID string
	Limit     int
}
