// Wake-ups, oversight and integrations: webhooks and their deliveries,
// rules, jobs, agent sessions, resources, integrations and secrets.

package core

import "encoding/json"

// Webhook delivery states.
const (
	DeliveryPending = "pending" // waiting to be sent, or sent again
	DeliveryOK      = "ok"      // the receiver took it
	DeliveryDead    = "dead"    // given up on
)

// Resource claim states.
const (
	ClaimWaiting  = "waiting"  // in the queue for the resource
	ClaimHolding  = "holding"  // has it, until its lease ends
	ClaimReleased = "released" // let go of it, or its lease ran out
)

// Agent session states. Any state but running ends the session.
const (
	AgentSessionRunning = "running"
	AgentSessionDone    = "done"
	AgentSessionFailed  = "failed"
	AgentSessionStopped = "stopped"
)

// Rule action kinds.
const (
	RuleNotify  = "notify"
	RuleWebhook = "webhook"
	RuleAssign  = "assign"
	RuleWaitOn  = "wait_on"
)

// Webhook sends a workspace's events to a URL, signed with its secret.
type Webhook struct {
	ID          string   `json:"id" db:"id"`
	WorkspaceID string   `json:"-" db:"workspace_id"`
	Name        string   `json:"name" db:"name"`
	URL         string   `json:"url" db:"url"`
	Secret      string   `json:"-" db:"secret"`
	EventTypes  []string `json:"event_types,omitempty" db:"event_types,json"` // empty: every type
	ProjectID   string   `json:"project_id,omitempty" db:"project_id,null"`   // empty: every project
	UserID      string   `json:"user_id,omitempty" db:"user_id,null"`         // set: it carries only this member's inbox items
	Active      bool     `json:"active" db:"active"`
	Failures    int      `json:"failures" db:"failures"` // in a row, since the last delivery that went through
	LastStatus  string   `json:"last_status,omitempty" db:"last_status"`
	LastAt      int64    `json:"last_at,omitempty" db:"last_at,null"`
	CreatedBy   string   `json:"created_by" db:"created_by"`
	CreatedAt   int64    `json:"created_at" db:"created_at"`
	UpdatedSeq  int64    `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// WebhookDelivery is one event on its way to one webhook.
type WebhookDelivery struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	WebhookID   string `json:"webhook_id" db:"webhook_id"`
	Seq         int64  `json:"seq" db:"seq"`
	EventType   string `json:"event_type" db:"event_type"`
	State       string `json:"state" db:"state"` // one of the Delivery* states
	Attempts    int    `json:"attempts" db:"attempts"`
	StatusCode  int    `json:"status_code,omitempty" db:"status_code,null"`
	Error       string `json:"error,omitempty" db:"error"`
	DurationMS  int    `json:"duration_ms,omitempty" db:"duration_ms,null"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	NextAt      int64  `json:"next_at,omitempty" db:"next_at,null"` // when it is tried next
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
	Kind      string `json:"kind"` // one of the Rule* action kinds
	UserID    string `json:"user_id,omitempty"`
	WebhookID string `json:"webhook_id,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Rule does something when an event matches: notify, call a webhook,
// assign or wait on someone.
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

// Job is a piece of background work, claimed by one runner at a time.
type Job struct {
	ID           string          `json:"id" db:"id"`
	Kind         string          `json:"kind" db:"kind"`
	WorkspaceID  string          `json:"workspace_id,omitempty" db:"workspace_id,null"`
	Dedupe       string          `json:"dedupe,omitempty" db:"dedupe,null"` // a job with the same name already queued is not queued again
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
	State        string          `json:"state" db:"state"` // one of the AgentSession* states
	Summary      string          `json:"summary,omitempty" db:"summary"`
	Instructions string          `json:"instructions,omitempty" db:"instructions"`
	Steps        json.RawMessage `json:"steps,omitempty" db:"steps,json"`
	Links        json.RawMessage `json:"links,omitempty" db:"links,json"`
	StartedAt    int64           `json:"started_at" db:"started_at"`
	EndedAt      int64           `json:"ended_at,omitempty" db:"ended_at,null"`
	UpdatedSeq   int64           `json:"updated_seq" db:"updated_seq"`
}

// Resource is something only one member may use at a time (a device, a
// deploy slot), with the claims on it.
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

// ResourceClaim is a member's place in the queue for a resource, or their
// hold on it.
type ResourceClaim struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	ResourceID  string `json:"resource_id" db:"resource_id"`
	UserID      string `json:"user_id" db:"user_id"`
	TaskID      string `json:"task_id,omitempty" db:"task_id,null"`
	Note        string `json:"note,omitempty" db:"note"`
	State       string `json:"state" db:"state"` // one of the Claim* states
	RequestedAt int64  `json:"requested_at" db:"requested_at"`
	AcquiredAt  int64  `json:"acquired_at,omitempty" db:"acquired_at,null"`
	LeaseUntil  int64  `json:"lease_until,omitempty" db:"lease_until,null"`
	ReleasedAt  int64  `json:"released_at,omitempty" db:"released_at,null"`
}

// Integration connects a workspace, or one project, to another service.
type Integration struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	Kind        string          `json:"kind" db:"kind"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	Name        string          `json:"name,omitempty" db:"name"`
	Config      json.RawMessage `json:"config,omitempty" db:"config,json"`
	Secret      string          `json:"-" db:"secret"`
	State       json.RawMessage `json:"-" db:"state,json"` // what the integration keeps between syncs
	Active      bool            `json:"active" db:"active"`
	LastSyncAt  int64           `json:"last_sync_at,omitempty" db:"last_sync_at,null"`
	LastError   string          `json:"last_error,omitempty" db:"last_error"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
	HasSecret   bool            `json:"has_secret"` // filled when read; not a column
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
