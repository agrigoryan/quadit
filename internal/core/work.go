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

var EpicStates = []string{EpicPlanned, EpicActive, EpicPaused, EpicDone, EpicCanceled}

type Epic struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ProjectID   string `json:"project_id" db:"project_id"`
	Name        string `json:"name" db:"name"`
	Description string `json:"description,omitempty" db:"description"`
	State       string `json:"state" db:"state"`
	LeadID      string `json:"lead_id,omitempty" db:"lead_id,null"`
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
	Query       json.RawMessage `json:"query,omitempty" db:"query,json"`
	Layout      string          `json:"layout" db:"layout"`
	Display     json.RawMessage `json:"display,omitempty" db:"display,json"`
	Rank        string          `json:"rank" db:"rank"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type Watcher struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	UserID      string `json:"user_id" db:"user_id"`
	SubjectType string `json:"subject_type" db:"subject_type"`
	SubjectID   string `json:"subject_id" db:"subject_id"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
}

// Notification types.
const (
	NoteAssigned  = "assigned"
	NoteMentioned = "mentioned"
	NoteWaitingOn = "waiting_on"
	NoteAsked     = "decision_asked"
	NotePicked    = "picked"
	NoteUnclear   = "unclear"
	NoteReplied   = "replied"
	NoteComment   = "comment"
	NoteResult    = "result"
	NoteStatus    = "status"
	NoteBudget    = "budget"
)

// Notification is one inbox item.
type Notification struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	UserID      string `json:"user_id" db:"user_id"`
	Seq         int64  `json:"seq" db:"seq"`
	Type        string `json:"type" db:"type"`
	ActorID     string `json:"actor_id" db:"actor_id"`
	TaskID      string `json:"task_id,omitempty" db:"task_id,null"`
	DocID       string `json:"doc_id,omitempty" db:"doc_id,null"`
	EntityType  string `json:"entity_type,omitempty" db:"entity_type"`
	EntityID    string `json:"entity_id,omitempty" db:"entity_id,null"`
	Title       string `json:"title,omitempty" db:"title"`
	Snippet     string `json:"snippet,omitempty" db:"snippet"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	ReadAt      int64  `json:"read_at,omitempty" db:"read_at,null"`
	ArchivedAt  int64  `json:"archived_at,omitempty" db:"archived_at,null"`
}

type TaskLink struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	TaskID      string          `json:"task_id" db:"task_id"`
	Kind        string          `json:"kind" db:"kind"`
	URL         string          `json:"url,omitempty" db:"url"`
	Title       string          `json:"title,omitempty" db:"title"`
	Repo        string          `json:"repo,omitempty" db:"repo"`
	Ref         string          `json:"ref,omitempty" db:"ref"`
	State       string          `json:"state,omitempty" db:"state"`
	Checks      string          `json:"checks,omitempty" db:"checks"`
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

type File struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	Name        string `json:"name" db:"name"`
	ContentType string `json:"content_type" db:"content_type"`
	Size        int64  `json:"size" db:"size"`
	Received    int64  `json:"received,omitempty" db:"received"`
	SHA256      string `json:"sha256,omitempty" db:"sha256"`
	StorageKey  string `json:"-" db:"storage_key"`
	State       string `json:"state" db:"state"`
	Width       int    `json:"width,omitempty" db:"width,null"`
	Height      int    `json:"height,omitempty" db:"height,null"`
	DurationMS  int64  `json:"duration_ms,omitempty" db:"duration_ms,null"`
	PreviewKey  string `json:"-" db:"preview_key"`
	UploadedBy  string `json:"uploaded_by" db:"uploaded_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
	// Filled when read: where to fetch it.
	URL        string `json:"url,omitempty"`
	PreviewURL string `json:"preview_url,omitempty"`
}

type Attachment struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	FileID      string `json:"file_id" db:"file_id"`
	SubjectType string `json:"subject_type" db:"subject_type"`
	SubjectID   string `json:"subject_id" db:"subject_id"`
	TaskID      string `json:"task_id,omitempty" db:"task_id,null"`
	Role        string `json:"role,omitempty" db:"role"`
	Caption     string `json:"caption,omitempty" db:"caption"`
	Rank        string `json:"rank" db:"rank"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
	File        *File  `json:"file,omitempty"`
}

// ---- sign-in and administration ----

type Session struct {
	ID         string `json:"id" db:"id"`
	TokenHash  string `json:"-" db:"token_hash"`
	UserID     string `json:"user_id" db:"user_id"`
	Stage      string `json:"stage" db:"stage"`
	IP         string `json:"ip,omitempty" db:"ip"`
	UserAgent  string `json:"user_agent,omitempty" db:"user_agent"`
	CreatedAt  int64  `json:"created_at" db:"created_at"`
	LastSeenAt int64  `json:"last_seen_at" db:"last_seen_at"`
	ExpiresAt  int64  `json:"expires_at" db:"expires_at"`
	RevokedAt  int64  `json:"revoked_at,omitempty" db:"revoked_at,null"`
}

type Identity struct {
	ID        string `json:"id" db:"id"`
	UserID    string `json:"user_id" db:"user_id"`
	Provider  string `json:"provider" db:"provider"`
	Subject   string `json:"-" db:"subject"`
	Email     string `json:"email,omitempty" db:"email"`
	CreatedAt int64  `json:"created_at" db:"created_at"`
}

type Passkey struct {
	ID           string          `json:"id" db:"id"`
	UserID       string          `json:"user_id" db:"user_id"`
	Name         string          `json:"name" db:"name"`
	CredentialID string          `json:"-" db:"credential_id"`
	Credential   json.RawMessage `json:"-" db:"credential,json"`
	CreatedAt    int64           `json:"created_at" db:"created_at"`
	LastUsedAt   int64           `json:"last_used_at,omitempty" db:"last_used_at,null"`
}

type RecoveryCode struct {
	ID        string `db:"id"`
	UserID    string `db:"user_id"`
	CodeHash  string `db:"code_hash"`
	CreatedAt int64  `db:"created_at"`
	UsedAt    int64  `db:"used_at,null"`
}

type Invite struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"workspace_id" db:"workspace_id"`
	Email       string `json:"email,omitempty" db:"email"`
	Role        Role   `json:"role" db:"role"`
	TokenHash   string `json:"-" db:"token_hash"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	ExpiresAt   int64  `json:"expires_at" db:"expires_at"`
	MaxUses     int    `json:"max_uses" db:"max_uses"`
	Uses        int    `json:"uses" db:"uses"`
	RevokedAt   int64  `json:"revoked_at,omitempty" db:"revoked_at,null"`
}

type OneTimeToken struct {
	ID        string          `db:"id"`
	Kind      string          `db:"kind"`
	TokenHash string          `db:"token_hash"`
	UserID    string          `db:"user_id,null"`
	Data      json.RawMessage `db:"data,json"`
	CreatedAt int64           `db:"created_at"`
	ExpiresAt int64           `db:"expires_at"`
	UsedAt    int64           `db:"used_at,null"`
}

type Setting struct {
	Name      string          `json:"name" db:"name"`
	Value     json.RawMessage `json:"value" db:"value,json"`
	UpdatedAt int64           `json:"updated_at" db:"updated_at"`
	UpdatedBy string          `json:"updated_by,omitempty" db:"updated_by,null"`
}

type AuditEntry struct {
	ID          string          `json:"id" db:"id"`
	At          int64           `json:"at" db:"at"`
	WorkspaceID string          `json:"workspace_id,omitempty" db:"workspace_id,null"`
	ActorID     string          `json:"actor_id,omitempty" db:"actor_id,null"`
	ActorName   string          `json:"actor_name,omitempty" db:"actor_name"`
	Action      string          `json:"action" db:"action"`
	TargetType  string          `json:"target_type,omitempty" db:"target_type"`
	TargetID    string          `json:"target_id,omitempty" db:"target_id"`
	IP          string          `json:"ip,omitempty" db:"ip"`
	UserAgent   string          `json:"user_agent,omitempty" db:"user_agent"`
	Data        json.RawMessage `json:"data,omitempty" db:"data,json"`
}

type PushSubscription struct {
	ID        string `json:"id" db:"id"`
	UserID    string `json:"user_id" db:"user_id"`
	Endpoint  string `json:"endpoint" db:"endpoint"`
	P256dh    string `json:"-" db:"p256dh"`
	Auth      string `json:"-" db:"auth"`
	UserAgent string `json:"user_agent,omitempty" db:"user_agent"`
	CreatedAt int64  `json:"created_at" db:"created_at"`
}

type OAuthClient struct {
	ID           string   `json:"client_id" db:"id"`
	Name         string   `json:"client_name" db:"name"`
	RedirectURIs []string `json:"redirect_uris" db:"redirect_uris,json"`
	CreatedAt    int64    `json:"created_at" db:"created_at"`
}

type Backup struct {
	ID         string `json:"id" db:"id"`
	StartedAt  int64  `json:"started_at" db:"started_at"`
	FinishedAt int64  `json:"finished_at,omitempty" db:"finished_at,null"`
	Location   string `json:"location,omitempty" db:"location"`
	Size       int64  `json:"size" db:"size"`
	SHA256     string `json:"sha256,omitempty" db:"sha256"`
	VerifiedAt int64  `json:"verified_at,omitempty" db:"verified_at,null"`
	Error      string `json:"error,omitempty" db:"error"`
}

// ---- wake-ups, oversight, integrations ----

type Webhook struct {
	ID          string   `json:"id" db:"id"`
	WorkspaceID string   `json:"-" db:"workspace_id"`
	Name        string   `json:"name" db:"name"`
	URL         string   `json:"url" db:"url"`
	Secret      string   `json:"-" db:"secret"`
	EventTypes  []string `json:"event_types,omitempty" db:"event_types,json"`
	ProjectID   string   `json:"project_id,omitempty" db:"project_id,null"`
	UserID      string   `json:"user_id,omitempty" db:"user_id,null"`
	Active      bool     `json:"active" db:"active"`
	Failures    int      `json:"failures" db:"failures"`
	LastStatus  string   `json:"last_status,omitempty" db:"last_status"`
	LastAt      int64    `json:"last_at,omitempty" db:"last_at,null"`
	CreatedBy   string   `json:"created_by" db:"created_by"`
	CreatedAt   int64    `json:"created_at" db:"created_at"`
	UpdatedSeq  int64    `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type WebhookDelivery struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	WebhookID   string `json:"webhook_id" db:"webhook_id"`
	Seq         int64  `json:"seq" db:"seq"`
	EventType   string `json:"event_type" db:"event_type"`
	State       string `json:"state" db:"state"`
	Attempts    int    `json:"attempts" db:"attempts"`
	StatusCode  int    `json:"status_code,omitempty" db:"status_code,null"`
	Error       string `json:"error,omitempty" db:"error"`
	DurationMS  int    `json:"duration_ms,omitempty" db:"duration_ms,null"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	NextAt      int64  `json:"next_at,omitempty" db:"next_at,null"`
	DoneAt      int64  `json:"done_at,omitempty" db:"done_at,null"`
}

// RuleMatch says which events a rule fires on. Empty fields match anything.
type RuleMatch struct {
	EventTypes []string `json:"event_types,omitempty"`
	ProjectID  string   `json:"project_id,omitempty"`
	ActorID    string   `json:"actor_id,omitempty"`
	ActorKind  string   `json:"actor_kind,omitempty"`
	// Outcome narrows decision.picked: as_is, with_changes, none, approved, declined.
	Outcome string `json:"outcome,omitempty"`
	// ToCategory narrows task.updated to a move into a status category.
	ToCategory string `json:"to_category,omitempty"`
	LabelID    string `json:"label_id,omitempty"`
}

// RuleAction says what a rule does.
type RuleAction struct {
	Kind      string `json:"kind"` // notify, webhook, assign, wait_on
	UserID    string `json:"user_id,omitempty"`
	WebhookID string `json:"webhook_id,omitempty"`
	Message   string `json:"message,omitempty"`
}

type Rule struct {
	ID          string      `json:"id" db:"id"`
	WorkspaceID string      `json:"-" db:"workspace_id"`
	Name        string      `json:"name" db:"name"`
	Active      bool        `json:"active" db:"active"`
	Match       *RuleMatch  `json:"match,omitempty" db:"match_on,json"`
	Action      *RuleAction `json:"action,omitempty" db:"action,json"`
	CreatedBy   string      `json:"created_by" db:"created_by"`
	CreatedAt   int64       `json:"created_at" db:"created_at"`
	UpdatedSeq  int64       `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64       `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type Job struct {
	ID           string          `json:"id" db:"id"`
	Kind         string          `json:"kind" db:"kind"`
	WorkspaceID  string          `json:"workspace_id,omitempty" db:"workspace_id,null"`
	Dedupe       string          `json:"dedupe,omitempty" db:"dedupe,null"`
	Payload      json.RawMessage `json:"payload,omitempty" db:"payload,json"`
	RunAt        int64           `json:"run_at" db:"run_at"`
	Attempts     int             `json:"attempts" db:"attempts"`
	ClaimedBy    string          `json:"claimed_by,omitempty" db:"claimed_by"`
	ClaimedUntil int64           `json:"claimed_until,omitempty" db:"claimed_until,null"`
	CreatedAt    int64           `json:"created_at" db:"created_at"`
	DoneAt       int64           `json:"done_at,omitempty" db:"done_at,null"`
	Error        string          `json:"error,omitempty" db:"error"`
}

// AgentSession is the record of one agent run.
type AgentSession struct {
	ID           string          `json:"id" db:"id"`
	WorkspaceID  string          `json:"-" db:"workspace_id"`
	AgentID      string          `json:"agent_id" db:"agent_id"`
	TaskID       string          `json:"task_id,omitempty" db:"task_id,null"`
	Title        string          `json:"title,omitempty" db:"title"`
	State        string          `json:"state" db:"state"`
	Summary      string          `json:"summary,omitempty" db:"summary"`
	Instructions string          `json:"instructions,omitempty" db:"instructions"`
	Steps        json.RawMessage `json:"steps,omitempty" db:"steps,json"`
	Links        json.RawMessage `json:"links,omitempty" db:"links,json"`
	CostMicros   int64           `json:"cost_micros,omitempty" db:"cost_micros"`
	TokensIn     int64           `json:"tokens_in,omitempty" db:"tokens_in"`
	TokensOut    int64           `json:"tokens_out,omitempty" db:"tokens_out"`
	StartedAt    int64           `json:"started_at" db:"started_at"`
	EndedAt      int64           `json:"ended_at,omitempty" db:"ended_at,null"`
	UpdatedSeq   int64           `json:"updated_seq" db:"updated_seq"`
}

type Resource struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	Name        string          `json:"name" db:"name"`
	Description string          `json:"description,omitempty" db:"description"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
	Claims      []ResourceClaim `json:"claims,omitempty"`
}

type ResourceClaim struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ResourceID  string `json:"resource_id" db:"resource_id"`
	UserID      string `json:"user_id" db:"user_id"`
	TaskID      string `json:"task_id,omitempty" db:"task_id,null"`
	Note        string `json:"note,omitempty" db:"note"`
	State       string `json:"state" db:"state"`
	RequestedAt int64  `json:"requested_at" db:"requested_at"`
	AcquiredAt  int64  `json:"acquired_at,omitempty" db:"acquired_at,null"`
	LeaseUntil  int64  `json:"lease_until,omitempty" db:"lease_until,null"`
	ReleasedAt  int64  `json:"released_at,omitempty" db:"released_at,null"`
}

type Integration struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	Kind        string          `json:"kind" db:"kind"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	Name        string          `json:"name,omitempty" db:"name"`
	Config      json.RawMessage `json:"config,omitempty" db:"config,json"`
	Secret      string          `json:"-" db:"secret"`
	State       json.RawMessage `json:"-" db:"state,json"`
	Active      bool            `json:"active" db:"active"`
	LastSyncAt  int64           `json:"last_sync_at,omitempty" db:"last_sync_at,null"`
	LastError   string          `json:"last_error,omitempty" db:"last_error"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
	HasSecret   bool            `json:"has_secret"`
}

// ---- docs ----

// Doc kinds.
const (
	DocPage     = "page"
	DocDatabase = "database"
	DocRow      = "row"
)

type Doc struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	ParentID    string          `json:"parent_id,omitempty" db:"parent_id,null"`
	Kind        string          `json:"kind" db:"kind"`
	Title       string          `json:"title" db:"title"`
	Icon        string          `json:"icon,omitempty" db:"icon"`
	Cover       string          `json:"cover,omitempty" db:"cover"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	OwnerID     string          `json:"owner_id,omitempty" db:"owner_id,null"`
	SharedWith  []string        `json:"shared_with,omitempty" db:"shared_with,json"`
	Generated   string          `json:"generated,omitempty" db:"generated"`
	MemoryOf    string          `json:"memory_of,omitempty" db:"memory_of,null"`
	Props       json.RawMessage `json:"props,omitempty" db:"props,json"`
	SourceID    string          `json:"source_id,omitempty" db:"source_id,null"`
	SourcePath  string          `json:"source_path,omitempty" db:"source_path"`
	SourceHash  string          `json:"-" db:"source_hash"`
	Rank        string          `json:"rank" db:"rank"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedBy   string          `json:"updated_by,omitempty" db:"updated_by,null"`
	UpdatedAt   int64           `json:"updated_at" db:"updated_at"`
	CreatedSeq  int64           `json:"created_seq" db:"created_seq"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	ContentSeq  int64           `json:"content_seq" db:"content_seq"`
	ArchivedAt  int64           `json:"archived_at,omitempty" db:"archived_at,null"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Block is one block of a page, in the editor's own shape.
type Block struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	DocID       string          `json:"doc_id" db:"doc_id"`
	ParentID    string          `json:"parent_id,omitempty" db:"parent_id,null"`
	Rank        string          `json:"rank" db:"rank"`
	Type        string          `json:"type" db:"type"`
	Props       json.RawMessage `json:"props,omitempty" db:"props,json"`
	Content     json.RawMessage `json:"content,omitempty" db:"content,json"`
	Plain       string          `json:"-" db:"plain"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	UpdatedBy   string          `json:"updated_by" db:"updated_by"`
	CreatedSeq  int64           `json:"created_seq" db:"created_seq"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type DocVersion struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	DocID       string          `json:"doc_id" db:"doc_id"`
	Seq         int64           `json:"seq" db:"seq"`
	Label       string          `json:"label,omitempty" db:"label"`
	Title       string          `json:"title" db:"title"`
	Snapshot    json.RawMessage `json:"snapshot,omitempty" db:"snapshot,json"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
}

type DBProperty struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	DatabaseID  string          `json:"database_id" db:"database_id"`
	Name        string          `json:"name" db:"name"`
	Type        string          `json:"type" db:"type"`
	Config      json.RawMessage `json:"config,omitempty" db:"config,json"`
	Rank        string          `json:"rank" db:"rank"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type DBView struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	DatabaseID  string          `json:"database_id" db:"database_id"`
	Name        string          `json:"name" db:"name"`
	Type        string          `json:"type" db:"type"`
	Config      json.RawMessage `json:"config,omitempty" db:"config,json"`
	Rank        string          `json:"rank" db:"rank"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

type DocSource struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	RootDocID   string `json:"root_doc_id" db:"root_doc_id"`
	Repo        string `json:"repo" db:"repo"`
	Branch      string `json:"branch,omitempty" db:"branch"`
	Subdir      string `json:"subdir,omitempty" db:"subdir"`
	Authority   string `json:"authority" db:"authority"`
	WriteMode   string `json:"write_mode" db:"write_mode"`
	LastCommit  string `json:"last_commit,omitempty" db:"last_commit"`
	LastSyncAt  int64  `json:"last_sync_at,omitempty" db:"last_sync_at,null"`
	LastError   string `json:"last_error,omitempty" db:"last_error"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// TaskLabel links a task to a label; kept beside tasks.label_ids for filters.
type TaskLabel struct {
	TaskID      string `db:"task_id"`
	LabelID     string `db:"label_id"`
	WorkspaceID string `db:"workspace_id"`
}

type RateCounter struct {
	Name   string `db:"name"`
	Bucket int64  `db:"bucket"`
	Hits   int    `db:"hits"`
}

// Secret is one entry of the vault: a key or a password that agents can use
// but never read. The server puts it into requests it makes on their behalf,
// only to the hosts it is bound to.
type Secret struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	Name        string `json:"name" db:"name"`
	Description string `json:"description,omitempty" db:"description"`
	Value       string `json:"-" db:"value"` // sealed
	// Hosts are the hosts a request with this secret may go to, as
	// "api.example.com", "*.example.com", or with "http://" in front for a
	// host reached without TLS.
	Hosts []string `json:"hosts,omitempty" db:"hosts,json"`
	// Agents are the agents that may use it; empty means every member.
	Agents []string `json:"agents,omitempty" db:"agents,json"`
	// Env lets the companion on an agent's machine receive the value, to put
	// in the environment of the command it runs.
	Env        bool   `json:"env" db:"env"`
	CreatedBy  string `json:"created_by" db:"created_by"`
	CreatedAt  int64  `json:"created_at" db:"created_at"`
	UpdatedAt  int64  `json:"updated_at" db:"updated_at"`
	UpdatedSeq int64  `json:"updated_seq" db:"updated_seq"`
	LastUsedAt int64  `json:"last_used_at,omitempty" db:"last_used_at,null"`
	DeletedAt  int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Presence is one member with a page open, and the block they are in.
// TaskKey is a key a task had before it moved to another project.
type TaskKey struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	Key         string `json:"key" db:"key"`
	TaskID      string `json:"task_id" db:"task_id"`
	At          int64  `json:"at" db:"at"`
}

type Presence struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	DocID       string `json:"-" db:"doc_id"`
	UserID      string `json:"user_id" db:"user_id"`
	Block       string `json:"block,omitempty" db:"block"`
	At          int64  `json:"at" db:"at"`
}
