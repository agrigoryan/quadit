// Package store defines the data layer in the product's own terms. The rest
// of the code talks to these interfaces and never to SQL; each database is an
// implementation that must pass the same tests.
//
// Rows are the structs in package core. A struct's table is registered in
// tables.go; its db tags name the columns.
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

// Cond is one condition on a column. Conditions combine with AND.
type Cond struct {
	Col string
	Op  string // = != > >= < <= in notin null notnull like
	Val any
}

func Eq(col string, v any) Cond            { return Cond{col, "=", v} }
func Ne(col string, v any) Cond            { return Cond{col, "!=", v} }
func Gt(col string, v any) Cond            { return Cond{col, ">", v} }
func Gte(col string, v any) Cond           { return Cond{col, ">=", v} }
func Lt(col string, v any) Cond            { return Cond{col, "<", v} }
func Lte(col string, v any) Cond           { return Cond{col, "<=", v} }
func In(col string, vals []string) Cond    { return Cond{col, "in", vals} }
func NotIn(col string, v []string) Cond    { return Cond{col, "notin", v} }
func Null(col string) Cond                 { return Cond{col, "null", nil} }
func NotNull(col string) Cond              { return Cond{col, "notnull", nil} }
func Like(col string, pattern string) Cond { return Cond{col, "like", pattern} }

// Live selects rows that are not in the trash.
var Live = Null("deleted_at")

// Q selects and orders rows for List.
type Q struct {
	Where []Cond
	// Order is a comma-separated list of columns; a leading "-" sorts
	// descending: "rank", "-created_at,id".
	Order  string
	Limit  int
	Offset int
}

// Where is shorthand for a Q with only conditions.
func Where(c ...Cond) Q { return Q{Where: c} }

// DB reads and writes rows. A DB from Store.In or inside Write is bound to
// one workspace: every query on a workspace table is limited to it, so a row
// in another workspace is ErrNotFound.
type DB interface {
	// Get loads the first row matching where into dst, a pointer to a
	// registered struct.
	Get(ctx context.Context, dst any, where ...Cond) error
	// List loads the matching rows into dst, a pointer to a slice.
	List(ctx context.Context, dst any, q Q) error
	Count(ctx context.Context, table string, where ...Cond) (int, error)
	Insert(ctx context.Context, row any) error
	// Upsert inserts row, or updates every non-key column if a row with the
	// same key columns exists.
	Upsert(ctx context.Context, row any, key ...string) error
	// Update sets columns on the matching rows and returns how many changed.
	Update(ctx context.Context, table string, set map[string]any, where ...Cond) (int64, error)
	Delete(ctx context.Context, table string, where ...Cond) (int64, error)
	// Incr adds n to a counter column on one row and returns the new value.
	Incr(ctx context.Context, table, col string, n int64, where ...Cond) (int64, error)

	Tasks(ctx context.Context, f TaskFilter) ([]core.Task, error)
	CountTasks(ctx context.Context, f TaskFilter) (int, error)
	Events(ctx context.Context, f EventFilter) ([]core.Event, error)

	// Index puts one searchable thing in the full-text index, replacing any
	// earlier entry for the same entity. Unindex removes it.
	Index(ctx context.Context, d SearchDoc) error
	Unindex(ctx context.Context, entityID string) error
	Search(ctx context.Context, q SearchQuery) ([]SearchHit, error)

	// Tally counts rows of a table grouped by the given columns.
	Tally(ctx context.Context, table string, groupBy []string, where ...Cond) ([]TallyRow, error)
}

// Tx is one write to one workspace. It reads its own writes.
type Tx interface {
	DB
	WorkspaceID() string
	// Seq is the last number handed out in the workspace's event sequence.
	Seq() int64
	// NextSeq hands out the next one.
	NextSeq() int64
	// Emit stores an event. Its Seq must come from NextSeq in this Tx.
	Emit(ctx context.Context, ev core.Event) error
}

// Store is one database.
type Store interface {
	// The Store itself is a DB bound to no workspace: it sees every row.
	DB
	Dialect() string
	Close() error
	Ping(ctx context.Context) error

	// In returns a DB bound to one workspace.
	In(workspaceID string) DB

	// Write runs fn in one transaction. Writes to the same workspace run one
	// at a time on every database, so "read, check, then write" inside fn is
	// safe, and events get their numbers in the order they commit.
	Write(ctx context.Context, workspaceID string, fn func(Tx) error) error

	// Atomic runs fn in one transaction outside any workspace's sequence,
	// for sign-in, settings and other install-level writes.
	Atomic(ctx context.Context, fn func(DB) error) error

	// Dump and Load move every row of a table, for backups that work across
	// databases.
	Dump(ctx context.Context, table string, each func(row map[string]any) error) error
	Load(ctx context.Context, table string, rows []map[string]any) error
	// Overwrite sets the matching rows to what an archive row says, leaving
	// the columns named in keep as they are.
	Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...Cond) error
}

// TaskFilter selects tasks. Conditions combine with AND; inside a list, OR.
type TaskFilter struct {
	IDs           []string
	Keys          []string
	ProjectIDs    []string
	AssigneeIDs   []string // any of these
	Unassigned    bool     // only tasks with no assignee
	CreatedBy     string
	WaitingOnID   string
	LeaseHolderID string
	StatusIDs     []string
	Categories    []string // status categories, e.g. started, waiting
	Open          bool     // not done and not canceled
	LabelIDs      []string // has every one of these
	ParentID      string
	TopLevel      bool // no parent
	EpicIDs       []string
	NoEpic        bool
	MilestoneID   string
	CycleIDs      []string
	NoCycle       bool
	Priorities    []int
	DueBefore     string // due on or before this date
	DueAfter      string
	MentionsID    string // tasks that mention this member
	WatchedBy     string
	ActivityAfter int64  // something happened in the task after this seq
	UpdatedAfter  int64  // the task's own fields changed after this seq
	OpenDecision  bool   // has an open decision
	AskedID       string // has an open decision asked of this member
	Text          string // title contains
	InTrash       bool   // only deleted tasks; default is only live ones
	Archived      bool   // include archived tasks
	// Sort is one of: created (default), -created, rank, priority, due,
	// -activity, -updated, key.
	Sort   string
	Limit  int
	Offset int
}

// EventFilter selects events from the feed.
type EventFilter struct {
	After      int64  // seq to start after
	Before     int64  // with Desc: seq to start before
	ScopeType  string // with ScopeID: one object's timeline
	ScopeID    string
	ProjectIDs []string
	// AllowNoProject also keeps events that belong to no project (members,
	// shared labels) when ProjectIDs is set.
	AllowNoProject bool
	Types          []string
	ActorID        string
	NotActorID     string
	// Viewer hides events addressed to someone else. Empty shows all.
	Viewer string
	// OnlyAudience keeps only events addressed to this member.
	OnlyAudience string
	// Tasks keeps only events in the timelines of the tasks it selects.
	Tasks *TaskFilter
	Desc  bool
	Limit int
}

// SearchDoc is one entry in the full-text index.
type SearchDoc struct {
	Kind       string // task, comment, decision, doc, block
	EntityID   string
	ScopeType  string // task or doc: where a hit leads
	ScopeID    string
	ProjectID  string
	AudienceID string // set = private to this member
	Title      string
	Body       string
}

type SearchQuery struct {
	Text       string
	Kinds      []string
	ProjectIDs []string
	Viewer     string
	Limit      int
}

type SearchHit struct {
	Kind      string `json:"kind"`
	EntityID  string `json:"entity_id"`
	ScopeType string `json:"scope_type"`
	ScopeID   string `json:"scope_id"`
	ProjectID string `json:"project_id,omitempty"`
	Title     string `json:"title"`
	Snippet   string `json:"snippet"`
}

// TallyRow is one group of a Tally: the group's column values and its size.
type TallyRow struct {
	Keys  []string
	Count int
}
