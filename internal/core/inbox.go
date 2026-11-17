// Following and the inbox: watchers and notifications.

package core

// Watcher is a member who follows a task or another subject and is told
// what happens to it.
type Watcher struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	UserID      string `json:"user_id" db:"user_id"`
	SubjectType string `json:"subject_type" db:"subject_type"`
	SubjectID   string `json:"subject_id" db:"subject_id"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
}

// Notification types: why an inbox item was made.
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
