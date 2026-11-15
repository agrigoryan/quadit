// The Sink that writes an import through the API, for the command-line
// tool and the server alike.

package importer

import (
	"encoding/json"
	"net/url"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/plainjson"
)

// API is the workspace's API as an import uses it. The command-line tool
// reaches it over the network and the server calls itself; everything else
// about writing an import is the same for both, and is in apiSink.
type API interface {
	// Call sends a request with a JSON body (nil for none) to a path under
	// the workspace and returns the answer.
	Call(method, path string, q url.Values, body []byte) ([]byte, error)
	// SendFile uploads the file at path and returns its address. With a
	// fileID, the file is stored under that id.
	SendFile(fileID, path string) (fileURL string, err error)
}

// NewSink makes the Sink that writes an import through the API. logf takes
// the import's notes and progress.
func NewSink(api API, logf func(format string, a ...any)) Sink {
	return &apiSink{api: api, logf: logf}
}

// apiSink is the Sink NewSink makes.
type apiSink struct {
	api  API
	logf func(format string, a ...any)
	// quiet is whether changes go out marked quiet: once asked, and true
	// when the importer is an admin, who alone may send them so.
	quiet *bool
}

// Change sends one change of the import. What an import makes is history,
// not news: an admin's import sends it quiet, so nobody gets an inbox item
// for it.
func (s *apiSink) Change(changeID, typ string, args any) (bool, error) {
	change := map[string]any{"id": changeID, "type": typ, "args": args}
	if s.mayBeQuiet() {
		change["quiet"] = true
	}
	raw := plainjson.Marshal(map[string]any{"changes": []any{change}})
	out, err := s.api.Call("POST", "/changes", nil, raw)
	if err != nil {
		return false, err
	}
	var res struct {
		Results []struct {
			Duplicate bool `json:"duplicate"`
		} `json:"results"`
	}
	dup := json.Unmarshal(out, &res) == nil && len(res.Results) > 0 && res.Results[0].Duplicate
	return !dup, nil
}

// mayBeQuiet says whether the one importing may send changes quiet. A
// member's import tells people as any of their work does, and says so.
func (s *apiSink) mayBeQuiet() bool {
	if s.quiet != nil {
		return *s.quiet
	}
	var me struct{ Role core.Role }
	raw, err := s.api.Call("GET", "/me", nil, nil)
	quiet := err == nil && json.Unmarshal(raw, &me) == nil && me.Role.AtLeast(core.RoleAdmin)
	if !quiet {
		s.logf("note: only an admin's import is kept out of people's inboxes; this one will notify as usual")
	}
	s.quiet = &quiet
	return quiet
}

// Get reads a path under the workspace.
func (s *apiSink) Get(path string, q url.Values) ([]byte, error) {
	return s.api.Call("GET", path, q, nil)
}

// Upload sends a file, under the import's own id for it unless an earlier
// run of the same import has.
func (s *apiSink) Upload(fileID, path string) (string, bool, error) {
	if fileID == "" {
		u, err := s.api.SendFile("", path)
		return u, true, err
	}
	var had struct{ URL, State string }
	if raw, err := s.api.Call("GET", "/files/"+fileID, nil, nil); err == nil && json.Unmarshal(raw, &had) == nil && had.State == core.FileReady {
		return had.URL, false, nil
	}
	u, err := s.api.SendFile(fileID, path)
	return u, true, err
}

// Logf passes on a note or a line of progress.
func (s *apiSink) Logf(format string, a ...any) { s.logf(format, a...) }
