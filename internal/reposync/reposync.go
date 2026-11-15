// Package reposync mirrors a folder of Markdown files in a git repository
// as pages. Each file is one page; each folder is a page that holds them. A
// sync brings file changes into pages and page changes into commits. When
// both sides changed the same page, the source's authority says which wins.
//
// It hides git, the working copies kept on the server's disk, and how a page
// remembers its file. The server uses the git on its machine, with whatever
// access that has.
//
// How it is laid out:
//
//	reposync.go     one sync, top to bottom, and the timer that runs them
//	workingcopy.go  the working copy: the only place that knows git
//	inside.go       what keeps reading and writing inside the working copy
//	reconcile.go    the decisions: each file against its page, each page
//	                against its file; no reading or writing
//	pages.go        reading the source's pages, and changing them
//	title.go        a page's title from its file's opening heading, and back
package reposync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// Syncer syncs repository sources. The zero value is not ready: set every
// field.
type Syncer struct {
	Store   store.Store
	Engine  *engine.Engine // pages are changed through it
	Log     *slog.Logger
	DataDir string // working copies are kept under its "repos" folder

	locks sync.Map // source id -> *sync.Mutex: one sync of a source at a time
}

// Result is what one sync did, as its answer says.
type Result struct {
	PagesUpdated int    `json:"pages_updated"`
	PagesCreated int    `json:"pages_created"`
	PagesTrashed int    `json:"pages_trashed"`
	FilesWritten int    `json:"files_written"`
	FilesRemoved int    `json:"files_removed,omitempty"`
	Commit       string `json:"commit"`
	Pushed       string `json:"pushed,omitempty"`
	// Note says, in words for a person, what the sync could not do or did
	// differently than asked: a missing folder, pages held back or written
	// under another name.
	Note string `json:"note,omitempty"`
}

// Run syncs each live source every few minutes until ctx ends.
func (s *Syncer) Run(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		var list []core.DocSource
		if err := s.Store.List(ctx, &list, store.Where(store.Live)); err != nil {
			if ctx.Err() == nil {
				s.Log.Error("repository sync: the sources could not be listed; this round is skipped", "err", err)
			}
			continue
		}
		for _, src := range list {
			if time.Now().UnixMilli()-src.LastSyncAt < 2*60_000 {
				continue
			}
			if _, err := s.Sync(ctx, src); err != nil {
				s.Log.Error("repository sync", "repo", src.Repo, "err", err)
			}
		}
	}
}

// Sync brings one repository and its pages in line, and records on the
// source when it did and how it went. The error is in words for a person;
// Conflict tells one that is about the source from one of the server's own.
func (s *Syncer) Sync(ctx context.Context, src core.DocSource) (res Result, err error) {
	mu, _ := s.locks.LoadOrStore(src.ID, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	db := s.Store.In(src.WorkspaceID)
	defer func() {
		set := map[string]any{"last_sync_at": time.Now().UnixMilli(), "last_error": ""}
		if err != nil {
			set["last_error"] = oneLine(err.Error(), 400)
		} else if res.Commit != "" {
			set["last_commit"] = res.Commit
		}
		if _, uerr := db.Update(context.WithoutCancel(ctx), "doc_sources", set, store.Eq("id", src.ID)); uerr != nil {
			s.Log.Error("repository sync: recording how it went", "source", src.ID, "err", uerr)
		}
	}()
	log := s.Log.With("source", src.ID)

	// The working copy, at what the source's branch holds now: the
	// source's, or else the one the repository calls its main one. A
	// repository with neither has nothing to sync until it does.
	wc, err := openWorkingCopy(ctx, filepath.Join(s.DataDir, "repos", src.ID), src.Repo, src.Subdir, log)
	if err != nil {
		return Result{}, err
	}
	branch := src.Branch
	if branch == "" {
		if branch, err = wc.mainBranch(ctx); err != nil {
			return Result{}, err
		}
		if branch == "" {
			return Result{Note: "the repository has no commits yet; pages will sync once it has"}, nil
		}
	}
	pushTo := branch
	if src.WriteMode == core.WritePropose {
		pushTo = "quadit/docs"
	}
	if err := wc.checkout(ctx, branch, pushTo); errors.Is(err, errNoSuchBranch) {
		return Result{Note: "the repository has no branch " + branch + " yet; pages will sync once it has"}, nil
	} else if err != nil {
		return Result{}, err
	}

	// Both sides as they are now, and what to do about each file and page.
	files, err := wc.read()
	if err != nil {
		return Result{}, err
	}
	pages, err := loadPages(ctx, db, src)
	if err != nil {
		return Result{}, err
	}
	p := reconcile(src, files, pages)

	// The pages first, in one write.
	if err := s.applyToPages(ctx, src, p.pages); err != nil {
		return Result{}, err
	}
	res.PagesCreated, res.PagesUpdated, res.PagesTrashed = p.counts()
	res.Commit = wc.head(ctx)
	// Said while the folder is missing, unless this sync makes it.
	missing := ""
	if files.missing {
		missing = "the repository has no folder " + src.Subdir + " on " + branch + " yet"
	}
	renamed := ""
	if len(p.notes) > 0 {
		renamed = oneLine(strings.Join(p.notes, "; "), 1500)
	}
	if len(p.writes) == 0 && len(p.removals) == 0 || src.WriteMode == core.WriteNone {
		res.Note = sentences(missing, renamed)
		return res, nil
	}

	// Then the files. One page that cannot be written (a link or a file
	// stands in the way, the disk refuses) is held back and named, and is
	// not taken as synced; the rest go on.
	var written []fileWrite
	var blocked []string
	for _, w := range p.writes {
		if err := wc.write(w.Path, w.Text); err != nil {
			if !errors.Is(err, errOutside) {
				log.Warn("repository sync: a page was not written", "path", w.Path, "err", err)
			}
			blocked = append(blocked, w.Path)
			continue
		}
		written = append(written, w)
	}
	for _, r := range p.removals {
		if err := wc.remove(r.Path); err != nil {
			log.Warn("repository sync: a file was not removed", "path", r.Path, "err", err)
		}
	}
	held := ""
	if len(blocked) > 0 {
		slices.Sort(blocked)
		held = fmt.Sprintf("%d page(s) were not written to the repository, because a link or a file there stands in the way: %s", len(blocked), oneLine(strings.Join(blocked, ", "), 800))
	}

	// One commit, in the name of whoever changed the pages last; the
	// others who changed pages in it are named in its message. It goes to
	// the branch, or to quadit/docs when the source only proposes.
	message := fmt.Sprintf("docs: update %d page(s) from Quadit", len(written)+len(p.removals))
	author, others, err := s.commitAuthor(ctx, db, p.editors)
	if err != nil {
		return Result{}, err
	}
	if len(others) > 0 {
		message += "\n\nAlso edited by: " + strings.Join(others, ", ")
	}
	commit, err := wc.commitAndPush(ctx, message, author, pushTo)
	if errors.Is(err, errCheckedOut) {
		return Result{}, &conflict{fmt.Sprintf("the repository is a working copy with %s checked out, and git lets nobody push to that. Sync with a bare repository or a hosted one, or set write_mode to \"propose\" so page edits go to the branch quadit/docs", pushTo)}
	}
	if err != nil {
		return Result{}, err
	}
	if commit == "" {
		// Nothing changed in the repository after all.
		res.Note = sentences(missing, held, renamed)
		return res, nil
	}
	res.FilesWritten, res.FilesRemoved, res.Pushed, res.Commit = len(written), len(p.removals), pushTo, commit
	if len(written) > 0 {
		missing = "" // it has the folder now
	}
	res.Note = sentences(missing, held, renamed)

	// What was pushed is now the common ground for those pages.
	return res, rememberWritten(ctx, db, src, written, p.removals)
}

// conflict is a sync that cannot go as the source or its repository is
// set up, in words for a person.
type conflict struct{ msg string }

func (e *conflict) Error() string { return e.msg }

// Conflict reports whether a sync failed for what the source or its
// repository is, not for the server: its folder is not a folder there, its
// branch cannot be pushed to, the server has no git, or the repository
// cannot be reached or refuses the server. Syncing again without a change
// there fails the same way. Any other error is the server's own, such as
// its database not answering.
func Conflict(err error) bool {
	var c *conflict
	var g *gitFailure
	return errors.As(err, &c) || errors.As(err, &g)
}

// commitAuthor names the member who changed the pages last as a git author
// ("Name <email>"), and the names of any others, sorted. An editor whose
// account is gone is left out; one that cannot be read is an error, so the
// commit waits for a run that can name them.
func (s *Syncer) commitAuthor(ctx context.Context, db store.DB, editors map[string]int64) (author string, others []string, err error) {
	latest, at := "", int64(-1)
	for id, when := range editors {
		if when > at {
			latest, at = id, when
		}
	}
	for id := range editors {
		var u core.User
		if err := s.Store.Get(ctx, &u, store.Eq("id", id)); errors.Is(err, store.ErrNotFound) {
			continue
		} else if err != nil {
			return "", nil, fmt.Errorf("reading who edited the pages: %w", err)
		}
		if id != latest {
			others = append(others, u.Name)
			continue
		}
		email := u.Email
		if email == "" {
			var m core.Member
			if err := db.Get(ctx, &m, store.Eq("user_id", id)); err == nil {
				email = m.Handle + "@quadit.invalid" // an agent has no mailbox
			} else if !errors.Is(err, store.ErrNotFound) {
				return "", nil, fmt.Errorf("reading who edited the pages: %w", err)
			}
		}
		author = fmt.Sprintf("%s <%s>", strings.NewReplacer("<", "", ">", "").Replace(u.Name), email)
	}
	slices.Sort(others)
	return author, others, nil
}

// sentences joins what a sync says, leaving out what it does not.
func sentences(said ...string) string {
	return strings.Join(slices.DeleteFunc(said, func(s string) bool { return s == "" }), " ")
}

// oneLine is text on one line, its runs of white space made one space, cut
// at limit bytes on a rune boundary with "…" when it was longer.
func oneLine(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit] + "…"
}
