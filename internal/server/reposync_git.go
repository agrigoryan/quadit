package server

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

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
		said := oneLine(strings.TrimSpace(string(out)), 300)
		switch {
		case strings.Contains(said, "does not exist") || strings.Contains(said, "not found") && args[0] == "clone" || strings.Contains(said, "Could not resolve host") ||
			strings.Contains(said, "does not appear to be a git repository") || strings.Contains(said, "unable to access") || strings.Contains(said, "Could not read from remote"):
			return "", fmt.Errorf("the repository could not be found at that address; check it, and that the server may read it (git %s: %s)", args[0], said)
		case strings.Contains(said, "Authentication failed") || strings.Contains(said, "could not read Username") || strings.Contains(said, "Permission denied"):
			return "", fmt.Errorf("the repository refused the server; give the source a token or key that may read it (git %s: %s)", args[0], said)
		}
		return "", fmt.Errorf("git %s: %s", args[0], said)
	}
	return strings.TrimSpace(string(out)), nil
}

// git runs one git command in the sync's working copy.
func (r *syncRun) git(args ...string) (string, error) {
	return git(r.ctx, r.dir, args...)
}

// head is the short name of the commit the working copy is at, or nothing
// when it is at none.
func (r *syncRun) head() string {
	out, _ := r.git("rev-parse", "--short", "HEAD")
	return out
}

// resetToBranch takes the working copy back to what the repository's branch
// holds.
func (r *syncRun) resetToBranch() error {
	_, err := r.git("reset", "--quiet", "--hard", "origin/"+r.branch)
	return err
}

// clone makes the working copy if the server has none yet, and points it at
// the source's repository. A working copy holds the branch's last commit
// and, for a source with a folder, only that folder: a few pages should not
// cost the whole history of a large repository.
func (r *syncRun) clone() error {
	if _, serr := os.Stat(filepath.Join(r.dir, ".git")); serr != nil {
		if err := os.MkdirAll(filepath.Dir(r.dir), 0o750); err != nil {
			return err
		}
		if err := r.cloneShallow(); err != nil {
			// A remote that cannot be cloned shallow is cloned whole.
			os.RemoveAll(r.dir)
			// The branch is fetched below: naming it here would fail on a
			// repository that does not have it yet.
			if _, err := git(r.ctx, "", "clone", "--quiet", "--no-checkout", r.src.Repo, r.dir); err != nil {
				return err
			}
		}
	}
	// The source may have been pointed at another repository since the clone.
	if _, err := r.git("remote", "set-url", "origin", r.src.Repo); err != nil {
		return err
	}
	r.keepToFolder()
	return nil
}

// cloneShallow clones the last commit only. Any branch can still be
// fetched by name afterwards, as from a whole clone.
func (r *syncRun) cloneShallow() error {
	if _, err := git(r.ctx, "", "clone", "--quiet", "--no-checkout", "--depth", "1", r.src.Repo, r.dir); err != nil {
		return err
	}
	_, err := r.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
	return err
}

// shallow reports whether the working copy holds only the last commits.
// One made whole, before working copies were shallow, stays whole.
func (r *syncRun) shallow() bool {
	_, err := os.Stat(filepath.Join(r.dir, ".git", "shallow"))
	return err == nil
}

// keepToFolder checks out only the source's folder (a sparse checkout), or
// everything again for a source that has none now. A git too old for it
// checks out everything, as before.
func (r *syncRun) keepToFolder() {
	if r.src.Subdir == "" {
		if on, _ := r.git("config", "--bool", "core.sparseCheckout"); on == "true" {
			r.git("sparse-checkout", "disable")
		}
		return
	}
	if _, err := r.git("sparse-checkout", "set", "--cone", r.src.Subdir); err != nil {
		r.s.log.Info("repository sync: the whole repository is checked out", "source", r.src.ID, "why", err)
	}
}

// fetch brings the branch from the repository: its last commit only, into a
// shallow working copy. A source that proposes also needs to know where its
// proposal branch is, to push over it.
func (r *syncRun) fetch() error {
	if !r.shallow() {
		_, err := r.git("fetch", "--quiet", "origin", r.branch)
		return err
	}
	if _, err := r.git("fetch", "--quiet", "--depth", "1", "origin", r.branch); err != nil {
		return err
	}
	if r.src.WriteMode == "propose" {
		r.git("fetch", "--quiet", "--depth", "1", "origin", "quadit/docs") // none yet is fine
	}
	return nil
}

// findBranch settles which branch is synced: the source's, or else the one
// the repository itself calls its main one.
func (r *syncRun) findBranch() error {
	r.branch = r.src.Branch
	if r.branch != "" {
		return nil
	}
	// The branch the repository itself calls its main one. A repository
	// with no commits yet has none: there is nothing to sync until it does.
	heads, err := r.git("ls-remote", "--symref", "origin", "HEAD")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(heads, "\n") {
		if rest, ok := strings.CutPrefix(line, "ref: refs/heads/"); ok {
			r.branch = strings.Fields(rest)[0]
		}
	}
	if r.branch == "" {
		r.res.Note = "the repository has no commits yet; pages will sync once it has"
		r.done = true
	}
	return nil
}

// checkout brings the working copy to what the branch holds in the
// repository now.
func (r *syncRun) checkout() error {
	if err := r.fetch(); err != nil {
		if strings.Contains(err.Error(), "couldn't find remote ref") {
			r.res.Note = "the repository has no branch " + r.branch + " yet; pages will sync once it has"
			r.done = true
			return nil
		}
		return err
	}
	if err := r.resetToBranch(); err != nil {
		return err
	}
	// Nothing but what the branch holds: files an interrupted sync left
	// behind would otherwise be read as if the repository had them.
	_, err := r.git("clean", "--quiet", "-fd")
	return err
}

// commitAndPush makes one commit of what writeOut changed in the working
// copy and pushes it: to the branch, or to quadit/docs when the source only
// proposes. A sync that changed nothing after all ends here.
func (r *syncRun) commitAndPush() error {
	if _, err := r.git("add", "--all", "."); err != nil {
		return err
	}
	if status, _ := r.git("status", "--porcelain"); status == "" {
		r.done = true
		return nil
	}
	if err := r.commit(); err != nil {
		return err
	}
	target := r.branch
	if r.src.WriteMode == "propose" {
		target = "quadit/docs"
	}
	if _, err := r.git("push", "--quiet", "--force-with-lease", "origin", "HEAD:refs/heads/"+target); err != nil {
		r.resetToBranch()
		if strings.Contains(err.Error(), "checked out") {
			return fmt.Errorf("the repository is a working copy with %s checked out, and git lets nobody push to that. Sync with a bare repository or a hosted one, or set write_mode to \"propose\" so page edits go to the branch quadit/docs", target)
		}
		return fmt.Errorf("the repository refused the push to %s: %w", target, err)
	}
	r.res.FilesWritten, r.res.FilesRemoved, r.res.Pushed = len(r.toWrite), len(r.toRemove), target
	if r.noFolder != "" && len(r.toWrite) > 0 {
		r.res.Note = strings.TrimSpace(strings.Replace(r.res.Note, r.noFolder, "", 1)) // it has the folder now
	}
	r.res.Commit = r.head()
	return nil
}

// commit commits what is staged in the working copy.
func (r *syncRun) commit() error {
	n := len(r.toWrite) + len(r.toRemove)
	// The commit carries the name of whoever changed the pages last; the
	// others who changed pages in it are named in its message.
	message := fmt.Sprintf("docs: update %d page(s) from Quadit", n)
	author, others := r.s.commitAuthor(r.ctx, r.db, r.editors)
	if len(others) > 0 {
		message += "\n\nAlso edited by: " + strings.Join(others, ", ")
	}
	commit := []string{"commit", "--quiet", "-m", message}
	if author != "" {
		commit = append(commit, "--author", author)
	}
	_, err := r.git(commit...)
	return err
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

// dropProposal takes the working copy back to the branch after a proposal
// was pushed: the proposed commit lives on quadit/docs, not here.
func (r *syncRun) dropProposal() error {
	if r.src.WriteMode == "propose" {
		r.resetToBranch()
	}
	return nil
}
