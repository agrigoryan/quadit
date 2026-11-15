package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

// A folder of Markdown files in a git repository can be a set of pages.
// Each file is one page; each directory is a page that holds them. A sync
// brings file changes into pages and page changes into commits. When both
// sides changed the same page, the source's authority says which wins.
//
// The server uses the git on its machine, with whatever access that has.

func init() {
	runners = append(runners, (*Server).runSources)
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/w/{ws}/sources/{id}/sync", s.in(s.hSourceSync))
		m.HandleFunc("GET /api/v1/w/{ws}/sources", s.in(func(x *c) error {
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

func (s *Server) hSourceSync(x *c) error {
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

func sha(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

// git runs one git command in dir and returns what it printed.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=Quadit", "GIT_AUTHOR_EMAIL=quadit@localhost",
		"GIT_COMMITTER_NAME=Quadit", "GIT_COMMITTER_EMAIL=quadit@localhost")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %s", args[0], oneLine(strings.TrimSpace(string(out)), 300))
	}
	return strings.TrimSpace(string(out)), nil
}

type syncResult struct {
	PagesUpdated int    `json:"pages_updated"`
	PagesCreated int    `json:"pages_created"`
	PagesTrashed int    `json:"pages_trashed"`
	FilesWritten int    `json:"files_written"`
	Commit       string `json:"commit"`
	Pushed       string `json:"pushed,omitempty"`
}

// hashes are what was the same on both sides at the last sync, stored as
// "file:page". The file's text and the page's Markdown differ in spelling
// (spacing, list markers), so each is compared with its own hash.
func splitHashes(h string) (file, page string) {
	file, page, _ = strings.Cut(h, ":")
	return
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
	dir := filepath.Join(s.cfg.DataDir, "repos", src.ID)
	if _, serr := os.Stat(filepath.Join(dir, ".git")); serr != nil {
		if err := os.MkdirAll(filepath.Dir(dir), 0o750); err != nil {
			return res, err
		}
		args := []string{"clone", "--quiet"}
		if src.Branch != "" {
			args = append(args, "--branch", src.Branch)
		}
		if _, err := git(ctx, "", append(args, src.Repo, dir)...); err != nil {
			return res, err
		}
	}
	// The source may have been pointed at another repository since the clone.
	if _, err := git(ctx, dir, "remote", "set-url", "origin", src.Repo); err != nil {
		return res, err
	}
	branch := src.Branch
	if branch == "" {
		if branch, err = git(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD"); err != nil {
			return res, err
		}
	}
	if _, err := git(ctx, dir, "fetch", "--quiet", "origin", branch); err != nil {
		return res, err
	}
	if _, err := git(ctx, dir, "reset", "--quiet", "--hard", "origin/"+branch); err != nil {
		return res, err
	}
	root := filepath.Join(dir, filepath.FromSlash(src.Subdir))
	files := map[string]string{} // path under the folder -> text
	err = filepath.WalkDir(root, func(p string, e os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		name := e.Name()
		if e.IsDir() {
			if p != root && (strings.HasPrefix(name, ".") || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(name), ".md") {
			if raw, rerr := os.ReadFile(p); rerr == nil && len(raw) < 2<<20 {
				rel, _ := filepath.Rel(root, p)
				files[filepath.ToSlash(rel)] = string(raw)
			}
		}
		return nil
	})
	if err != nil {
		return res, err
	}

	var pages []core.Doc
	if err := db.List(ctx, &pages, store.Where(store.Eq("source_id", src.ID))); err != nil {
		return res, err
	}
	byPath := map[string]core.Doc{}
	byID := map[string]core.Doc{}
	for _, p := range pages {
		byID[p.ID] = p
		if p.SourcePath != "" && (p.DeletedAt == 0 || byPath[p.SourcePath].ID == "") {
			byPath[p.SourcePath] = p
		}
	}
	pageMD := func(docID string) (string, error) {
		var blocks []core.Block
		if err := db.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", docID), store.Live}, Order: "rank"}); err != nil {
			return "", err
		}
		return md.Render(engine.BlockTree(blocks)), nil
	}
	toWrite := map[string]string{} // path -> text to put in the repository
	var toRemove []string
	written := map[string]string{} // doc id -> page hash, set after a push
	editors := map[string]int64{}  // who last changed the pages being written, and when

	err = s.eng.System(ctx, src.WorkspaceID, src.CreatedBy, func(sys *engine.Sys) error {
		tx := sys.Tx()
		// dirPage finds or makes the page for a directory.
		var dirPage func(dir string) (string, error)
		dirPage = func(d string) (string, error) {
			if d == "." || d == "" {
				return src.RootDocID, nil
			}
			if p, ok := byPath[d+"/"]; ok && p.DeletedAt == 0 {
				return p.ID, nil
			}
			parent, err := dirPage(filepath.ToSlash(filepath.Dir(d)))
			if err != nil {
				return "", err
			}
			if err := sys.Do("doc.create", map[string]any{"parent": parent, "title": filepath.Base(d)}); err != nil {
				return "", err
			}
			pid := sys.Ref()
			if _, err := tx.Update(ctx, "docs", map[string]any{"source_id": src.ID, "source_path": d + "/"}, store.Eq("id", pid)); err != nil {
				return "", err
			}
			byPath[d+"/"] = core.Doc{ID: pid, SourcePath: d + "/"}
			return pid, nil
		}
		paths := make([]string, 0, len(files))
		for p := range files {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, path := range paths {
			text := files[path]
			fileHash := sha(text)
			page, known := byPath[path]
			if !known || page.DeletedAt != 0 && page.SourceHash == "" {
				parent, err := dirPage(filepath.ToSlash(filepath.Dir(path)))
				if err != nil {
					return err
				}
				if err := sys.Do("doc.create", map[string]any{"parent": parent, "title": strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), "markdown": text}); err != nil {
					return err
				}
				pid := sys.Ref()
				body, err := mdOf(ctx, tx, pid)
				if err != nil {
					return err
				}
				if _, err := tx.Update(ctx, "docs", map[string]any{"source_id": src.ID, "source_path": path, "source_hash": fileHash + ":" + sha(body)}, store.Eq("id", pid)); err != nil {
					return err
				}
				res.PagesCreated++
				continue
			}
			lastFile, lastPage := splitHashes(page.SourceHash)
			if page.DeletedAt != 0 {
				// The page went to the trash here: the file goes too, unless
				// the file changed since and the repository has the say.
				if fileHash == lastFile || src.Authority == "pages" {
					toRemove = append(toRemove, path)
				}
				continue
			}
			body, err := pageMD(page.ID)
			if err != nil {
				return err
			}
			pageChanged := sha(body) != lastPage
			fileChanged := fileHash != lastFile
			switch {
			case fileChanged && (!pageChanged || src.Authority == "repo"):
				if err := sys.Do("doc.write", map[string]any{"doc": page.ID, "markdown": text}); err != nil {
					return err
				}
				if body, err = mdOf(ctx, tx, page.ID); err != nil {
					return err
				}
				if _, err := tx.Update(ctx, "docs", map[string]any{"source_hash": fileHash + ":" + sha(body)}, store.Eq("id", page.ID)); err != nil {
					return err
				}
				res.PagesUpdated++
			case pageChanged:
				toWrite[path] = body
				written[page.ID] = sha(body)
				if page.UpdatedBy != "" && page.UpdatedAt >= editors[page.UpdatedBy] {
					editors[page.UpdatedBy] = page.UpdatedAt
				}
			}
		}
		// Pages with no file: new here, or their file was deleted there.
		for _, page := range pages {
			if page.DeletedAt != 0 || page.ID == src.RootDocID || strings.HasSuffix(page.SourcePath, "/") {
				continue
			}
			if _, has := files[page.SourcePath]; has && page.SourcePath != "" {
				continue
			}
			if page.SourcePath != "" && page.SourceHash != "" {
				if err := sys.Do("doc.delete", map[string]any{"id": page.ID}); err != nil {
					return err
				}
				res.PagesTrashed++
				continue
			}
			// A page made in the app: give it a file beside its parent's.
			dirOf := ""
			if parent, ok := byID[page.ParentID]; ok && strings.HasSuffix(parent.SourcePath, "/") {
				dirOf = parent.SourcePath
			}
			path := dirOf + slugFrom(orText(page.Title, "untitled")) + ".md"
			for n := 2; files[path] != "" || toWrite[path] != ""; n++ {
				path = fmt.Sprintf("%s%s-%d.md", dirOf, slugFrom(page.Title), n)
			}
			body, err := pageMD(page.ID)
			if err != nil {
				return err
			}
			if _, err := tx.Update(ctx, "docs", map[string]any{"source_path": path}, store.Eq("id", page.ID)); err != nil {
				return err
			}
			toWrite[path] = body
			written[page.ID] = sha(body)
			if page.UpdatedBy != "" && page.UpdatedAt >= editors[page.UpdatedBy] {
				editors[page.UpdatedBy] = page.UpdatedAt
			}
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	res.Commit, _ = git(ctx, dir, "rev-parse", "--short", "HEAD")
	if (len(toWrite) == 0 && len(toRemove) == 0) || src.WriteMode == "none" {
		return res, nil
	}
	for path, text := range toWrite {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			return res, err
		}
		if err := os.WriteFile(full, []byte(text), 0o640); err != nil {
			return res, err
		}
	}
	for _, path := range toRemove {
		os.Remove(filepath.Join(root, filepath.FromSlash(path)))
	}
	if _, err := git(ctx, dir, "add", "--all", "."); err != nil {
		return res, err
	}
	if status, _ := git(ctx, dir, "status", "--porcelain"); status == "" {
		return res, nil
	}
	n := len(toWrite) + len(toRemove)
	// The commit carries the name of whoever changed the pages last; the
	// others who changed pages in it are named in its message.
	message := fmt.Sprintf("docs: update %d page(s) from Quadit", n)
	author, others := s.commitAuthor(ctx, db, editors)
	if len(others) > 0 {
		message += "\n\nAlso edited by: " + strings.Join(others, ", ")
	}
	commit := []string{"commit", "--quiet", "-m", message}
	if author != "" {
		commit = append(commit, "--author", author)
	}
	if _, err := git(ctx, dir, commit...); err != nil {
		return res, err
	}
	target := branch
	if src.WriteMode == "propose" {
		target = "quadit/docs"
	}
	if _, err := git(ctx, dir, "push", "--quiet", "--force-with-lease", "origin", "HEAD:refs/heads/"+target); err != nil {
		git(ctx, dir, "reset", "--quiet", "--hard", "origin/"+branch)
		if strings.Contains(err.Error(), "checked out") {
			return res, fmt.Errorf("the repository is a working copy with %s checked out, and git lets nobody push to that. Sync with a bare repository or a hosted one, or set write_mode to \"propose\" so page edits go to the branch quadit/docs", target)
		}
		return res, fmt.Errorf("the repository refused the push to %s: %w", target, err)
	}
	res.FilesWritten, res.Pushed = n, target
	res.Commit, _ = git(ctx, dir, "rev-parse", "--short", "HEAD")
	// What was pushed is now the common ground for those pages.
	for docID, pageHash := range written {
		var d core.Doc
		if db.Get(ctx, &d, store.Eq("id", docID)) != nil {
			continue
		}
		fileHash := pageHash
		if text, ok := toWrite[d.SourcePath]; ok {
			fileHash = sha(text)
		}
		if src.WriteMode == "propose" {
			// The branch still has the old file until the proposal is merged.
			old, _ := splitHashes(d.SourceHash)
			fileHash = old
		}
		db.Update(ctx, "docs", map[string]any{"source_hash": fileHash + ":" + pageHash}, store.Eq("id", docID))
	}
	for _, path := range toRemove {
		if p, ok := byPath[path]; ok {
			db.Update(ctx, "docs", map[string]any{"source_hash": "", "source_path": ""}, store.Eq("id", p.ID))
		}
	}
	if src.WriteMode == "propose" {
		git(ctx, dir, "reset", "--quiet", "--hard", "origin/"+branch)
	}
	return res, nil
}

// mdOf renders a page inside a write, seeing what the write just did.
func mdOf(ctx context.Context, tx store.Tx, docID string) (string, error) {
	var blocks []core.Block
	if err := tx.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", docID), store.Live}, Order: "rank"}); err != nil {
		return "", err
	}
	return md.Render(engine.BlockTree(blocks)), nil
}

// commitAuthor names the member who changed the pages last as a git author
// ("Name <email>"), and the names of any others.
func (s *Server) commitAuthor(ctx context.Context, db store.DB, editors map[string]int64) (author string, others []string) {
	latest, at := "", int64(-1)
	for id, when := range editors {
		if when > at {
			latest, at = id, when
		}
	}
	for id := range editors {
		var u core.User
		if err := s.st.Get(ctx, &u, store.Eq("id", id)); err != nil {
			continue
		}
		if id != latest {
			others = append(others, u.Name)
			continue
		}
		email := u.Email
		if email == "" {
			var m core.Member
			if db.Get(ctx, &m, store.Eq("user_id", id)) == nil {
				email = m.Handle + "@quadit.invalid" // an agent has no mailbox
			}
		}
		author = fmt.Sprintf("%s <%s>", strings.NewReplacer("<", "", ">", "").Replace(u.Name), email)
	}
	sort.Strings(others)
	return author, others
}
