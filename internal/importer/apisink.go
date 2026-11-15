package importer

import (
	"encoding/json"
	"net/url"
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

type apiSink struct {
	api  API
	logf func(format string, a ...any)
	dup  bool
}

func (s *apiSink) Change(changeID, typ string, args any) error {
	raw, _ := json.Marshal(map[string]any{"id": changeID, "type": typ, "args": args})
	out, err := s.api.Call("POST", "/changes", nil, raw)
	var res struct {
		Results []struct {
			Duplicate bool `json:"duplicate"`
		} `json:"results"`
	}
	s.dup = err == nil && json.Unmarshal(out, &res) == nil && len(res.Results) > 0 && res.Results[0].Duplicate
	return err
}

// WasDuplicate reports whether the last change had been made before.
func (s *apiSink) WasDuplicate() bool { return s.dup }

func (s *apiSink) Get(path string, q url.Values) ([]byte, error) {
	return s.api.Call("GET", path, q, nil)
}

func (s *apiSink) Upload(path string) (string, error) {
	return s.api.SendFile("", path)
}

// UploadAs sends a file under the import's own id for it, unless an
// earlier run of the same import has.
func (s *apiSink) UploadAs(fileID, path string) (string, bool, error) {
	var had struct{ URL, State string }
	if raw, err := s.api.Call("GET", "/files/"+fileID, nil, nil); err == nil && json.Unmarshal(raw, &had) == nil && had.State == "ready" {
		return had.URL, false, nil
	}
	u, err := s.api.SendFile(fileID, path)
	return u, true, err
}

func (s *apiSink) Logf(format string, a ...any) { s.logf(format, a...) }
