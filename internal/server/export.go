package server

import (
	"archive/zip"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// The export of a workspace: a zip of Markdown, JSON and the uploaded
// files, written by the parts in export_*.go.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/w/{ws}/export", s.workspaceMember(s.handleExportWorkspace))
	})
}

// exportReadme is the README.txt at the top of an export.
const exportReadme = `This is an export of one workspace, in open formats.

tasks/   one Markdown file per task: its fields, description, decisions and comments
docs/    one Markdown file per page, in folders that follow the page tree;
         a database is a CSV file beside a folder of its rows
data/    every row of the workspace as JSON, one file per kind, for programs
files/   the uploaded files, as they were uploaded; any that could not be
         included are named, with the reason, in files/NOT-INCLUDED.txt

Nothing here needs this product to be read.
`

// fileSafe makes a name usable as a file name on any system: no path
// separators or other reserved characters, at most 80 bytes, never empty.
func fileSafe(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 {
			return '-'
		}
		return r
	}, strings.TrimSpace(s))
	if len(s) > 80 {
		s = strings.TrimSpace(s[:80])
	}
	if s == "" || s == "." || s == ".." {
		s = "untitled"
	}
	return s
}

// handleExportWorkspace writes the whole workspace as a zip of Markdown, JSON and the
// original files.
func (s *Server) handleExportWorkspace(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	names, err := x.names()
	if err != nil {
		return err
	}
	s.audit(x.r, x.ws.ID, x.user, "workspace.exported", "workspace", x.ws.ID, nil)
	x.w.Header().Set("Content-Type", "application/zip")
	x.w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.zip"`, x.ws.Slug, time.Now().UTC().Format("2006-01-02")))
	e := &exporter{x: x, names: names, zw: zip.NewWriter(x.w)}
	err = e.write()
	// The archive is closed even after a failed part, as far as it got.
	if cerr := e.zw.Close(); cerr != nil && err == nil {
		// The answer is under way: it can only end short, and be logged.
		s.log.Error("export: finishing the archive", "workspace", x.ws.Slug, "err", cerr)
	}
	return err
}

// write writes the README and then each part of the archive.
func (e *exporter) write() error {
	if err := e.addTextFile("README.txt", exportReadme); err != nil {
		return err
	}
	parts := []func() error{
		e.data,  // export_data.go
		e.tasks, // export_tasks.go
		e.docs,  // export_docs.go
		e.files, // export_files.go
	}
	for _, part := range parts {
		if err := part(); err != nil {
			return err
		}
	}
	return nil
}

// exporter is one export being written: the request, the archive, and the
// rows read so far, which the parts after data/ are written from.
type exporter struct {
	x     *c
	names *nameLookup
	zw    *zip.Writer
	rows  exportRows // export_data.go

	// What tasks/ is written from, by indexTasks.
	optionsOf   map[string][]core.Option   // a decision's options
	decisionsOn map[string][]core.Decision // a task's decisions, in the order data/ holds them
	commentsOn  map[string][]core.Comment  // a task's comments, in the order data/ holds them
	filesOn     map[string][]string        // where in the archive the files on a task or an option are
	keyOf       map[string]string          // a task's key, by its id
}

// addTextFile writes one file of text into the archive.
func (e *exporter) addTextFile(name, body string) error {
	w, err := e.zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, body)
	return err
}
