// Package core holds the product's own terms: the things people and agents
// work with, as they are stored, sent in events and returned by the API.
//
// Ids are UUIDv7 strings; an empty string means "none". Times are Unix
// milliseconds; zero means "not set". Dates are "YYYY-MM-DD".
//
// The db tag names the column a field is stored in. ",null" stores the zero
// value as NULL; ",json" stores the field as JSON.
package core

import "encoding/json"

// Role is what a member may do in a workspace. A role is a ceiling: an
// agent's scope can only narrow it.
type Role string

const (
	RoleOwner  Role = "owner"  // people only
	RoleAdmin  Role = "admin"  // manages members, agents, projects, settings
	RoleMember Role = "member" // works on tasks, decisions and comments
)

// AtLeast reports whether r grants everything min does.
func (r Role) AtLeast(min Role) bool { return roleLevel[r] >= roleLevel[min] && roleLevel[r] > 0 }

var roleLevel = map[Role]int{RoleMember: 1, RoleAdmin: 2, RoleOwner: 3}

// Kinds of user.
const (
	KindPerson = "person"
	KindAgent  = "agent"
)

// Status categories are fixed; names, colours and order belong to the team.
const (
	CatBacklog   = "backlog"
	CatUnstarted = "unstarted"
	CatStarted   = "started"
	CatWaiting   = "waiting"
	CatDone      = "done"
	CatCanceled  = "canceled"
)

// Categories lists the status categories in board order.
var Categories = []string{CatBacklog, CatUnstarted, CatStarted, CatWaiting, CatDone, CatCanceled}

// ValidCategory reports whether c is one of the fixed status categories.
func ValidCategory(c string) bool {
	for _, k := range Categories {
		if k == c {
			return true
		}
	}
	return false
}

// OpenCategory reports whether a task in this category is still open.
func OpenCategory(c string) bool { return c != CatDone && c != CatCanceled }

type Workspace struct {
	ID            string          `json:"id" db:"id"`
	Slug          string          `json:"slug" db:"slug"`
	Name          string          `json:"name" db:"name"`
	Icon          string          `json:"icon,omitempty" db:"icon"`
	Seq           int64           `json:"seq" db:"seq"`
	DispatchedSeq int64           `json:"-" db:"dispatched_seq"`
	Settings      json.RawMessage `json:"settings,omitempty" db:"settings,json"`
	CreatedAt     int64           `json:"created_at" db:"created_at"`
	UpdatedAt     int64           `json:"-" db:"updated_at"`
	DeletedAt     int64           `json:"-" db:"deleted_at,null"`
}

// User is a person or an agent.
type User struct {
	ID            string          `json:"id" db:"id"`
	Kind          string          `json:"kind" db:"kind"`
	Name          string          `json:"name" db:"name"`
	Email         string          `json:"email,omitempty" db:"email,null"`
	Avatar        string          `json:"avatar,omitempty" db:"avatar"`
	Description   string          `json:"description,omitempty" db:"description"`
	Timezone      string          `json:"timezone,omitempty" db:"timezone"`
	Theme         string          `json:"theme,omitempty" db:"theme"`
	Locale        string          `json:"locale,omitempty" db:"locale"`
	PasswordHash  string          `json:"-" db:"password_hash,null"`
	TOTPSecret    string          `json:"-" db:"totp_secret,null"`
	TOTPAt        int64           `json:"totp_at,omitempty" db:"totp_at,null"`
	IsAdmin       bool            `json:"is_admin,omitempty" db:"is_admin"`
	Notify        json.RawMessage `json:"notify,omitempty" db:"notify,json"`
	WorkspaceID   string          `json:"workspace_id,omitempty" db:"workspace_id,null"`     // agents: the workspace that owns it
	ResponsibleID string          `json:"responsible_id,omitempty" db:"responsible_id,null"` // agents: the person who answers for it
	CreatedBy     string          `json:"created_by,omitempty" db:"created_by,null"`
	CreatedAt     int64           `json:"created_at" db:"created_at"`
	UpdatedAt     int64           `json:"-" db:"updated_at"`
	LastSeenAt    int64           `json:"last_seen_at,omitempty" db:"last_seen_at,null"`
	DisabledAt    int64           `json:"disabled_at,omitempty" db:"disabled_at,null"`
	DeletedAt     int64           `json:"-" db:"deleted_at,null"`
}

// Scope narrows what an agent may do below its role.
type Scope struct {
	// Projects lists the project ids it may work in; empty means all.
	Projects []string `json:"projects,omitempty"`
	ReadOnly bool     `json:"read_only,omitempty"`
	// NeedsApproval lists the change types it must get approved first.
	NeedsApproval []string `json:"needs_approval,omitempty"`
}

// Budget limits an agent or a task. Zero means no limit.
type Budget struct {
	CostMicros int64 `json:"cost_micros,omitempty"` // per week for an agent, in total for a task
	Minutes    int64 `json:"minutes,omitempty"`
}

// Member is a user's place in one workspace.
type Member struct {
	WorkspaceID    string  `json:"workspace_id" db:"workspace_id"`
	UserID         string  `json:"user_id" db:"user_id"`
	Role           Role    `json:"role" db:"role"`
	Handle         string  `json:"handle" db:"handle"`
	Kind           string  `json:"kind" db:"kind"`
	Name           string  `json:"name" db:"name"`
	Avatar         string  `json:"avatar,omitempty" db:"avatar"`
	Title          string  `json:"title,omitempty" db:"title"`
	Scope          *Scope  `json:"scope,omitempty" db:"scope,json"`
	Budget         *Budget `json:"budget,omitempty" db:"budget,json"`
	LastSeenAt     int64   `json:"last_seen_at,omitempty" db:"last_seen_at,null"`
	LastAction     string  `json:"last_action,omitempty" db:"last_action"`
	ListeningUntil int64   `json:"listening_until,omitempty" db:"listening_until,null"`
	CreatedAt      int64   `json:"created_at" db:"created_at"`
	UpdatedSeq     int64   `json:"updated_seq" db:"updated_seq"`
	SuspendedAt    int64   `json:"suspended_at,omitempty" db:"suspended_at,null"`
	RemovedAt      int64   `json:"removed_at,omitempty" db:"removed_at,null"`
	// ResponsibleID is the person who answers for an agent. It is kept on
	// the user and filled in when members are read.
	ResponsibleID string `json:"responsible_id,omitempty"`
}

type APIToken struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"workspace_id" db:"workspace_id"`
	UserID      string `json:"user_id" db:"user_id"`
	Name        string `json:"name" db:"name"`
	TokenHash   string `json:"-" db:"token_hash"`
	Prefix      string `json:"prefix" db:"prefix"`
	Scopes      string `json:"scopes,omitempty" db:"scopes"`
	Kind        string `json:"kind" db:"kind"`
	ClientID    string `json:"client_id,omitempty" db:"client_id"`
	RefreshHash string `json:"-" db:"refresh_hash,null"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	ExpiresAt   int64  `json:"expires_at,omitempty" db:"expires_at,null"`
	LastUsedAt  int64  `json:"last_used_at,omitempty" db:"last_used_at,null"`
	RevokedAt   int64  `json:"revoked_at,omitempty" db:"revoked_at,null"`
}

// ProjectSettings are a project's switches.
type ProjectSettings struct {
	Cycles     bool `json:"cycles,omitempty"`
	CycleDays  int  `json:"cycle_days,omitempty"`
	CycleStart int  `json:"cycle_start,omitempty"` // weekday the cycle starts on, 0 = Sunday
	Estimates  bool `json:"estimates,omitempty"`
}

type Project struct {
	ID           string           `json:"id" db:"id"`
	WorkspaceID  string           `json:"workspace_id" db:"workspace_id"`
	Key          string           `json:"key" db:"key"`
	Name         string           `json:"name" db:"name"`
	Description  string           `json:"description,omitempty" db:"description"`
	Icon         string           `json:"icon,omitempty" db:"icon"`
	Color        string           `json:"color,omitempty" db:"color"`
	LeadID       string           `json:"lead_id,omitempty" db:"lead_id,null"`
	Rank         string           `json:"rank,omitempty" db:"rank"`
	Settings     *ProjectSettings `json:"settings,omitempty" db:"settings,json"`
	TaskCounter  int              `json:"-" db:"task_counter"`
	CycleCounter int              `json:"-" db:"cycle_counter"`
	CreatedBy    string           `json:"created_by" db:"created_by"`
	CreatedAt    int64            `json:"created_at" db:"created_at"`
	UpdatedAt    int64            `json:"-" db:"updated_at"`
	CreatedSeq   int64            `json:"-" db:"created_seq"`
	UpdatedSeq   int64            `json:"updated_seq" db:"updated_seq"`
	ArchivedAt   int64            `json:"archived_at,omitempty" db:"archived_at,null"`
	DeletedAt    int64            `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type Status struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ProjectID   string `json:"project_id" db:"project_id"`
	Name        string `json:"name" db:"name"`
	Color       string `json:"color,omitempty" db:"color"`
	Category    string `json:"category" db:"category"`
	Rank        string `json:"rank" db:"rank"`
	IsDefault   bool   `json:"is_default,omitempty" db:"is_default"`
	CreatedAt   int64  `json:"-" db:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type Label struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ProjectID   string `json:"project_id,omitempty" db:"project_id,null"`
	Name        string `json:"name" db:"name"`
	Color       string `json:"color,omitempty" db:"color"`
	Description string `json:"description,omitempty" db:"description"`
	CreatedAt   int64  `json:"-" db:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type Task struct {
	ID            string `json:"id" db:"id"`
	WorkspaceID   string `json:"-" db:"workspace_id"`
	ProjectID     string `json:"project_id" db:"project_id"`
	Number        int    `json:"number" db:"number"`
	Key           string `json:"key" db:"key"` // project key + number, e.g. SVA-12
	Title         string `json:"title" db:"title"`
	Description   string `json:"description,omitempty" db:"description"`
	StatusID      string `json:"status_id" db:"status_id"`
	Priority      int    `json:"priority" db:"priority"`
	AssigneeID    string `json:"assignee_id,omitempty" db:"assignee_id,null"`
	WaitingOnID   string `json:"waiting_on_id,omitempty" db:"waiting_on_id,null"`
	WaitingOnNote string `json:"waiting_on_note,omitempty" db:"waiting_on_note"`
	// AskedBy is the person an agent works this task for: whoever gave it
	// to an agent. Agents work on the task with no more access than theirs.
	AskedBy       string   `json:"asked_by,omitempty" db:"asked_by,null"`
	ParentID      string   `json:"parent_id,omitempty" db:"parent_id,null"`
	EpicID        string   `json:"epic_id,omitempty" db:"epic_id,null"`
	MilestoneID   string   `json:"milestone_id,omitempty" db:"milestone_id,null"`
	CycleID       string   `json:"cycle_id,omitempty" db:"cycle_id,null"`
	Estimate      int      `json:"estimate,omitempty" db:"estimate,null"`
	LabelIDs      []string `json:"label_ids,omitempty" db:"label_ids,json"`
	LeaseHolderID string   `json:"lease_holder_id,omitempty" db:"lease_holder_id,null"`
	LeaseUntil    int64    `json:"lease_until,omitempty" db:"lease_until,null"`
	Budget        *Budget  `json:"budget,omitempty" db:"budget,json"`
	Rank          string   `json:"rank" db:"rank"`
	DueOn         string   `json:"due_on,omitempty" db:"due_on,null"`
	CreatedBy     string   `json:"created_by" db:"created_by"`
	CreatedAt     int64    `json:"created_at" db:"created_at"`
	UpdatedAt     int64    `json:"updated_at" db:"updated_at"`
	StartedAt     int64    `json:"started_at,omitempty" db:"started_at,null"`
	CompletedAt   int64    `json:"completed_at,omitempty" db:"completed_at,null"`
	CanceledAt    int64    `json:"canceled_at,omitempty" db:"canceled_at,null"`
	CreatedSeq    int64    `json:"created_seq" db:"created_seq"`
	UpdatedSeq    int64    `json:"updated_seq" db:"updated_seq"`
	ActivitySeq   int64    `json:"activity_seq" db:"activity_seq"`
	ArchivedAt    int64    `json:"archived_at,omitempty" db:"archived_at,null"`
	DeletedAt     int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
	DeletedBy     string   `json:"-" db:"deleted_by,null"`
}

// Relation types. One row per pair; the reverse name is derived when read.
const (
	RelBlocks     = "blocks"
	RelRelates    = "relates"
	RelDuplicates = "duplicates"
)

type Relation struct {
	ID            string `json:"id" db:"id"`
	WorkspaceID   string `json:"-" db:"workspace_id"`
	TaskID        string `json:"task_id" db:"task_id"`
	RelatedTaskID string `json:"related_task_id" db:"related_task_id"`
	Type          string `json:"type" db:"type"`
	CreatedBy     string `json:"created_by" db:"created_by"`
	CreatedAt     int64  `json:"created_at" db:"created_at"`
}

// Evidence is what a result says about how it was checked.
type Evidence struct {
	Checked     string `json:"checked,omitempty"`
	Measured    string `json:"measured,omitempty"`
	NotVerified string `json:"not_verified,omitempty"`
}

type Comment struct {
	ID          string    `json:"id" db:"id"`
	WorkspaceID string    `json:"-" db:"workspace_id"`
	TaskID      string    `json:"task_id,omitempty" db:"task_id,null"`
	DocID       string    `json:"doc_id,omitempty" db:"doc_id,null"`
	SubjectType string    `json:"subject_type" db:"subject_type"`
	SubjectID   string    `json:"subject_id" db:"subject_id"`
	Kind        string    `json:"kind" db:"kind"`
	Evidence    *Evidence `json:"evidence,omitempty" db:"evidence,json"`
	ResolvedAt  int64     `json:"resolved_at,omitempty" db:"resolved_at,null"`
	ParentID    string    `json:"parent_id,omitempty" db:"parent_id,null"`
	AuthorID    string    `json:"author_id" db:"author_id"`
	Body        string    `json:"body" db:"body"`
	CreatedAt   int64     `json:"created_at" db:"created_at"`
	EditedAt    int64     `json:"edited_at,omitempty" db:"edited_at,null"`
	CreatedSeq  int64     `json:"created_seq" db:"created_seq"`
	UpdatedSeq  int64     `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64     `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Decision kinds, states and outcomes.
const (
	DecisionChoice   = "choice"
	DecisionApproval = "approval"

	StateOpen     = "open"
	StatePicked   = "picked"
	StateSentBack = "sent_back"

	OutcomeAsIs        = "as_is"
	OutcomeWithChanges = "with_changes"
	OutcomeNone        = "none"
	OutcomeApproved    = "approved"
	OutcomeDeclined    = "declined"
)

// Decision is a question inside a task, its options and its answer.
type Decision struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	TaskID      string `json:"task_id" db:"task_id"`
	Kind        string `json:"kind" db:"kind"`
	Question    string `json:"question" db:"question"`
	Details     string `json:"details,omitempty" db:"details"`
	Action      string `json:"action,omitempty" db:"action"`
	// ActionArgs are the arguments of the change an approval is for; the
	// approval covers that change and no other. ActionUsedAt is when it ran.
	ActionArgs          json.RawMessage `json:"action_args,omitempty" db:"action_args,json"`
	ActionUsedAt        int64           `json:"action_used_at,omitempty" db:"action_used_at,null"`
	State               string          `json:"state" db:"state"`
	AskedID             string          `json:"asked_id,omitempty" db:"asked_id,null"`
	UnclearNote         string          `json:"unclear_note,omitempty" db:"unclear_note"`
	RecommendedOptionID string          `json:"recommended_option_id,omitempty" db:"recommended_option_id,null"`
	Recommendation      string          `json:"recommendation,omitempty" db:"recommendation"`
	PickedOptionID      string          `json:"picked_option_id,omitempty" db:"picked_option_id,null"`
	Outcome             string          `json:"outcome,omitempty" db:"outcome,null"`
	OutcomeNote         string          `json:"outcome_note,omitempty" db:"outcome_note"`
	DecidedBy           string          `json:"decided_by,omitempty" db:"decided_by,null"`
	DecidedAt           int64           `json:"decided_at,omitempty" db:"decided_at,null"`
	Rank                string          `json:"rank" db:"rank"`
	CreatedBy           string          `json:"created_by" db:"created_by"`
	CreatedAt           int64           `json:"created_at" db:"created_at"`
	UpdatedAt           int64           `json:"updated_at" db:"updated_at"`
	CreatedSeq          int64           `json:"-" db:"created_seq"`
	UpdatedSeq          int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt           int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
	Options             []Option        `json:"options,omitempty"`
}

type Option struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	DecisionID  string `json:"decision_id" db:"decision_id"`
	Label       string `json:"label" db:"label"`
	Description string `json:"description,omitempty" db:"description"`
	Rank        string `json:"rank" db:"rank"`
	CreatedAt   int64  `json:"-" db:"created_at"`
	DeletedAt   int64  `json:"-" db:"deleted_at,null"`
}

// Event is one accepted change, in order. Data carries the new values, so a
// reader can update its copy without asking again.
type Event struct {
	WorkspaceID string          `json:"-" db:"workspace_id"`
	Seq         int64           `json:"seq" db:"seq"`
	At          int64           `json:"at" db:"at"`
	ActorID     string          `json:"actor_id" db:"actor_id"`
	ChangeID    string          `json:"change_id" db:"change_id"`
	Type        string          `json:"type" db:"type"`
	EntityType  string          `json:"entity_type" db:"entity_type"`
	EntityID    string          `json:"entity_id" db:"entity_id"`
	ScopeType   string          `json:"scope_type" db:"scope_type"`
	ScopeID     string          `json:"scope_id" db:"scope_id"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	AudienceID  string          `json:"audience_id,omitempty" db:"audience_id,null"`
	Data        json.RawMessage `json:"data" db:"data,json"`
}

// FieldChange is one field's old and new value inside an update event.
type FieldChange struct {
	From any `json:"from"`
	To   any `json:"to"`
}

// AppliedChange records that a change id was used, and what it produced.
type AppliedChange struct {
	WorkspaceID string `db:"workspace_id"`
	ID          string `db:"id"`
	ActorID     string `db:"actor_id"`
	Type        string `db:"type"`
	ArgsHash    string `db:"args_hash"`
	FirstSeq    int64  `db:"first_seq"`
	LastSeq     int64  `db:"last_seq"`
	CreatedAt   int64  `db:"created_at"`
}

type Cursor struct {
	WorkspaceID string `db:"workspace_id"`
	UserID      string `db:"user_id"`
	Name        string `db:"name"`
	Seq         int64  `db:"seq"`
	UpdatedAt   int64  `db:"updated_at"`
}
