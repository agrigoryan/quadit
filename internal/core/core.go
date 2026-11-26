// Package core holds the product's own terms: the things people and agents
// work with, as they are stored, sent in events and returned by the API.
//
// Ids are UUIDv7 strings; an empty string means "none". Times are Unix
// milliseconds; zero means "not set". Dates are "YYYY-MM-DD".
//
// The db tag names the column a field is stored in. ",null" stores the zero
// value as NULL; ",json" stores the field as JSON. A pointer is stored as
// NULL when nil: the way a column keeps its zero apart from none.
//
// "Page" is the word in prose, in the web app and in handler names; "Doc"
// is the word in types, tables and change names. They are the same thing.
//
// A state or a kind that code compares against has a named constant here,
// beside the type whose column holds it.
//
// How the package is laid out:
//
//	core.go     roles, users, members, tokens, projects, statuses, labels,
//	            tasks, relations, comments, decisions, events, cursors and
//	            listeners
//	tasks.go    what organizes tasks: epics, milestones, cycles, views, links
//	            to code, mentions, templates, preferences, old keys
//	estimates.go the scales a project estimates on, and a task's points
//	inbox.go    watchers and notifications
//	files.go    files and attachments
//	pages.go    pages (Doc), blocks, versions, databases, repository sources,
//	            presence
//	agents.go   webhooks, rules, jobs, agent sessions, resources,
//	            integrations, secrets
//	signin.go   sessions, identities, passkeys, invites, one-time tokens,
//	            settings, the audit log, push, OAuth clients, backups
package core

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
)

// Role is what a member may do in a workspace. A role is a ceiling: an
// agent's scope can only narrow it.
type Role string

// The roles, from the most to the least.
const (
	RoleOwner  Role = "owner"  // people only
	RoleAdmin  Role = "admin"  // manages members, agents, projects, settings
	RoleMember Role = "member" // works on tasks, decisions and comments
)

// AtLeast reports whether r grants everything floor does.
func (r Role) AtLeast(floor Role) bool { return roleLevel[r] >= roleLevel[floor] && roleLevel[r] > 0 }

var roleLevel = map[Role]int{RoleMember: 1, RoleAdmin: 2, RoleOwner: 3}

// Kinds of user.
const (
	KindPerson = "person"
	KindAgent  = "agent"
)

// Status categories are fixed; names, colors and order belong to the team.
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
func ValidCategory(c string) bool { return slices.Contains(Categories, c) }

// OpenCategory reports whether a task in this category is still open.
func OpenCategory(c string) bool { return c != CatDone && c != CatCanceled }

// Workspace is one team's space: its members, projects, tasks and pages.
type Workspace struct {
	ID            string          `json:"id" db:"id"`
	Slug          string          `json:"slug" db:"slug"`
	Name          string          `json:"name" db:"name"`
	Icon          string          `json:"icon,omitempty" db:"icon"`
	Seq           int64           `json:"seq" db:"seq"`          // the last event's number
	DispatchedSeq int64           `json:"-" db:"dispatched_seq"` // the last event handed to webhooks and rules
	Settings      json.RawMessage `json:"settings,omitempty" db:"settings,json"`
	CreatedAt     int64           `json:"created_at" db:"created_at"`
	UpdatedAt     int64           `json:"-" db:"updated_at"`
	DeletedAt     int64           `json:"-" db:"deleted_at,null"`
}

// User is a person or an agent.
type User struct {
	ID            string          `json:"id" db:"id"`
	Kind          string          `json:"kind" db:"kind"` // KindPerson or KindAgent
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
	IsAdmin       bool            `json:"is_admin,omitempty" db:"is_admin"` // runs the install
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
	// Projects lists the project ids it may work in; nil means all. It is
	// never empty but not nil (JSON leaves [] out): none is engine.NoProjects().
	Projects []string `json:"projects,omitempty"`
	ReadOnly bool     `json:"read_only,omitempty"`
	// NeedsApproval lists the change types it must get approved first.
	NeedsApproval []string `json:"needs_approval,omitempty"`
}

// MayRead reports whether a member with this scope may read a project. No
// scope, or one that names no projects, lets in every project; what belongs
// to no project ("") is the workspace's, open to every member.
func (s *Scope) MayRead(projectID string) bool {
	return s == nil || len(s.Projects) == 0 || projectID == "" || slices.Contains(s.Projects, projectID)
}

// Member is a user's place in one workspace.
type Member struct {
	WorkspaceID string `json:"workspace_id" db:"workspace_id"`
	UserID      string `json:"user_id" db:"user_id"`
	Role        Role   `json:"role" db:"role"`
	Handle      string `json:"handle" db:"handle"`
	Kind        string `json:"kind" db:"kind"`
	Name        string `json:"name" db:"name"`
	Avatar      string `json:"avatar,omitempty" db:"avatar"`
	// Tint is the color the member's initials are drawn on, 1 to
	// MemberTints, chosen when the member is made and kept.
	Tint  int    `json:"tint,omitempty" db:"tint,null"`
	Title string `json:"title,omitempty" db:"title"`
	Scope *Scope `json:"scope,omitempty" db:"scope,json"`
	// HandoffLimit is how many times an agent may pass work on to another
	// agent in a week (Monday to Monday, UTC); 0 is no limit.
	HandoffLimit int    `json:"handoff_limit,omitempty" db:"handoff_limit,null"`
	LastSeenAt   int64  `json:"last_seen_at,omitempty" db:"last_seen_at,null"`
	LastAction   string `json:"last_action,omitempty" db:"last_action"`
	// ListeningUntil is when the last of the leases of the member's
	// listeners ends (Listener.LeaseUntil): the member counts as listening,
	// to something, until then. It is written with the lease.
	ListeningUntil int64 `json:"listening_until,omitempty" db:"listening_until,null"`
	// ConnectedAt is when an agent first proved it reached Quadit from
	// inside its tool: a connect code given back, a change made with its
	// own credential, or its listener's first lease. A read proves nothing.
	ConnectedAt int64 `json:"connected_at,omitempty" db:"connected_at,null"`
	CreatedAt   int64 `json:"created_at" db:"created_at"`
	UpdatedSeq  int64 `json:"updated_seq" db:"updated_seq"`
	SuspendedAt int64 `json:"suspended_at,omitempty" db:"suspended_at,null"`
	// DelegatedBy and DelegatedTask mark a sub-agent: the agent that made
	// it and the task it was made for. It ends when that task does.
	DelegatedBy   string `json:"delegated_by,omitempty" db:"delegated_by,null"`
	DelegatedTask string `json:"delegated_task,omitempty" db:"delegated_task,null"`
	RemovedAt     int64  `json:"removed_at,omitempty" db:"removed_at,null"`
	// ResponsibleID is the person who answers for an agent. It is kept on
	// the user and filled in when members are read.
	ResponsibleID string `json:"responsible_id,omitempty"`
	// Email is the person's address, filled in only for admins who list
	// members (an import matches people by it). It is not a column here.
	Email string `json:"email,omitempty"`
}

// API token kinds.
const (
	TokenAPI   = "token" // made by a member or an admin
	TokenOAuth = "oauth" // issued to an app through the server's own OAuth
)

// APIToken is a credential for the API, held by a member of one workspace.
type APIToken struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"workspace_id" db:"workspace_id"`
	UserID      string `json:"user_id" db:"user_id"`
	Name        string `json:"name" db:"name"`
	TokenHash   string `json:"-" db:"token_hash"`
	Prefix      string `json:"prefix" db:"prefix"`           // the start of the token, to tell it apart
	Scopes      string `json:"scopes,omitempty" db:"scopes"` // space-separated; empty: all the member may do
	Kind        string `json:"kind" db:"kind"`               // TokenAPI or TokenOAuth
	ClientID    string `json:"client_id,omitempty" db:"client_id"`
	RefreshHash string `json:"-" db:"refresh_hash,null"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	ExpiresAt   int64  `json:"expires_at,omitempty" db:"expires_at,null"`
	LastUsedAt  int64  `json:"last_used_at,omitempty" db:"last_used_at,null"`
	RevokedAt   int64  `json:"revoked_at,omitempty" db:"revoked_at,null"`
}

// ConnectCode is a code a person makes for one agent and one tool, which
// the agent gives back from inside that tool to prove it reached Quadit
// from there. Only its hash is kept; it is good once, until ExpiresAt.
type ConnectCode struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	AgentID     string `json:"agent_id" db:"agent_id"`
	Tool        string `json:"tool" db:"tool"` // the tool's name as the person sees it ("Codex")
	CodeHash    string `json:"-" db:"code_hash"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	ExpiresAt   int64  `json:"expires_at" db:"expires_at"`
	UsedAt      int64  `json:"used_at,omitempty" db:"used_at,null"`
}

// MemberTints is how many colors members' initials are drawn on; the web
// app has one tint for each.
const MemberTints = 8

// ListenCursor is the cursor an agent's inbox is delivered from, by `quadit
// wait` and `quadit listen`, when they listen to everything; one session at
// a time holds its lease. A listener of one project delivers from a cursor
// of its own (ListenCursorOf).
const ListenCursor = "listen"

// ListenCursorOf is the cursor the listener of a project (by id) delivers
// from; for "", the listener of everything, ListenCursor.
func ListenCursorOf(projectID string) string {
	if projectID == "" {
		return ListenCursor
	}
	return ListenCursor + ":" + projectID
}

// ListenCursorProject is the project whose listener delivers from the
// cursor of that name, when it is one (ListenCursorOf).
func ListenCursorProject(name string) (projectID string, ok bool) {
	return strings.CutPrefix(name, ListenCursor+":")
}

// Listener is the hold one session has on delivering an agent's inbox, in
// one scope: the items of one project (ProjectID), or, with no project,
// everything else. One session at a time holds a listener's lease; while
// it lives (LeaseUntil) the agent listens in that scope. A project's row
// stays when its session stops, so that the project keeps waiting for its
// next listener instead of falling to the listener of everything, until
// the agent forgets it. The lease is no one else's business, so it is not
// in what others read.
type Listener struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	AgentID     string `json:"agent_id" db:"agent_id"`
	ProjectID   string `json:"project_id,omitempty" db:"project_id,null"`
	Lease       string `json:"-" db:"lease"`
	LeaseUntil  int64  `json:"lease_until" db:"lease_until"`
	HeardAt     int64  `json:"heard_at" db:"heard_at"` // when its session last waited
	// HeldBy is what holds the lease, in words a person reads ("a chat",
	// "a companion", "the Quadit app"), as the holder said.
	HeldBy string `json:"held_by,omitempty" db:"held_by"`
	// HandedSeq is the feed position of the last item a session of this
	// listener was handed: past its cursor, it is in hand, not yet
	// acknowledged.
	HandedSeq int64 `json:"-" db:"handed_seq"`

	// What a runner says of itself when it holds this listener
	// (agent-runs-contract.md §4.1). Set by a hold that names a machine;
	// kept when another session holds the lease; cleared only by a release.
	// A listener whose MachineID is set is a runner listener.
	MachineID         string `json:"-" db:"machine_id,null"`
	MachineName       string `json:"-" db:"machine_name"`
	RunnerFolder      string `json:"-" db:"runner_folder"`
	RunnerProgram     string `json:"-" db:"runner_program"`
	RunnerVersion     string `json:"-" db:"runner_version"` // the program's version, "2.1.331"
	RunnerPaused      string `json:"-" db:"runner_paused"`  // one of the core.Pause* reasons, "" when not paused
	RunnerPausedUntil int64  `json:"-" db:"runner_paused_until,null"`
	RunnerSeenAt      int64  `json:"-" db:"runner_seen_at,null"` // the runner's last hold
	// RunnerHolds is whether the lease is the runner's: set by a hold that
	// names the machine, cleared by any other hold (a chat taking over).
	RunnerHolds bool `json:"-" db:"runner_holds"`
	// RunnerBeganSeq is the feed's position when the listener gained a
	// runner where it had none (0: it has none, or gained it before this was
	// kept). An item at or before it starts a run only if it still waits on
	// the agent (agent-runs-contract.md, "The runner takes what waits").
	// Cleared with the mark.
	RunnerBeganSeq int64 `json:"-" db:"runner_began_seq"`
}

// LeaseLives reports whether the listener's lease lives at now (Unix ms):
// while it does, its session holds the listener and another is refused.
func (l Listener) LeaseLives(now int64) bool {
	return l.Lease != "" && l.LeaseUntil > now
}

// HeldByRunner reports whether Quadit's runner holds the listener at now
// (Unix ms): its lease lives and was last taken by the runner, not a chat.
func (l Listener) HeldByRunner(now int64) bool {
	return l.LeaseLives(now) && l.RunnerHolds
}

// ListenerLabel is the form of what a listener says it is (by=, "the
// Quadit app"): a few plain words, at most 40 letters, digits, spaces, -
// and '. The server keeps only such a label, and the command prints only
// such a label.
var ListenerLabel = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} '-]{0,39}$`)

// ProjectSettings are a project's switches. What they mean for estimates
// is read through the methods in estimates.go.
type ProjectSettings struct {
	Cycles     bool `json:"cycles,omitempty"`
	CycleDays  int  `json:"cycle_days,omitempty"`
	CycleStart int  `json:"cycle_start,omitempty"` // weekday the cycle starts on, 0 = Sunday
	// Estimates: the project estimates its tasks, on EstimateScale (one of
	// EstimateScales; "" is points). The three options after it are kept
	// while estimates are off, for when they are on again.
	Estimates     bool   `json:"estimates,omitempty"`
	EstimateScale string `json:"estimate_scale,omitempty"`
	// EstimateExtended adds the scale's two further values.
	EstimateExtended bool `json:"estimate_extended,omitempty"`
	// EstimateZero makes 0 an estimate of its own, apart from none.
	EstimateZero bool `json:"estimate_zero,omitempty"`
	// EstimateIgnoreUnestimated counts a task without an estimate as 0
	// points, not 1.
	EstimateIgnoreUnestimated bool `json:"estimate_ignore_unestimated,omitempty"`
}

// Project holds tasks under one key (SVA), with its own workflow.
type Project struct {
	ID          string           `json:"id" db:"id"`
	WorkspaceID string           `json:"workspace_id" db:"workspace_id"`
	Key         string           `json:"key" db:"key"`
	Name        string           `json:"name" db:"name"`
	Description string           `json:"description,omitempty" db:"description"`
	Icon        string           `json:"icon,omitempty" db:"icon"`
	Color       string           `json:"color,omitempty" db:"color"`
	LeadID      string           `json:"lead_id,omitempty" db:"lead_id,null"`
	Rank        string           `json:"rank,omitempty" db:"rank"`
	Settings    *ProjectSettings `json:"settings,omitempty" db:"settings,json"`
	// Samples are the ids of the sample tasks the project was made with
	// (samples.add), in order; empty for any other project. They are how
	// the samples are found again, whatever has been done to them since.
	Samples      []string `json:"samples,omitempty" db:"samples,json"`
	TaskCounter  int      `json:"-" db:"task_counter"`  // the last task number given
	CycleCounter int      `json:"-" db:"cycle_counter"` // the last cycle number given
	CreatedBy    string   `json:"created_by" db:"created_by"`
	CreatedAt    int64    `json:"created_at" db:"created_at"`
	UpdatedAt    int64    `json:"-" db:"updated_at"`
	CreatedSeq   int64    `json:"-" db:"created_seq"`
	UpdatedSeq   int64    `json:"updated_seq" db:"updated_seq"`
	ArchivedAt   int64    `json:"archived_at,omitempty" db:"archived_at,null"`
	DeletedAt    int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Status is one step of a project's workflow, in one of the fixed
// categories.
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

// Label is a tag on tasks, of one project or of the whole workspace.
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

// Task is one piece of work in a project.
type Task struct {
	ID            string `json:"id" db:"id"`
	WorkspaceID   string `json:"-" db:"workspace_id"`
	ProjectID     string `json:"project_id" db:"project_id"`
	Number        int    `json:"number" db:"number"`
	Key           string `json:"key" db:"key"` // project key + number, e.g. SVA-12
	Title         string `json:"title" db:"title"`
	Description   string `json:"description,omitempty" db:"description"`
	StatusID      string `json:"status_id" db:"status_id"`
	Priority      int    `json:"priority" db:"priority"` // 0 none, 1 urgent … 4 low
	AssigneeID    string `json:"assignee_id,omitempty" db:"assignee_id,null"`
	WaitingOnID   string `json:"waiting_on_id,omitempty" db:"waiting_on_id,null"`
	WaitingOnNote string `json:"waiting_on_note,omitempty" db:"waiting_on_note"`
	// WaitingOutside: the next move is no member's but an outside event's,
	// which the note describes.
	WaitingOutside bool `json:"waiting_outside,omitempty" db:"waiting_outside"`
	// AskedBy is the person an agent works this task for: whoever gave it
	// to an agent. Agents work on the task with no more access than theirs.
	AskedBy     string `json:"asked_by,omitempty" db:"asked_by,null"`
	ParentID    string `json:"parent_id,omitempty" db:"parent_id,null"`
	EpicID      string `json:"epic_id,omitempty" db:"epic_id,null"`
	MilestoneID string `json:"milestone_id,omitempty" db:"milestone_id,null"`
	CycleID     string `json:"cycle_id,omitempty" db:"cycle_id,null"`
	// Estimate is in points; nil is none, which is not the same as 0.
	Estimate      *int     `json:"estimate,omitempty" db:"estimate"`
	LabelIDs      []string `json:"label_ids,omitempty" db:"label_ids,json"`
	LeaseHolderID string   `json:"lease_holder_id,omitempty" db:"lease_holder_id,null"` // who has taken it
	LeaseUntil    int64    `json:"lease_until,omitempty" db:"lease_until,null"`         // until when they hold it
	// HandoffLimit is how many times the task may be passed from agent to
	// agent in all; 0 is no limit.
	HandoffLimit int    `json:"handoff_limit,omitempty" db:"handoff_limit,null"`
	Rank         string `json:"rank" db:"rank"`
	DueOn        string `json:"due_on,omitempty" db:"due_on,null"`
	CreatedBy    string `json:"created_by" db:"created_by"`
	CreatedAt    int64  `json:"created_at" db:"created_at"`
	UpdatedAt    int64  `json:"updated_at" db:"updated_at"`
	StartedAt    int64  `json:"started_at,omitempty" db:"started_at,null"`
	CompletedAt  int64  `json:"completed_at,omitempty" db:"completed_at,null"`
	CanceledAt   int64  `json:"canceled_at,omitempty" db:"canceled_at,null"`
	CreatedSeq   int64  `json:"created_seq" db:"created_seq"`
	UpdatedSeq   int64  `json:"updated_seq" db:"updated_seq"`
	ActivitySeq  int64  `json:"activity_seq" db:"activity_seq"` // the last event on it or on what is in it
	ArchivedAt   int64  `json:"archived_at,omitempty" db:"archived_at,null"`
	DeletedAt    int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
	DeletedBy    string `json:"-" db:"deleted_by,null"`
}

// Relation types. One row per pair; the reverse name is derived when read.
const (
	RelBlocks     = "blocks"
	RelRelates    = "relates"
	RelDuplicates = "duplicates"
)

// Relation ties two tasks: one blocks, relates to or duplicates the other.
// Given to someone who may read only one of the two, it has the other's id
// empty: the task is related to one they cannot see.
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

// Comment kinds.
const (
	CommentPlain  = "comment"
	CommentResult = "result" // the report of what was done, with its evidence
)

// Comment is a comment on a task, a decision or a page.
type Comment struct {
	ID          string    `json:"id" db:"id"`
	WorkspaceID string    `json:"-" db:"workspace_id"`
	TaskID      string    `json:"task_id,omitempty" db:"task_id,null"`
	DocID       string    `json:"doc_id,omitempty" db:"doc_id,null"`
	SubjectType string    `json:"subject_type" db:"subject_type"`
	SubjectID   string    `json:"subject_id" db:"subject_id"`
	Kind        string    `json:"kind" db:"kind"` // CommentPlain or CommentResult
	Evidence    *Evidence `json:"evidence,omitempty" db:"evidence,json"`
	ResolvedAt  int64     `json:"resolved_at,omitempty" db:"resolved_at,null"`
	ParentID    string    `json:"parent_id,omitempty" db:"parent_id,null"`
	AuthorID    string    `json:"author_id" db:"author_id"`
	Body        string    `json:"body" db:"body"`
	// Quote is the words of a page a thread was started on, which carry
	// its marker in the page's text (internal/md, comments.go). DetachedAt
	// is when an edit took those words out of the page: the thread then
	// stands for the page as a whole (SubjectType "doc"), and an edit that
	// brings the marker back (an undo) puts it on its words again.
	Quote      string `json:"quote,omitempty" db:"quote,null"`
	DetachedAt int64  `json:"detached_at,omitempty" db:"detached_at,null"`
	// SessionID is the run whose program's final message this comment is,
	// posted by the runner when the agent wrote nothing on the task itself.
	SessionID  string `json:"session_id,omitempty" db:"session_id,null"`
	CreatedAt  int64  `json:"created_at" db:"created_at"`
	EditedAt   int64  `json:"edited_at,omitempty" db:"edited_at,null"`
	CreatedSeq int64  `json:"created_seq" db:"created_seq"`
	UpdatedSeq int64  `json:"updated_seq" db:"updated_seq"`
	DeletedAt  int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Decision kinds, states and outcomes.
const (
	DecisionChoice   = "choice"
	DecisionApproval = "approval"

	StateOpen     = "open"
	StatePicked   = "picked"
	StateSentBack = "sent_back"
	// StateNotNeeded is a question settled without an answer: closed by
	// someone (decision.close), by its task closing, or by its asker moving
	// on from an answer sent back to them. It waits on nobody.
	StateNotNeeded = "not_needed"

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
	// ApproverProjects are the projects the one who approved a change could
	// reach when they did, through their membership and the credential they
	// answered with; empty is every project. The change is held to them.
	// nil on an answered approval is one given before this was kept: how
	// far it reaches is unknown, so it is not used.
	ApproverProjects []string `json:"-" db:"approver_projects,json"`
	Rank             string   `json:"rank" db:"rank"`
	CreatedBy        string   `json:"created_by" db:"created_by"`
	CreatedAt        int64    `json:"created_at" db:"created_at"`
	UpdatedAt        int64    `json:"updated_at" db:"updated_at"`
	CreatedSeq       int64    `json:"-" db:"created_seq"`
	UpdatedSeq       int64    `json:"updated_seq" db:"updated_seq"`
	DeletedAt        int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
	Options          []Option `json:"options,omitempty"`
}

// Option is one answer a decision offers.
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

// EventData is an event's data: what the web app, agents and integrations
// read to follow a change. Most events carry a new Row, or the ID of the
// row and its Changes; the other fields are facts some events add. A field
// left at its zero value is not written, except where a pointer is set: the
// events that write those keys write them even when empty. The fields are
// in the order of their keys, which is the order they have always been
// written in.
type EventData struct {
	// Appended are items added to the end of a list field of the row, by
	// field ("steps", "links"): a reader appends them to its copy.
	Appended    map[string][]json.RawMessage `json:"appended,omitempty"`
	Attachments []Attachment                 `json:"attachments,omitempty"` // the files a new comment or decision came with
	// Blocks are the blocks a new page came with (set only when it has
	// some), or those an edit wrote (set always: null when none).
	Blocks  *[]Block               `json:"blocks,omitempty"`
	Changes map[string]FieldChange `json:"changes,omitempty"`
	// Deleted is a key with two meanings, so it has no one type: true on a
	// task.updated that put the task in the trash, and on doc.edited the
	// ids of the blocks taken out ([]string, null when none).
	Deleted       any      `json:"deleted,omitempty"`
	FromBackup    bool     `json:"from_backup,omitempty"`     // a restore from a backup brought it back
	FromProjectID string   `json:"from_project_id,omitempty"` // a moved task's project before
	Gone          bool     `json:"gone,omitempty"`            // the row was removed outright, or is no longer the reader's to see
	ID            string   `json:"id,omitempty"`
	IDs           []string `json:"ids,omitempty"` // the rows one change touched together
	// Key is the key of the task the event is in, or of a project deleted.
	// The events about a comment or a session write it also when there is
	// no task: as "".
	Key       *string `json:"key,omitempty"`
	LinkKind  string  `json:"kind,omitempty"`
	MovedFrom string  `json:"moved_from,omitempty"` // a moved task's key before
	Name      string  `json:"name,omitempty"`       // a deleted secret's name
	OtherID   string  `json:"other_id,omitempty"`   // on task.related: the id of the task at the other end, the relation's task_id
	OtherKey  string  `json:"other_key,omitempty"`  // the key of the task at the other end of a relation
	Previous  *Answer `json:"previous,omitempty"`   // a decision's answer before it was marked unclear
	// Quiet marks history brought in (an import), not done now: it notifies
	// nobody and sets off nothing. The engine sets it on every event of a
	// quiet change.
	Quiet      bool    `json:"quiet,omitempty"`
	Reason     string  `json:"reason,omitempty"` // why the engine changed a member
	LinkRef    *string `json:"ref,omitempty"`    // an updated link's ref, written even when it has none
	Relation   string  `json:"relation,omitempty"`
	Removed    *bool   `json:"removed,omitempty"`  // on task.related: the relation was taken away, not added
	Resource   string  `json:"resource,omitempty"` // the name of the resource a new hold is on
	ResourceID string  `json:"resource_id,omitempty"`
	Restored   bool    `json:"restored,omitempty"`
	RevertedTo string  `json:"reverted_to,omitempty"` // the version a page was put back to
	Rolled     *int    `json:"rolled,omitempty"`      // how many open tasks a closed cycle passed on
	RolledOver bool    `json:"rolled_over,omitempty"` // the task was passed on to the next cycle
	// Row is the whole row, for an event that makes or brings one back.
	// Written, it is the row itself; read with Payload, it is the JSON as
	// written (a json.RawMessage), for ReadRow.
	Row          any     `json:"row,omitempty"`
	Rule         string  `json:"rule,omitempty"` // the rule that caused the change; the engine sets it
	Slug         string  `json:"slug,omitempty"`
	TaskID       *string `json:"task_id,omitempty"` // on claim.updated: the task the hold is for, or ""
	RelationType string  `json:"type,omitempty"`
	// Undoes is the id of the earlier change this one takes back (the web
	// app's Cmd+Z): the pair left things as they were. The engine sets it
	// on every event of a change that names one.
	Undoes string `json:"undoes,omitempty"`
	UserID string `json:"user_id,omitempty"`
	Why    string `json:"why,omitempty"` // what happened to a hold: acquired, renewed, released, expired
}

// Answer is the answer a decision had.
type Answer struct {
	DecidedBy      string `json:"decided_by"`
	Outcome        string `json:"outcome"`
	OutcomeNote    string `json:"outcome_note"`
	PickedOptionID string `json:"picked_option_id"`
}

// Payload reads the event's data. A key that does not read as its field's
// type is left at the zero value and reported in the error, the rest is
// read; data that is not JSON reads as nothing.
func (ev Event) Payload() (EventData, error) {
	var row json.RawMessage
	// Decoding into an interface that holds a pointer fills what it points
	// to: the row stays as written, for ReadRow to decode into its type.
	d := EventData{Row: &row}
	err := json.Unmarshal(ev.Data, &d)
	d.Row = nil
	if len(row) > 0 {
		d.Row = row
	}
	return d, err
}

// ReadRow decodes the row of data read with Payload into dst, and reports
// whether there was one that reads as dst.
func (d EventData) ReadRow(dst any) bool {
	raw, ok := d.Row.(json.RawMessage)
	return ok && json.Unmarshal(raw, dst) == nil
}

// Sets reports whether the event gave a field a value: an update that
// changed it, or a new row that has it. A row leaves out its empty fields,
// so a new row "has" only the ones set.
func (d EventData) Sets(field string) bool {
	if _, ok := d.Changes[field]; ok {
		return true
	}
	var row map[string]json.RawMessage
	return d.ReadRow(&row) && len(row[field]) > 0 && string(row[field]) != "null"
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
	// Ref and Key are what the change made or touched: a retry of the same
	// change is told them again.
	Ref string `db:"ref"`
	Key string `db:"key"`
}

// Cursor is how far a member has handled the events, under a name of
// their choosing.
type Cursor struct {
	WorkspaceID string `db:"workspace_id"`
	UserID      string `db:"user_id"`
	Name        string `db:"name"`
	Seq         int64  `db:"seq"`
	UpdatedAt   int64  `db:"updated_at"`
}
