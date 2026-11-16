// Epics, milestones, cycles, saved views, links to code, mentions,
// templates, preferences and the keys a task had: what organizes tasks.

package core

import "encoding/json"

// Epic states.
const (
	EpicPlanned  = "planned"
	EpicActive   = "active"
	EpicPaused   = "paused"
	EpicDone     = "done"
	EpicCanceled = "canceled"
)

// EpicStates lists the epic states in the order they are offered.
var EpicStates = []string{EpicPlanned, EpicActive, EpicPaused, EpicDone, EpicCanceled}

// Epic is a body of work in a project that tasks belong to.
type Epic struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ProjectID   string `json:"project_id" db:"project_id"`
	Name        string `json:"name" db:"name"`
	Description string `json:"description,omitempty" db:"description"`
	State       string `json:"state" db:"state"`                    // one of EpicStates
	LeadID      string `json:"lead_id,omitempty" db:"lead_id,null"` // the member who leads it
	Color       string `json:"color,omitempty" db:"color"`
	Icon        string `json:"icon,omitempty" db:"icon"`
	StartOn     string `json:"start_on,omitempty" db:"start_on,null"`
	TargetOn    string `json:"target_on,omitempty" db:"target_on,null"`
	Rank        string `json:"rank" db:"rank"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	UpdatedAt   int64  `json:"updated_at" db:"updated_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	CompletedAt int64  `json:"completed_at,omitempty" db:"completed_at,null"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Milestone is a stage of an epic, with a date it aims for.
type Milestone struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	EpicID      string `json:"epic_id" db:"epic_id"`
	Name        string `json:"name" db:"name"`
	Description string `json:"description,omitempty" db:"description"`
	TargetOn    string `json:"target_on,omitempty" db:"target_on,null"`
	Rank        string `json:"rank" db:"rank"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Cycle is one numbered stretch of days a project plans its work in.
type Cycle struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ProjectID   string `json:"project_id" db:"project_id"`
	Number      int    `json:"number" db:"number"`
	Name        string `json:"name,omitempty" db:"name"`
	StartsOn    string `json:"starts_on" db:"starts_on"`
	EndsOn      string `json:"ends_on" db:"ends_on"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	ClosedAt    int64  `json:"closed_at,omitempty" db:"closed_at,null"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// View is a saved query over tasks, with how to lay them out. It is the
// owner's own unless shared.
type View struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	Name        string          `json:"name" db:"name"`
	Slug        string          `json:"slug" db:"slug"`
	Description string          `json:"description,omitempty" db:"description"`
	Icon        string          `json:"icon,omitempty" db:"icon"`
	OwnerID     string          `json:"owner_id" db:"owner_id"`
	Shared      bool            `json:"shared" db:"shared"`
	Query       json.RawMessage `json:"query,omitempty" db:"query,json"`     // the filters and sort
	Layout      string          `json:"layout" db:"layout"`                  // list, board, …
	Display     json.RawMessage `json:"display,omitempty" db:"display,json"` // what each row or card shows
	Rank        string          `json:"rank" db:"rank"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// TaskQuery is how tasks are asked for: in the URL of a task list, in the
// feed, and as the Query of a saved view. Names work everywhere ids do. The
// engine turns one into the store's filter (Resolver.TaskFilter).
type TaskQuery struct {
	Project      []string `json:"project,omitempty"`
	Assignee     []string `json:"assignee,omitempty"` // me, @handle, none
	Creator      string   `json:"creator,omitempty"`
	Status       []string `json:"status,omitempty"`
	Category     []string `json:"category,omitempty"`
	Open         *bool    `json:"open,omitempty"`
	WaitingOn    string   `json:"waiting_on,omitempty"`
	HeldBy       string   `json:"held_by,omitempty"`
	Label        []string `json:"label,omitempty"`
	Epic         []string `json:"epic,omitempty"`  // names or ids, or none
	Cycle        []string `json:"cycle,omitempty"` // current, next, a number, an id, or none
	Milestone    string   `json:"milestone,omitempty"`
	Priority     []int    `json:"priority,omitempty"`
	DueBefore    string   `json:"due_before,omitempty"`
	DueAfter     string   `json:"due_after,omitempty"`
	Mentions     string   `json:"mentions,omitempty"`
	Watching     bool     `json:"watching,omitempty"`
	OpenDecision bool     `json:"has_open_decision,omitempty"`
	Asked        string   `json:"asked,omitempty"` // has an open decision asked of this member
	ChangedSince int64    `json:"changed_since,omitempty"`
	UpdatedSince int64    `json:"updated_since,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	TopLevel     bool     `json:"top_level,omitempty"`
	Q            string   `json:"q,omitempty"`
	Keys         []string `json:"keys,omitempty"`
	Trash        bool     `json:"trash,omitempty"`
	Archived     bool     `json:"archived,omitempty"`
	Sort         string   `json:"sort,omitempty"`
	Limit        int      `json:"limit,omitempty"`
	Offset       int      `json:"offset,omitempty"`
	// SavedAs is the slug of the saved view the query was read from, when it
	// was. What such a query names may have been deleted since it was
	// saved: a status, label or epic that is gone is then left out and
	// noted, where a query asked afresh is refused. It is not part of the
	// query as stored.
	SavedAs string `json:"-"`
}

// Task link kinds.
const (
	LinkBranch = "branch"
	LinkCommit = "commit"
	LinkPR     = "pr"
	LinkIssue  = "issue"
	LinkURL    = "url"
	// LinkDoc ties a task to a page of the workspace; Ref is the page's id.
	LinkDoc = "doc"
)

// LinkKinds are every kind a task link may be, in the order the engine
// names them when it refuses another.
var LinkKinds = []string{LinkBranch, LinkCommit, LinkPR, LinkIssue, LinkURL, LinkDoc}

// TaskLink ties a task to something outside: a branch, a commit, a pull
// request, an issue or any URL; or to a page of the workspace.
type TaskLink struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	TaskID      string          `json:"task_id" db:"task_id"`
	Kind        string          `json:"kind" db:"kind"` // one of the Link* kinds
	URL         string          `json:"url,omitempty" db:"url"`
	Title       string          `json:"title,omitempty" db:"title"`
	Repo        string          `json:"repo,omitempty" db:"repo"`
	Ref         string          `json:"ref,omitempty" db:"ref"`
	State       string          `json:"state,omitempty" db:"state"`   // open, merged, … as the link's source says
	Checks      string          `json:"checks,omitempty" db:"checks"` // the state of its checks, when it has any
	Data        json.RawMessage `json:"data,omitempty" db:"data,json"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedAt   int64           `json:"updated_at" db:"updated_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Ref records that one thing mentions another.
type Ref struct {
	WorkspaceID   string `json:"-" db:"workspace_id"`
	FromType      string `json:"from_type" db:"from_type"`
	FromID        string `json:"from_id" db:"from_id"`
	FromScopeType string `json:"from_scope_type" db:"from_scope_type"`
	FromScopeID   string `json:"from_scope_id" db:"from_scope_id"`
	ToType        string `json:"to_type" db:"to_type"`
	ToID          string `json:"to_id" db:"to_id"`
}

// Template is a ready-made task: a title, a description and preset fields.
type Template struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	Name        string          `json:"name" db:"name"`
	Title       string          `json:"title,omitempty" db:"title"`
	Description string          `json:"description,omitempty" db:"description"`
	Preset      json.RawMessage `json:"preset,omitempty" db:"preset,json"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Preference is a standing rule made from a decision.
type Preference struct {
	ID          string   `json:"id" db:"id"`
	WorkspaceID string   `json:"-" db:"workspace_id"`
	ProjectID   string   `json:"project_id,omitempty" db:"project_id,null"`
	Body        string   `json:"body" db:"body"`
	DecisionID  string   `json:"decision_id,omitempty" db:"decision_id,null"`
	LabelIDs    []string `json:"label_ids,omitempty" db:"label_ids,json"`
	CreatedBy   string   `json:"created_by" db:"created_by"`
	CreatedAt   int64    `json:"created_at" db:"created_at"`
	UpdatedSeq  int64    `json:"updated_seq" db:"updated_seq"`
	RetiredAt   int64    `json:"retired_at,omitempty" db:"retired_at,null"`
	DeletedAt   int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// TaskLabel links a task to a label; kept beside tasks.label_ids for filters.
type TaskLabel struct {
	TaskID      string `db:"task_id"`
	LabelID     string `db:"label_id"`
	WorkspaceID string `db:"workspace_id"`
}

// TaskKey is a key a task had before it moved to another project.
type TaskKey struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	Key         string `json:"key" db:"key"`
	TaskID      string `json:"task_id" db:"task_id"`
	At          int64  `json:"at" db:"at"`
}
