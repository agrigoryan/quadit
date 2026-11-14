// Package core holds the product's own terms: the things people and agents
// work with, as they are stored, sent in events and returned by the API.
//
// Ids are UUIDv7 strings; an empty string means "none". Times are Unix
// milliseconds; zero means "not set".
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

// ValidCategory reports whether c is one of the fixed status categories.
func ValidCategory(c string) bool {
	switch c {
	case CatBacklog, CatUnstarted, CatStarted, CatWaiting, CatDone, CatCanceled:
		return true
	}
	return false
}

type Workspace struct {
	ID        string `json:"id"`
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Seq       int64  `json:"seq"`
	CreatedAt int64  `json:"created_at"`
}

// User is a person or an agent.
type User struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Name          string `json:"name"`
	Email         string `json:"email,omitempty"`
	WorkspaceID   string `json:"workspace_id,omitempty"`   // agents: the workspace that owns it
	ResponsibleID string `json:"responsible_id,omitempty"` // agents: the person who answers for it
	CreatedBy     string `json:"created_by,omitempty"`
	CreatedAt     int64  `json:"created_at"`
	DisabledAt    int64  `json:"disabled_at,omitempty"`
}

// Member is a user's place in one workspace.
type Member struct {
	WorkspaceID string `json:"workspace_id"`
	UserID      string `json:"user_id"`
	Role        Role   `json:"role"`
	Handle      string `json:"handle"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	CreatedAt   int64  `json:"created_at"`
}

type Project struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	CreatedBy   string `json:"created_by"`
	CreatedAt   int64  `json:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq"`
}

type Status struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Name      string `json:"name"`
	Color     string `json:"color,omitempty"`
	Category  string `json:"category"`
	Rank      string `json:"rank"`
	IsDefault bool   `json:"is_default,omitempty"`
}

type Label struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id,omitempty"`
	Name      string `json:"name"`
	Color     string `json:"color,omitempty"`
}

type Task struct {
	ID            string   `json:"id"`
	WorkspaceID   string   `json:"workspace_id"`
	ProjectID     string   `json:"project_id"`
	Number        int      `json:"number"`
	Key           string   `json:"key"` // project key + number, e.g. SVA-12
	Title         string   `json:"title"`
	Description   string   `json:"description,omitempty"`
	StatusID      string   `json:"status_id"`
	Priority      int      `json:"priority"`
	AssigneeID    string   `json:"assignee_id,omitempty"`
	WaitingOnID   string   `json:"waiting_on_id,omitempty"`
	WaitingOnNote string   `json:"waiting_on_note,omitempty"`
	ParentID      string   `json:"parent_id,omitempty"`
	Rank          string   `json:"rank"`
	DueOn         string   `json:"due_on,omitempty"`
	LabelIDs      []string `json:"label_ids,omitempty"`
	CreatedBy     string   `json:"created_by"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
	StartedAt     int64    `json:"started_at,omitempty"`
	CompletedAt   int64    `json:"completed_at,omitempty"`
	CanceledAt    int64    `json:"canceled_at,omitempty"`
	CreatedSeq    int64    `json:"created_seq"`
	UpdatedSeq    int64    `json:"updated_seq"`
	ActivitySeq   int64    `json:"activity_seq"`
	DeletedAt     int64    `json:"deleted_at,omitempty"`
}

type Comment struct {
	ID          string `json:"id"`
	TaskID      string `json:"task_id"`
	SubjectType string `json:"subject_type"`
	SubjectID   string `json:"subject_id"`
	ParentID    string `json:"parent_id,omitempty"`
	AuthorID    string `json:"author_id"`
	Body        string `json:"body"`
	CreatedAt   int64  `json:"created_at"`
	CreatedSeq  int64  `json:"created_seq"`
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
	ID                  string   `json:"id"`
	TaskID              string   `json:"task_id"`
	Kind                string   `json:"kind"`
	Question            string   `json:"question"`
	State               string   `json:"state"`
	RecommendedOptionID string   `json:"recommended_option_id,omitempty"`
	Recommendation      string   `json:"recommendation,omitempty"`
	PickedOptionID      string   `json:"picked_option_id,omitempty"`
	Outcome             string   `json:"outcome,omitempty"`
	OutcomeNote         string   `json:"outcome_note,omitempty"`
	DecidedBy           string   `json:"decided_by,omitempty"`
	DecidedAt           int64    `json:"decided_at,omitempty"`
	Rank                string   `json:"rank"`
	CreatedBy           string   `json:"created_by"`
	CreatedAt           int64    `json:"created_at"`
	UpdatedSeq          int64    `json:"updated_seq"`
	Options             []Option `json:"options,omitempty"`
}

type Option struct {
	ID          string `json:"id"`
	DecisionID  string `json:"decision_id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Rank        string `json:"rank"`
}

// Event is one accepted change, in order. Data carries the new values, so a
// reader can update its copy without asking again.
type Event struct {
	WorkspaceID string          `json:"-"`
	Seq         int64           `json:"seq"`
	At          int64           `json:"at"`
	ActorID     string          `json:"actor_id"`
	ChangeID    string          `json:"change_id"`
	Type        string          `json:"type"`
	EntityType  string          `json:"entity_type"`
	EntityID    string          `json:"entity_id"`
	ScopeType   string          `json:"scope_type"`
	ScopeID     string          `json:"scope_id"`
	ProjectID   string          `json:"project_id,omitempty"`
	Data        json.RawMessage `json:"data"`
}

// FieldChange is one field's old and new value inside an update event.
type FieldChange struct {
	From any `json:"from"`
	To   any `json:"to"`
}
