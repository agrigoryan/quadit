// Where an import writes, and the summary of what it made.

package importer

import (
	"fmt"
	"net/url"
	"strings"
)

// Sink is where an import writes: the API, through the command-line client
// or from inside the server.
type Sink interface {
	// Change sends one change under changeID. The same id sent again is
	// applied once, which is what makes an import safe to run twice: made
	// is false when the change had been made before, and nothing was
	// written this time. A refusal is the error.
	Change(changeID, typ string, args any) (made bool, err error)
	// Get reads a path under the workspace.
	Get(path string, q url.Values) ([]byte, error)
	// Upload sends the file at path and gives its address. With a fileID it
	// is stored under that id, and a file sent again under the same id is
	// not stored twice, which keeps a second run of an import from leaving
	// copies behind: fresh is false when it was there from an earlier run.
	// With no fileID the server makes the id, and the file is always fresh.
	Upload(fileID, path string) (fileURL string, fresh bool, err error)
	// Logf takes a note or a line of progress.
	Logf(format string, a ...any)
}

// Summary says what an import did.
type Summary struct {
	Tasks, Comments, Docs, Rows, Files int
	Unmatched                          []string // assignees with no member here
	// Already counts what an earlier run of the same import had made.
	Already int
}

// String says what was made in words, as the command-line tool prints it.
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
