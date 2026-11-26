// Package store defines the data layer in the product's own terms. The rest
// of the code talks to these interfaces and never to SQL; each database is an
// implementation that must pass the same tests (package sqlstore, opened by
// package sqlite or postgres).
//
// Three interfaces:
//
//	DB     reads and writes rows: by conditions (Cond, Q), and the task list,
//	       the feed and full-text search, which conditions cannot express.
//	Tx     the DB of one write to one workspace, inside Store.Write: it
//	       hands out the workspace's event numbers and stores events, and
//	       can set rows back from an archive (Load, Overwrite).
//	Store  one database: a DB that sees every row, plus Write and Atomic
//	       (transactions), Snapshot, Restore, Overwrite and SchemaVersion
//	       (backups), and In.
//
// In(workspaceID) returns a DB bound to that workspace, and that is the
// guarantee the rest of the code relies on: every statement it runs on a
// workspace table is limited to rows of that workspace, so a row of
// another workspace is ErrNotFound and is never counted, listed, changed
// or deleted, and a row inserted through it is put in that workspace
// whatever its WorkspaceID says. Global tables (tables.go) are not
// limited. A Tx is bound the same way.
//
// Rows are the structs in package core. A struct's table is registered in
// tables.go; its db tags name the columns.
//
// The files: store.go holds the interfaces, conditions and filters;
// tables.go the registry of tables.
package store

import (
	"context"
	"errors"

	"github.com/agrigoryan/quadit/internal/core"
)

// ErrNotFound is returned when the row asked for does not exist, or is not
// in the workspace it was asked for in. Get returns it as a NotFoundError,
// which names the row; match it with errors.Is.
var ErrNotFound = errors.New("not found")

// NotFoundError is the ErrNotFound of a row type: its message, "task not
// found", names the row as a person would.
type NotFoundError struct {
	What string // the registered Noun of the row's table
}

func (e *NotFoundError) Error() string { return e.What + " not found" }

// Is makes a NotFoundError match ErrNotFound.
func (e *NotFoundError) Is(target error) bool { return target == ErrNotFound }

// Find asks whether a row is there: it loads the first row matching where
// into dst and returns true, or returns false when none matches. An error
// is a failure to read, never the row's absence, so a database that is not
// answering is never taken for a row that does not exist. Use Get when the
// row must be there.
func Find(ctx context.Context, db DB, dst any, where ...Cond) (bool, error) {
	err := db.Get(ctx, dst, where...)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

// ErrConflict is returned when a unique rule would be broken, for example a
// second project with the same key.
var ErrConflict = errors.New("conflict")

// ErrNoListen is returned by Listen on a database that only one server can
// use at a time, where there is nobody else to hear from.
var ErrNoListen = errors.New("this database does not carry news between servers")

// Listener is a store that hears of writes made through other servers.
type Listener interface {
	Listen(ctx context.Context, each func(workspaceID string, seq int64)) error
}

// Cond is one condition on a column, or (Either) a choice of conditions.
// Conditions combine with AND.
type Cond struct {
	Col string
	Op  string // = != > >= < <= in notin null notnull like, or either
	Val any
}

// Eq is col = v; with a nil v, col IS NULL.
func Eq(col string, v any) Cond { return Cond{col, "=", v} }

// Ne is col != v; with a nil v, col IS NOT NULL.
func Ne(col string, v any) Cond { return Cond{col, "!=", v} }

// Gt is col > v.
func Gt(col string, v any) Cond { return Cond{col, ">", v} }

// Gte is col >= v.
func Gte(col string, v any) Cond { return Cond{col, ">=", v} }

// Lt is col < v.
func Lt(col string, v any) Cond { return Cond{col, "<", v} }

// Lte is col <= v.
func Lte(col string, v any) Cond { return Cond{col, "<=", v} }

// In is col IN (vals). An empty list selects nothing.
func In(col string, vals []string) Cond { return Cond{col, "in", vals} }

// NotIn is col NOT IN (v). An empty list leaves every row in.
func NotIn(col string, v []string) Cond { return Cond{col, "notin", v} }

// Null is col IS NULL.
func Null(col string) Cond { return Cond{col, "null", nil} }

// NotNull is col IS NOT NULL.
func NotNull(col string) Cond { return Cond{col, "notnull", nil} }

// Either holds when any of conds does: a row at either end of a relation.
// With no conds it selects nothing.
func Either(conds ...Cond) Cond { return Cond{"", "either", conds} }

// Like is a LIKE in any case: the column and the pattern are compared in
// lowercase. % and _ in the pattern are LIKE's wildcards.
func Like(col string, pattern string) Cond { return Cond{col, "like", pattern} }

// Live selects rows that are not in the trash.
var Live = Null("deleted_at")

// Q selects and orders rows for List.
type Q struct {
	Where []Cond
	// Order is a comma-separated list of columns; a leading "-" sorts
	// descending: "rank", "-created_at,id".
	Order string
	// Limit is the most rows to load; 0 loads every matching row. Offset
	// skips that many first, and is used only with a Limit.
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
	// registered struct. No such row is a NotFoundError; to ask whether
	// the row is there, use Find.
	Get(ctx context.Context, dst any, where ...Cond) error
	// List loads the matching rows into dst, a pointer to a slice.
	List(ctx context.Context, dst any, q Q) error
	// Count counts the rows of the named table ("tasks") that match where.
	Count(ctx context.Context, table string, where ...Cond) (int, error)
	// Insert adds row, a registered struct or a pointer to one. In a DB
	// bound to a workspace, the row's workspace_id is that workspace,
	// whatever the row says. A row that breaks a unique rule (an id or a
	// name already taken) is ErrConflict, and nothing is written.
	Insert(ctx context.Context, row any) error
	// Upsert inserts row, or updates every non-key column if a row with the
	// same key columns exists.
	Upsert(ctx context.Context, row any, key ...string) error
	// Ensure inserts row unless a row with the same key columns is there,
	// which is then left exactly as it is; either way it is no error, and
	// a transaction it is part of goes on.
	Ensure(ctx context.Context, row any, key ...string) error
	// Advance is Upsert for a position that only moves forward: a row with
	// the same key columns is updated only when row's col is greater than
	// the stored one, and is otherwise left as it is. It is one statement,
	// so callers racing on the same row leave it at the greatest of their
	// positions, whatever order they arrive in.
	Advance(ctx context.Context, row any, col string, key ...string) error
	// Update sets columns on the matching rows and returns how many changed.
	Update(ctx context.Context, table string, set map[string]any, where ...Cond) (int64, error)
	// Delete removes the matching rows for good, and returns how many there
	// were. It is not the trash: that is deleted_at, set with Update.
	Delete(ctx context.Context, table string, where ...Cond) (int64, error)
	// Incr adds n to a counter column on one row and returns the new value.
	// When no row matches, it makes the row, with the counter at n, from
	// the conditions: each must be column = value and together they must
	// be a unique key of the table ("name" and "bucket" of a rate
	// counter). Callers racing to make the same row each count once. A
	// row that needs more columns than the conditions give is the
	// database's refusal, and conditions that cannot make a row at all
	// (another operator, a NULL) are NotFoundError.
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
	// Load and Overwrite are Store's, inside this write, for setting rows
	// back from an archive together with the events that tell of it. Like
	// every statement of a Tx, they reach only the workspace's rows.
	Load(ctx context.Context, table string, rows []map[string]any) error
	Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...Cond) error
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

	// CreateWorkspace runs fn in one transaction that first adds the
	// workspace ws and then writes to it as Write does, so a new workspace
	// and its first rows and events are there together or not at all. A
	// workspace whose id or slug is taken is ErrConflict, and nothing is
	// written.
	CreateWorkspace(ctx context.Context, ws core.Workspace, fn func(Tx) error) error

	// Atomic runs fn in one transaction outside any workspace's sequence,
	// for sign-in, settings and other install-level writes.
	Atomic(ctx context.Context, fn func(DB) error) error

	// Snapshot calls fn with the database as it stood at one moment: every
	// read through the Snapshot sees the same writes, whatever is written
	// meanwhile. A backup reads every table through one, so the archive is
	// the database at one moment.
	Snapshot(ctx context.Context, fn func(Snapshot) error) error
	// Restore runs fn in one transaction that loads an archive's rows:
	// when fn returns nil all of it is stored, and when it fails, none.
	Restore(ctx context.Context, fn func(Loader) error) error
	// Overwrite sets the matching rows to what an archive row says, leaving
	// the columns named in keep as they are.
	Overwrite(ctx context.Context, table string, row map[string]any, keep []string, where ...Cond) error
	// SchemaVersion is the schema version the database is at, which an
	// archive records.
	SchemaVersion(ctx context.Context) (int, error)
}

// Snapshot is a database read at one moment, inside Store.Snapshot.
type Snapshot interface {
	// Dump calls each with every row of a table as column -> value, for
	// backups that work across databases. Columns holding their zero
	// value are left out.
	Dump(ctx context.Context, table string, each func(row map[string]any) error) error
}

// Loader loads an archive's rows, inside Store.Restore.
type Loader interface {
	// Load inserts rows produced by Dump, after a trip through JSON.
	Load(ctx context.Context, table string, rows []map[string]any) error
	// UpgradeLoaded does to the rows loaded from an archive made at schema
	// version from what the upgrades since did to stored rows, so they read
	// as an upgrade would have left them. From 0 does all of it.
	UpgradeLoaded(ctx context.Context, from int) error
}

// TaskFilter selects tasks. Conditions combine with AND; inside a list, OR.
type TaskFilter struct {
	IDs         []string
	Keys        []string
	ProjectIDs  []string
	AssigneeIDs []string // any of these
	Unassigned  bool     // only tasks with no assignee
	CreatedBy   string
	WaitingOnID string
	// WaitingOutside: waits on an outside event (a note and no member).
	// WaitingNobody: names neither a member nor an event.
	WaitingOutside bool
	WaitingNobody  bool
	LeaseHolderID  string
	StatusIDs      []string
	Categories     []string // status categories, e.g. started, waiting
	Open           bool     // not done and not canceled
	Closed         bool     // done, canceled or archived: everything Open with Archived off leaves out
	// MadeUpTo keeps to tasks made at or before a feed position, so a list
	// read page by page does not shift when tasks are added meanwhile.
	MadeUpTo int64
	// After continues a sorted list past its last row: the values of that
	// row's sort keys, in order (see TaskSortKeys). A row is returned only
	// when it sorts after them, so a list read page by page is not shifted
	// by rows that close or are added meanwhile.
	After         []any
	LabelIDs      []string // has every one of these
	ParentID      string
	TopLevel      bool // no parent
	EpicIDs       []string
	NoEpic        bool
	MilestoneID   string
	CycleIDs      []string
	NoCycle       bool
	Priorities    []int
	Estimates     []int  // any of these
	NoEstimate    bool   // or none
	DueBefore     string // due on or before this date
	DueAfter      string
	MentionsID    string // tasks that mention this member
	WatchedBy     string
	Involves      string // tasks this member is assigned, is waited on, is mentioned in or watches: their own
	ActivityAfter int64  // something happened in the task after this seq
	UpdatedAfter  int64  // the task's own fields changed after this seq
	OpenDecision  bool   // has an open decision
	AskedID       string // has an open decision asked of this member
	Text          string // title contains
	InTrash       bool   // only deleted tasks; default is only live ones
	Archived      bool   // include archived tasks
	// Sort is one of: created (default), -created, rank, priority, due,
	// -activity, -updated, key.
	Sort string
	// Limit is the most tasks to return, itself at most 5000: 0 gives 100,
	// unlike Q.Limit, where 0 is every row.
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
	// NotProjectIDs leaves out the events of these projects; those of no
	// project stay.
	NotProjectIDs []string
	Types         []string
	ActorID       string
	NotActorID    string
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

// SearchQuery asks the full-text index for the entries that hold every word
// of Text, of the Kinds when they are set, that Viewer may see: of the
// ProjectIDs, when they are set, or of no project; and not of a private
// page that is not Viewer's own or shared with Viewer. At most Limit of
// them.
type SearchQuery struct {
	Text       string
	Kinds      []string
	ProjectIDs []string
	Viewer     string
	Limit      int
}

// SearchHit is one entry Search found, with a snippet of its body around
// the words found, which are marked with **.
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

// SortKey is one column a task list is ordered by.
type SortKey struct {
	Expr string              // SQL over the tasks table "t"; never NULL
	Desc bool                // largest first
	Val  func(core.Task) any // the same value, from a row
}

// TaskSortKeys are the orderings a task list can have. Each ends in a key
// no two tasks share, so "after this row" is always well defined.
var TaskSortKeys = map[string][]SortKey{
	"":         {{Expr: "t.id", Val: func(t core.Task) any { return t.ID }}},
	"created":  {{Expr: "t.id", Val: func(t core.Task) any { return t.ID }}},
	"-created": {{Expr: "t.id", Desc: true, Val: func(t core.Task) any { return t.ID }}},
	"rank": {{Expr: "t.rank", Val: func(t core.Task) any { return t.Rank }},
		{Expr: "t.id", Val: func(t core.Task) any { return t.ID }}},
	"priority": {{Expr: "CASE t.priority WHEN 0 THEN 5 ELSE t.priority END", Val: func(t core.Task) any {
		if t.Priority == 0 {
			return 5
		}
		return t.Priority
	}}, {Expr: "t.id", Val: func(t core.Task) any { return t.ID }}},
	"due": {{Expr: "CASE WHEN t.due_on IS NULL THEN 1 ELSE 0 END", Val: func(t core.Task) any {
		if t.DueOn == "" {
			return 1
		}
		return 0
	}}, {Expr: "COALESCE(t.due_on, '')", Val: func(t core.Task) any { return t.DueOn }},
		{Expr: "t.id", Val: func(t core.Task) any { return t.ID }}},
	"-activity": {{Expr: "t.activity_seq", Desc: true, Val: func(t core.Task) any { return t.ActivitySeq }},
		{Expr: "t.id", Desc: true, Val: func(t core.Task) any { return t.ID }}},
	"-updated": {{Expr: "t.updated_seq", Desc: true, Val: func(t core.Task) any { return t.UpdatedSeq }},
		{Expr: "t.id", Desc: true, Val: func(t core.Task) any { return t.ID }}},
	"key": {{Expr: "t.project_id", Val: func(t core.Task) any { return t.ProjectID }},
		{Expr: "t.number", Val: func(t core.Task) any { return t.Number }}},
}
