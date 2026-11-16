package server

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
)

// The export of a workspace: a zip of Markdown, JSON and the uploaded
// files, written by the parts in export_*.go.
//
// An export is complete. It is the copy of the workspace its admins keep,
// so it holds everything as stored, with no rule of who may see what:
// every project, and every member's private pages, which the admin who
// asks for it could not open in the product. That is the owner's decision,
// and it is said where a person meets it: the archive's README, the
// export's text in Settings, and docs/install.md. Only an admin who is not
// limited to some projects may ask for one.

// exportRoutes is the route of the workspace export.
func (s *Server) exportRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/export", s.workspaceMember(s.handleExportWorkspace), "The whole workspace as a zip of Markdown, JSON and the original files.", "", "admin"},
	}
}

// exportReadme is the README.txt at the top of an export.
const exportReadme = `This is an export of one workspace, in open formats.

tasks/   one Markdown file per task: its fields, description, decisions and comments
docs/    one Markdown file per page, in folders that follow the page tree;
         a database is a CSV file beside a folder of its rows
data/    every row of the workspace as JSON, one file per kind, for programs
files/   the uploaded files, as they were uploaded; any that could not be
         included are named, with the reason, in files/NOT-INCLUDED.txt

It holds everything in the workspace: every project, and the private pages
of every member, the ones of others included. Keep it as you would keep
those pages.

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
	// The export is written as stored, with no rule of who may see what
	// (members' private pages are in it): it is for an admin of the whole
	// workspace.
	if x.limited() {
		return errForbidden("an export holds every project of the workspace, and this credential is limited to some of them; ask with one that is not")
	}
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	s.audit(x.r, x.ws.ID, x.user, "workspace.exported", "workspace", x.ws.ID, nil)
	x.w.Header().Set("Content-Type", "application/zip")
	x.w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-%s.zip"`, x.ws.Slug, time.Now().UTC().Format("2006-01-02")))
	e := &exporter{who: &x.viewer, ctx: x.ctx(), uploads: s.fileStore(), names: names, zw: zip.NewWriter(x.w)}
	err = e.write()
	// The archive is closed even after a failed part, as far as it got.
	if cerr := e.zw.Close(); cerr != nil && err == nil {
		// The answer is under way: it can only end short, and be logged.
		s.log.Error("export: finishing the archive", "workspace", x.ws.Slug, "err", cerr)
	}
	return err
}

// write writes the README, reads the workspace, and writes each part of
// the archive from what it read.
func (e *exporter) write() error {
	if err := e.addTextFile("README.txt", exportReadme); err != nil {
		return err
	}
	rows, err := e.load() // export_data.go
	if err != nil {
		return err
	}
	parts := []func(*exportRows) error{
		e.data,  // export_data.go
		e.tasks, // export_tasks.go
		e.docs,  // export_docs.go
		e.files, // export_files.go
	}
	for _, part := range parts {
		if err := part(rows); err != nil {
			return err
		}
	}
	return nil
}

// exporter is one export being written: who it is for, where the uploaded
// files are, and the archive. It is one run of work, which is why it holds
// a ctx.
type exporter struct {
	who     *viewer
	ctx     context.Context
	uploads blob.Store // where the uploaded files are read from
	names   *nameLookup
	zw      *zip.Writer

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
