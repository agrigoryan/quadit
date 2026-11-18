// Uploaded files and where they are attached.

package core

// File states.
const (
	FileUploading = "uploading" // parts are still arriving
	FileReady     = "ready"     // all of it is stored and it may be used
)

// File is one uploaded file.
type File struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	Name        string `json:"name" db:"name"`
	ContentType string `json:"content_type" db:"content_type"`
	Size        int64  `json:"size" db:"size"`
	Received    int64  `json:"received,omitempty" db:"received"` // bytes stored so far, while uploading
	SHA256      string `json:"sha256,omitempty" db:"sha256"`
	StorageKey  string `json:"-" db:"storage_key"`
	State       string `json:"state" db:"state"` // FileUploading or FileReady
	Width       int    `json:"width,omitempty" db:"width,null"`
	Height      int    `json:"height,omitempty" db:"height,null"`
	DurationMS  int64  `json:"duration_ms,omitempty" db:"duration_ms,null"`
	PreviewKey  string `json:"-" db:"preview_key"`
	// Parts are the keys in file storage of the parts of an upload in
	// several requests kept so far, in order; gone once the file is stored.
	Parts      []string `json:"-" db:"parts,json"`
	UploadedBy string   `json:"uploaded_by" db:"uploaded_by"`
	CreatedAt  int64    `json:"created_at" db:"created_at"`
	DeletedAt  int64    `json:"deleted_at,omitempty" db:"deleted_at,null"`
	// Filled when read: where to fetch it.
	URL        string `json:"url,omitempty"`
	PreviewURL string `json:"preview_url,omitempty"`
}

// Attachment shows a file on a task, a comment, a decision or an option.
type Attachment struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"-" db:"workspace_id"`
	FileID      string `json:"file_id" db:"file_id"`
	SubjectType string `json:"subject_type" db:"subject_type"`
	SubjectID   string `json:"subject_id" db:"subject_id"`
	TaskID      string `json:"task_id,omitempty" db:"task_id,null"` // the task the subject belongs to
	Role        string `json:"role,omitempty" db:"role"`
	Caption     string `json:"caption,omitempty" db:"caption"`
	Rank        string `json:"rank" db:"rank"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	DeletedAt   int64  `json:"deleted_at,omitempty" db:"deleted_at,null"`
	File        *File  `json:"file,omitempty"`
}
