package importer

import (
	"fmt"
	"net/url"
	"strings"
)

// Sink is where an import writes: the API, through the command-line client
// or from inside the server. Change takes the id to send the change under;
// the same id sent again is applied once, which is what makes an import
// safe to run twice.
type Sink interface {
	Change(changeID, typ string, args any) error
	Get(path string, q url.Values) ([]byte, error)
	Upload(path string) (fileURL string, err error)
	Logf(format string, a ...any)
}

// FileUploader is a Sink that can send a file under an id of the caller's
// making: a file sent again under the same id is not stored twice, which is
// what keeps a second run of an import from leaving copies behind. fresh
// says whether the file was sent now, or was there from an earlier run.
type FileUploader interface {
	UploadAs(fileID, path string) (fileURL string, fresh bool, err error)
}

// duplicateTeller is a Sink that knows whether its last change had been
// made before.
type duplicateTeller interface {
	WasDuplicate() bool
}

// Summary says what an import did.
type Summary struct {
	Tasks, Comments, Docs, Rows, Files int
	Unmatched                          []string // assignees with no member here
	// Already counts what an earlier run of the same import had made.
	Already int
}

func (s Summary) String() string {
	out := fmt.Sprintf("imported %d tasks, %d comments, %d pages, %d rows, %d files", s.Tasks, s.Comments, s.Docs, s.Rows, s.Files)
	if s.Already > 0 {
		out += fmt.Sprintf("\n%d things were here already from an earlier run and were left as they are", s.Already)
	}
	if len(s.Unmatched) > 0 {
		out += "\nno member here for: " + strings.Join(s.Unmatched, ", ") + " (their tasks are unassigned and say who had them)"
	}
	return out
}
