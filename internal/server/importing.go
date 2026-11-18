package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/importer"
	"github.com/agrigoryan/quadit/internal/store"
)

// Imports from the web app and the API: what "quadit import" does from a
// terminal, run on the server. The source is a file uploaded first (an
// export from Linear, Asana, Trello or Notion; a zip of an Obsidian or
// Markdown folder), or an address (a GitHub repository, an Orbit install).
// Everything is written as the one who asks, through the same changes as
// any other work, and running the same import twice adds nothing twice.

// importRoutes is the route of importing work.
func (s *Server) importRoutes() []route {
	return []route{
		{"POST /api/v1/w/{ws}/import", s.workspaceMember(s.handleImportWork), "Import work from an uploaded export or a service. Body: {kind, file | source, options: {project, token, workspace, session, origin}, dry_run}. origin names an import of a folder (obsidian, markdown): importing again under the same name adds only what is new. Kinds: linear, asana, trello, notion, obsidian, markdown, github, orbit. Admins.", "", "admin"},
	}
}

// importLogSize is how many lines of an import's log are kept for the answer.
const importLogSize = 500

// importBody is the request to import.
type importBody struct {
	Kind string `json:"kind"`
	// File is the id of an uploaded file; Source an address instead, for
	// the kinds that are read from a service (github: owner/repo; orbit: its URL).
	File    string            `json:"file"`
	Source  string            `json:"source"`
	Options map[string]string `json:"options"` // project, token, workspace, session, api, origin
	DryRun  bool              `json:"dry_run"`
}

// handleImportWork reads a source and makes what it holds, or with
// dry_run only says what it found.
func (s *Server) handleImportWork(x *c) error {
	if err := x.mayAdminister(); err != nil {
		return err
	}
	var b importBody
	if err := x.body(&b); err != nil {
		return err
	}
	if !slices.Contains(importer.Kinds, b.Kind) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "kind", Message: "unknown source " + b.Kind, Allowed: importer.Kinds, Nearest: engine.Nearest(b.Kind, importer.Kinds)}
	}
	source, cleanup, err := s.importSource(x, b)
	if err != nil {
		return err
	}
	defer cleanup()
	plan, err := importer.Read(b.Kind, source, b.Options, s.outbound)
	if errors.Is(err, importer.ErrUnnamed) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "origin", Message: err.Error()}
	}
	if err != nil {
		plan.Close() // a source that failed may have unpacked files first
		field, what := "file", "this could not be read as a "+b.Kind+" export: "
		if b.File == "" {
			field, what = "source", "could not read from "+b.Kind+": "
		}
		return &engine.Error{Code: engine.CodeInvalid, Field: field, Message: what + err.Error()}
	}
	defer plan.Close()
	found := map[string]int{"tasks": len(plan.Tasks), "pages": len(plan.Docs), "databases": len(plan.Tables)}
	if b.DryRun {
		return x.ok(map[string]any{"found": found, "dry_run": true})
	}
	var log []string
	sink := importer.NewSink(selfAPI{s: s, x: x}, func(format string, a ...any) {
		if len(log) < importLogSize {
			log = append(log, strings.TrimSpace(fmt.Sprintf(format, a...)))
		}
	})
	sum, err := importer.Apply(sink, plan, b.Options["project"])
	s.audit(x.r, x.ws.ID, x.user, "import.ran", "import", b.Kind, map[string]any{"found": found, "tasks": sum.Tasks, "pages": sum.Docs})
	if err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Message: "the import stopped: " + err.Error() + " (what was made so far stays; running it again continues without making anything twice)"}
	}
	return x.ok(map[string]any{"found": found, "made": map[string]int{"tasks": sum.Tasks, "comments": sum.Comments, "pages": sum.Docs, "rows": sum.Rows, "files": sum.Files},
		"already_there": sum.Already, "unmatched_people": sum.Unmatched, "summary": sum.String(), "log": log})
}

// importSource says where an import reads from: the address given, for
// the kinds read from a service, or else a copy of the uploaded file in a
// temporary folder, which cleanup removes.
func (s *Server) importSource(x *c, b importBody) (source string, cleanup func(), err error) {
	cleanup = func() {}
	switch {
	case b.Kind == "github" || b.Kind == "orbit":
		if b.Source == "" {
			return "", cleanup, errBad("%s is read from its service: give source (github: owner/repo; orbit: the install's address)", b.Kind)
		}
		return b.Source, cleanup, nil
	case b.File == "":
		return "", cleanup, errBad("upload the export first and give its file id as file")
	}
	ctx := x.ctx()
	var f core.File
	if err := x.db.Get(ctx, &f, store.Eq("id", b.File), store.Live); err != nil {
		return "", cleanup, err
	}
	if f.State != core.FileReady {
		return "", cleanup, errNotFound("file")
	}
	dir, err := os.MkdirTemp("", "quadit-import-*")
	if err != nil {
		return "", cleanup, err
	}
	cleanup = func() { os.RemoveAll(dir) }
	source = filepath.Join(dir, filepath.Base(f.Name))
	if err := s.copyFileOut(ctx, f, source); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return source, cleanup, nil
}

// copyFileOut copies a stored file to path. A write that fails only when
// the copy is closed is an error like any other: the copy is short.
func (s *Server) copyFileOut(ctx context.Context, f core.File, path string) error {
	in, _, err := s.fileStore().Open(ctx, f.StorageKey)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// selfAPI is the server's own API as an import writes through it: with
// the sign-in of the request that asked for the import.
type selfAPI struct {
	s *Server
	x *c
}

// Call sends one API request.
func (k selfAPI) Call(method, path string, q url.Values, body []byte) ([]byte, error) {
	contentType := ""
	if body != nil {
		contentType = "application/json"
	}
	return k.do(method, path, q, body, contentType)
}

// SendFile stores a file, under the id given if there is one, and returns
// its address.
func (k selfAPI) SendFile(fileID, path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	q := url.Values{"name": {filepath.Base(path)}, "size": {strconv.Itoa(len(raw))}}
	if fileID != "" {
		q.Set("id", fileID)
	}
	out, err := k.do("POST", "/files", q, raw, "application/octet-stream")
	if err != nil {
		return "", err
	}
	var f struct{ URL string }
	if err := json.Unmarshal(out, &f); err != nil {
		return "", fmt.Errorf("the answer to storing %s: %w", filepath.Base(path), err)
	}
	return f.URL, nil
}

func (k selfAPI) do(method, path string, q url.Values, body []byte, contentType string) ([]byte, error) {
	// The same sign-in as the request that asked for the import.
	ans, err := k.s.selfCall(callerOf(k.x), method, path, q, body, contentType)
	if err != nil {
		return nil, err
	}
	if ans.status >= 300 {
		if refused := ans.refusal(); refused != nil {
			return nil, refused
		}
		return nil, fmt.Errorf("%s %s: %d", method, path, ans.status)
	}
	return ans.body.Bytes(), nil
}
