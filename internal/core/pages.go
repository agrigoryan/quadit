// Pages (Doc in code): pages, databases and rows, their blocks, versions,
// properties and views, the repositories they sync with, and who has one
// open.

package core

import "encoding/json"

// Source authorities: who wins when a file and its page both changed.
const (
	AuthorityRepo  = "repo"  // the file in the repository
	AuthorityPages = "pages" // the page here
)

// Source write modes: what happens to edits made to a synced page.
const (
	WriteCommit  = "commit"  // they are committed and pushed
	WritePropose = "propose" // they are proposed on a branch
	WriteNone    = "none"    // they stay here
)

// Doc kinds.
const (
	DocPage     = "page"
	DocDatabase = "database"
	DocRow      = "row"
)

// Doc is a page: a plain page, a database, or a row of one.
type Doc struct {
	ID          string          `json:"id" db:"id"`
	WorkspaceID string          `json:"-" db:"workspace_id"`
	ParentID    string          `json:"parent_id,omitempty" db:"parent_id,null"`
	Kind        string          `json:"kind" db:"kind"`
	Title       string          `json:"title" db:"title"`
	Icon        string          `json:"icon,omitempty" db:"icon"`
	Cover       string          `json:"cover,omitempty" db:"cover"`
	ProjectID   string          `json:"project_id,omitempty" db:"project_id,null"`
	OwnerID     string          `json:"owner_id,omitempty" db:"owner_id,null"`       // set on a private page
	SharedWith  []string        `json:"shared_with,omitempty" db:"shared_with,json"` // who else may read a private page
	Generated   string          `json:"generated,omitempty" db:"generated"`          // decision_log, changelog or open_questions: a page the server writes
	MemoryOf    string          `json:"memory_of,omitempty" db:"memory_of,null"`     // the agent whose memory note it is
	Props       json.RawMessage `json:"props,omitempty" db:"props,json"`             // a row's values, by property
	SourceID    string          `json:"source_id,omitempty" db:"source_id,null"`     // the DocSource it is synced with
	SourcePath  string          `json:"source_path,omitempty" db:"source_path"`      // its file in that repository
	SourceHash  string          `json:"-" db:"source_hash"`                          // the hash of the file as last synced
	Rank        string          `json:"rank" db:"rank"`
	CreatedBy   string          `json:"created_by" db:"created_by"`
	CreatedAt   int64           `json:"created_at" db:"created_at"`
	UpdatedBy   string          `json:"updated_by,omitempty" db:"updated_by,null"`
	UpdatedAt   int64           `json:"updated_at" db:"updated_at"`
	CreatedSeq  int64           `json:"created_seq" db:"created_seq"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	ContentSeq  int64           `json:"content_seq" db:"content_seq"` // the last change to its blocks
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
	Plain       string          `json:"-" db:"plain"` // its text, for search
	CreatedBy   string          `json:"created_by" db:"created_by"`
	UpdatedBy   string          `json:"updated_by" db:"updated_by"`
	CreatedSeq  int64           `json:"created_seq" db:"created_seq"`
	UpdatedSeq  int64           `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64           `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// DocVersion is a saved snapshot of a page.
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

// DBProperty is a column of a database.
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

// DBView is a saved way to show a database: a table, a board, ….
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

// DocSource syncs a tree of pages with a folder of Markdown in a git
// repository.
type DocSource struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	RootDocID   string `json:"root_doc_id" db:"root_doc_id"`
	Repo        string `json:"repo" db:"repo"`
	Branch      string `json:"branch,omitempty" db:"branch"`
	Subdir      string `json:"subdir,omitempty" db:"subdir"`
	Authority   string `json:"authority" db:"authority"`   // one of the Authority* values
	WriteMode   string `json:"write_mode" db:"write_mode"` // one of the Write* modes
	LastCommit  string `json:"last_commit,omitempty" db:"last_commit"`
	LastSyncAt  int64  `json:"last_sync_at,omitempty" db:"last_sync_at,null"`
	LastError   string `json:"last_error,omitempty" db:"last_error"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	UpdatedSeq  int64  `json:"updated_seq" db:"updated_seq"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
}

// Presence is one member with a page open, and the block they are in.
type Presence struct {
	WorkspaceID string `json:"-" db:"workspace_id"`
	DocID       string `json:"-" db:"doc_id"`
	UserID      string `json:"user_id" db:"user_id"`
	Block       string `json:"block,omitempty" db:"block"`
	At          int64  `json:"at" db:"at"`
}
