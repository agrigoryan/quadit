// Following and the inbox: watchers and notifications.

package core

import "strings"

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

// NoteHeadlines are what a notification outside the app (a push, a mail's
// subject, the desktop app's) says an inbox item is, by its type: {who} is
// the actor's name and {title} the item's title. They are the only copy:
// cmd/webtypes writes them into the web app's dictionary
// (web/src/i18n/en/push.gen.ts), which words the desktop app's notifications
// with them, so a person is told the same thing however they are told.
var NoteHeadlines = map[string]string{
	NoteAssigned:  "{who} assigned you {title}",
	NoteMentioned: "{who} mentioned you in {title}",
	NoteWaitingOn: "{who} is waiting on you in {title}",
	NoteAsked:     "{who} asked you a question in {title}",
	NotePicked:    "{who} answered your question in {title}",
	NoteUnclear:   "{who} found your answer unclear in {title}",
	NoteReplied:   "{who} replied to you in {title}",
	NoteComment:   "{who} commented on {title}",
	NoteResult:    "{who} posted a result in {title}",
	NoteStatus:    "{who} changed the status of {title}",
}

// NoteHeadline is the headline of an inbox item of the type noteType that
// who (the actor's name, "" when nobody is named) made about title. A type
// without a headline of its own reads as a comment.
func NoteHeadline(noteType, who, title string) string {
	headline, ok := NoteHeadlines[noteType]
	if !ok {
		headline = NoteHeadlines[NoteComment]
	}
	return strings.TrimSpace(strings.NewReplacer("{who}", who, "{title}", title).Replace(headline))
}

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
	// Addressed: the change that made this item was for this member itself
	// (assigned to it, handed to it, it was mentioned, asked or answered,
	// or a person's comment on a task that is its own), as opposed to one
	// it only hears as a follower.
	Addressed bool `json:"addressed,omitempty" db:"addressed"`
}
