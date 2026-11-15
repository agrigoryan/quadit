package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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
func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/w/{ws}/import", s.in(s.hImport))
	})
}

// inProcess marks a request the server makes to itself on a caller's
// behalf; such requests are not counted against the caller's rate limit.
type inProcess struct{}

type importBody struct {
	Kind string `json:"kind"`
	// File is the id of an uploaded file; Source an address instead, for
	// the kinds that are read from a service (github: owner/repo; orbit: its URL).
	File    string            `json:"file"`
	Source  string            `json:"source"`
	Options map[string]string `json:"options"` // project, token, workspace, api
	DryRun  bool              `json:"dry_run"`
}

func (s *Server) hImport(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	var b importBody
	if err := x.body(&b); err != nil {
		return err
	}
	if !has(importer.Kinds, b.Kind) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "kind", Message: "unknown source " + b.Kind, Allowed: importer.Kinds, Nearest: nearestOf(b.Kind, importer.Kinds)}
	}
	ctx := x.ctx()
	source := b.Source
	switch {
	case b.Kind == "github" || b.Kind == "orbit":
		if source == "" {
			return errBad("%s is read from its service: give source (github: owner/repo; orbit: the install's address)", b.Kind)
		}
	case b.File == "":
		return errBad("upload the export first and give its file id as file")
	default:
		var f core.File
		if err := x.db.Get(ctx, &f, store.Eq("id", b.File), store.Live); err != nil || f.State != "ready" {
			return errNotFound("file")
		}
		dir, err := os.MkdirTemp("", "quadit-import-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		in, _, err := s.fileStore().Open(ctx, f.StorageKey)
		if err != nil {
			return err
		}
		source = filepath.Join(dir, filepath.Base(f.Name))
		out, err := os.Create(source)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	plan, err := importer.Read(b.Kind, source, b.Options)
	if err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "file", Message: "this could not be read as a " + b.Kind + " export: " + err.Error()}
	}
	found := map[string]int{"tasks": len(plan.Tasks), "pages": len(plan.Docs), "databases": len(plan.Tables)}
	if b.DryRun {
		return x.ok(map[string]any{"found": found, "dry_run": true})
	}
	sink := &serverSink{s: s, x: x}
	sum, err := importer.Apply(sink, plan, b.Options["project"])
	s.audit(x.r, x.ws.ID, x.user, "import.ran", "import", b.Kind, map[string]any{"found": found, "tasks": sum.Tasks, "pages": sum.Docs})
	if err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Message: "the import stopped: " + err.Error() + " (what was made so far stays; running it again continues without making anything twice)"}
	}
	return x.ok(map[string]any{"found": found, "made": map[string]int{"tasks": sum.Tasks, "comments": sum.Comments, "pages": sum.Docs, "rows": sum.Rows, "files": sum.Files},
		"unmatched_people": sum.Unmatched, "summary": sum.String(), "log": sink.log})
}

// serverSink writes an import through the server's own API as the caller.
type serverSink struct {
	s   *Server
	x   *c
	log []string
}

func (k *serverSink) do(method, path string, q url.Values, body []byte, contentType string) ([]byte, error) {
	u := "/api/v1/w/" + k.x.ws.Slug + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(context.WithValue(k.x.ctx(), inProcess{}, true), method, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	// The same sign-in as the request that asked for the import.
	for _, h := range []string{"Authorization", "Cookie"} {
		if v := k.x.r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.RemoteAddr = k.x.r.RemoteAddr
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := &buffer{h: http.Header{}, status: 200}
	k.s.mux.ServeHTTP(rec, req)
	if rec.status >= 300 {
		var wrap struct {
			Error engine.Error `json:"error"`
		}
		if json.Unmarshal(rec.body.Bytes(), &wrap) == nil && wrap.Error.Code != "" {
			return nil, &wrap.Error
		}
		return nil, fmt.Errorf("%s %s: %d", method, path, rec.status)
	}
	return rec.body.Bytes(), nil
}

func (k *serverSink) Change(changeID, typ string, args any) error {
	raw, _ := json.Marshal(map[string]any{"id": changeID, "type": typ, "args": args})
	_, err := k.do("POST", "/changes", nil, raw, "application/json")
	return err
}

func (k *serverSink) Get(path string, q url.Values) ([]byte, error) {
	return k.do("GET", path, q, nil, "")
}

func (k *serverSink) Upload(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	out, err := k.do("POST", "/files", url.Values{"name": {filepath.Base(path)}}, raw, "application/octet-stream")
	if err != nil {
		return "", err
	}
	var f struct{ URL string }
	json.Unmarshal(out, &f)
	return f.URL, nil
}

func (k *serverSink) Logf(format string, a ...any) {
	if len(k.log) < 500 {
		k.log = append(k.log, strings.TrimSpace(fmt.Sprintf(format, a...)))
	}
}
