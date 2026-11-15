package server

import (
	"context"
	"errors"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// A folder of Markdown files in a git repository can be a set of pages.
// Each file is one page; each directory is a page that holds them. A sync
// brings file changes into pages and page changes into commits. When both
// sides changed the same page, the source's authority says which wins.
//
// The server uses the git on its machine, with whatever access that has.
//
// How a sync is laid out:
//
//	reposync.go            the routes, the timer, and one sync as a list of steps
//	reposync_git.go        the working copy: clone, branch, checkout, commit, push
//	reposync_files.go      the folder in the working copy: reading it, writing to it
//	reposync_inside.go     what keeps reading and writing inside the working copy
//	reposync_pages.go      the source's pages, and the hashes of the last sync
//	reposync_title.go      a page's title from its file's opening heading, and back
//	reposync_reconcile.go  settling each file against its page, and each page
//	                       against its file

func init() {
	runners = append(runners, (*Server).runSources)
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/w/{ws}/sources/{id}/sync", s.workspaceMember(s.handleSyncSource))
		m.HandleFunc("GET /api/v1/w/{ws}/sources", s.workspaceMember(func(x *c) error {
			var list []core.DocSource
			if err := x.db.List(x.ctx(), &list, store.Where(store.Live)); err != nil {
				return err
			}
			return x.ok(map[string]any{"sources": list})
		}))
	})
}

var syncLocks sync.Map // source id -> *sync.Mutex

func (s *Server) runSources(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		var list []core.DocSource
		if err := s.st.List(ctx, &list, store.Where(store.Live)); err != nil {
			continue
		}
		for _, src := range list {
			if time.Now().UnixMilli()-src.LastSyncAt < 2*60_000 {
				continue
			}
			if _, err := s.syncSource(ctx, src); err != nil {
				s.log.Warn("repository sync", "repo", src.Repo, "err", err)
			}
		}
	}
}

func (s *Server) handleSyncSource(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	var src core.DocSource
	if err := x.db.Get(x.ctx(), &src, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("source")
	}
	res, err := s.syncSource(x.ctx(), src)
	if err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: err.Error()}
	}
	return x.ok(res)
}

type syncResult struct {
	PagesUpdated int    `json:"pages_updated"`
	PagesCreated int    `json:"pages_created"`
	PagesTrashed int    `json:"pages_trashed"`
	FilesWritten int    `json:"files_written"`
	FilesRemoved int    `json:"files_removed,omitempty"`
	Commit       string `json:"commit"`
	Pushed       string `json:"pushed,omitempty"`
	Note         string `json:"note,omitempty"`
}

// syncSource brings one repository and its pages in line.
func (s *Server) syncSource(ctx context.Context, src core.DocSource) (res syncResult, err error) {
	mu, _ := syncLocks.LoadOrStore(src.ID, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	db := s.st.In(src.WorkspaceID)
	defer func() {
		set := map[string]any{"last_sync_at": time.Now().UnixMilli(), "last_error": ""}
		if err != nil {
			set["last_error"] = oneLine(err.Error(), 400)
		} else if res.Commit != "" {
			set["last_commit"] = res.Commit
		}
		db.Update(context.WithoutCancel(ctx), "doc_sources", set, store.Eq("id", src.ID))
	}()
	if _, lerr := exec.LookPath("git"); lerr != nil {
		return res, errors.New("git is not installed on the server")
	}
	r := &syncRun{s: s, ctx: ctx, src: src, db: db, dir: filepath.Join(s.cfg.DataDir, "repos", src.ID)}
	steps := []func() error{
		r.clone, // reposync_git.go
		r.findBranch,
		r.checkout,
		r.findFolder, // reposync_files.go
		r.readFiles,
		r.loadPages,     // reposync_pages.go
		r.reconcile,     // reposync_reconcile.go
		r.writeOut,      // reposync_files.go
		r.commitAndPush, // reposync_git.go
		r.recordHashes,  // reposync_pages.go
		r.dropProposal,  // reposync_git.go
	}
	for _, step := range steps {
		if err := step(); err != nil || r.done {
			return r.res, err
		}
	}
	return r.res, nil
}

// syncRun is one sync of one source: the working copy, what was read from
// both sides, and what the sync has decided so far.
type syncRun struct {
	s   *Server
	ctx context.Context
	src core.DocSource
	db  store.DB // the source's workspace

	res syncResult
	// done is set by a step that finds the sync has nothing more to do: the
	// steps after it are not run.
	done bool

	dir      string // the working copy
	branch   string
	root     string // the source's folder in the working copy
	noFolder string // said while the folder is missing; taken back once this sync has made it

	files  map[string]string // path under the folder -> text
	pages  []core.Doc
	byPath map[string]core.Doc
	byID   map[string]core.Doc

	toWrite  map[string]string // path -> text to put in the repository
	toRemove []string
	written  map[string]string // doc id -> page hash, set after a push
	renamed  []string          // pages given another file name than their title's, and why
	editors  map[string]int64  // who last changed the pages being written, and when
	blocked  map[string]bool   // paths a link in the repository stands on, or in the way of
}

// addNote adds to the sync's note: what one step says never hides what an
// earlier step of the same sync said.
func (r *syncRun) addNote(note string) {
	r.res.Note = strings.TrimSpace(r.res.Note + " " + note)
}

// sayRenamed adds to the sync's note what it has to say about single pages
// and files.
func (r *syncRun) sayRenamed() {
	if len(r.renamed) > 0 {
		r.addNote(oneLine(strings.Join(r.renamed, "; "), 1500))
	}
}
