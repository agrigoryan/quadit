package reposync

// The working copy of a source's repository on the server's disk. Only this
// file knows that it is git: the commands, their flags, what they print and
// how they fail.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	// errNoSuchBranch: the repository has no branch by that name (yet).
	errNoSuchBranch = errors.New("the repository has no such branch")
	// errCheckedOut: the repository is not bare and has the branch pushed
	// to checked out, which git refuses to push to.
	errCheckedOut = errors.New("the repository has the branch checked out")
	// errOutside: a path would be reached through a link in the repository,
	// or a file stands where one of its folders would be.
	errOutside = errors.New("the path leads out of the working copy")
)

// workingCopy is one folder of a repository, checked out on the server: a
// clone holding the branch's last commit and, for a folder, only that
// folder, so a few pages do not cost the whole history of a large one.
type workingCopy struct {
	dir    string // the clone
	folder string // the folder under it, slash-separated; "" for all of it
	branch string // the branch it holds, once checked out
	log    *slog.Logger
}

// openWorkingCopy makes the working copy in dir if there is none yet, and
// points it at repo, whose address may have changed since.
func openWorkingCopy(ctx context.Context, dir, repo, folder string, log *slog.Logger) (*workingCopy, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, errors.New("git is not installed on the server")
	}
	w := &workingCopy{dir: dir, folder: folder, log: log}
	if _, serr := os.Stat(filepath.Join(dir, ".git")); serr != nil {
		if err := os.MkdirAll(filepath.Dir(dir), 0o750); err != nil {
			return nil, err
		}
		// The last commit only; any branch can still be fetched by name
		// afterwards, as from a whole clone.
		_, err := git(ctx, "", "clone", "--quiet", "--no-checkout", "--depth", "1", repo, dir)
		if err == nil {
			_, err = w.git(ctx, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
		}
		if err != nil {
			// A remote that cannot be cloned shallow is cloned whole. The
			// branch is fetched later: naming it here would fail on a
			// repository that does not have it yet.
			os.RemoveAll(dir)
			if _, err := git(ctx, "", "clone", "--quiet", "--no-checkout", repo, dir); err != nil {
				return nil, err
			}
		}
	}
	if _, err := w.git(ctx, "remote", "set-url", "origin", repo); err != nil {
		return nil, err
	}
	// Only the folder is checked out (a sparse checkout), or everything
	// again when there is no folder now. A git too old for it checks out
	// everything, as before.
	if folder == "" {
		// git config fails on a setting that was never made: then it is off.
		if on, err := w.git(ctx, "config", "--bool", "core.sparseCheckout"); err == nil && on == "true" {
			if _, err := w.git(ctx, "sparse-checkout", "disable"); err != nil {
				log.Info("repository sync: the checkout stays limited to a folder", "why", err)
			}
		}
	} else if _, err := w.git(ctx, "sparse-checkout", "set", "--cone", folder); err != nil {
		log.Info("repository sync: the whole repository is checked out", "why", err)
	}
	return w, nil
}

// mainBranch is the branch the repository itself calls its main one, or ""
// for a repository with no commits yet.
func (w *workingCopy) mainBranch(ctx context.Context) (string, error) {
	heads, err := w.git(ctx, "ls-remote", "--symref", "origin", "HEAD")
	if err != nil {
		return "", err
	}
	branch := ""
	for line := range strings.SplitSeq(heads, "\n") {
		if rest, ok := strings.CutPrefix(line, "ref: refs/heads/"); ok {
			branch = strings.Fields(rest)[0]
		}
	}
	return branch, nil
}

// checkout brings the working copy to what branch holds in the repository
// now, and nothing else: files an interrupted sync left behind would
// otherwise be read as if the repository had them. pushesTo is the branch
// commits will be pushed to; it need not exist yet. A branch the
// repository does not have is errNoSuchBranch.
func (w *workingCopy) checkout(ctx context.Context, branch, pushesTo string) error {
	w.branch = branch
	// Into a shallow working copy, the branch's last commit only. One made
	// whole, before working copies were shallow, stays whole.
	_, serr := os.Stat(filepath.Join(w.dir, ".git", "shallow"))
	shallow := serr == nil
	var err error
	if shallow {
		_, err = w.git(ctx, "fetch", "--quiet", "--depth", "1", "origin", branch)
	} else {
		_, err = w.git(ctx, "fetch", "--quiet", "origin", branch)
	}
	if failure, ok := errors.AsType[*gitFailure](err); ok && strings.Contains(failure.said, "couldn't find remote ref") {
		return errNoSuchBranch
	}
	if err != nil {
		return err
	}
	// Pushing over another branch needs to know where it is.
	if shallow && pushesTo != branch {
		_, _ = w.git(ctx, "fetch", "--quiet", "--depth", "1", "origin", pushesTo) // none yet is fine: there is nothing to push over
	}
	if err := w.reset(ctx); err != nil {
		return err
	}
	_, err = w.git(ctx, "clean", "--quiet", "-fd")
	return err
}

// reset takes the working copy back to what the repository's branch holds.
func (w *workingCopy) reset(ctx context.Context) error {
	_, err := w.git(ctx, "reset", "--quiet", "--hard", "origin/"+w.branch)
	return err
}

// head is the short name of the commit the working copy is at, or "" when
// it is at none.
func (w *workingCopy) head(ctx context.Context) string {
	out, err := w.git(ctx, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "" // at no commit
	}
	return out
}

// maxPageFile is the size from which a Markdown file is not taken as a page.
const maxPageFile = 2 << 20

// read reads every Markdown file under the folder. Whatever is stored, and
// whatever links the repository holds, nothing outside the checkout is ever
// read: a link may point anywhere on the server, and is not a page. A file
// that cannot be read stops the sync: read as missing, its page would be
// trashed.
func (w *workingCopy) read() (folder, error) {
	root := filepath.Join(w.dir, filepath.FromSlash(w.folder))
	if !staysInside(w.dir, root) {
		return folder{}, errors.New("the source's folder leads out of its repository, or goes through a link in it; set it to a real folder inside, such as docs")
	}
	info, serr := os.Stat(root)
	if w.folder != "" && serr == nil && !info.IsDir() {
		return folder{}, errors.New("the source's folder " + w.folder + " is a file in the repository; set it to a folder")
	}
	f := folder{files: map[string]string{}, taken: map[string]bool{}, missing: w.folder != "" && serr != nil}
	err := filepath.WalkDir(root, func(p string, e os.DirEntry, werr error) error {
		if werr != nil && p == root && errors.Is(werr, os.ErrNotExist) {
			return nil // no folder yet: no files
		}
		if werr != nil {
			return werr
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		name := e.Name()
		if e.Type()&os.ModeSymlink != 0 {
			f.taken[rel] = true
			return nil
		}
		if e.IsDir() {
			f.taken[rel] = true
			if strings.HasPrefix(name, ".") || name == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(name), ".md") {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if len(raw) < maxPageFile {
			f.files[rel] = string(raw)
		}
		return nil
	})
	return f, err
}

// write puts text in the file at path under the folder, making the folders
// it needs. A path reached through a link is errOutside.
func (w *workingCopy) write(path, text string) error {
	full := filepath.Join(w.dir, filepath.FromSlash(w.folder), filepath.FromSlash(path))
	if !staysInside(w.dir, full) {
		return errOutside
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(text), 0o640)
}

// remove removes the file at path under the folder, if it is there. Through
// a link, nothing is removed.
func (w *workingCopy) remove(path string) error {
	full := filepath.Join(w.dir, filepath.FromSlash(w.folder), filepath.FromSlash(path))
	if !staysInside(w.dir, full) {
		return nil
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// commitAndPush commits whatever changed in the working copy, as author
// when one is given ("Name <email>"), and pushes it over the branch target.
// It gives back the commit, or "" when nothing had changed after all. A push
// that fails takes the commit back; one to another branch than the checked
// out one leaves the working copy at that branch, as the commit lives on
// target only.
func (w *workingCopy) commitAndPush(ctx context.Context, message, author, target string) (string, error) {
	if _, err := w.git(ctx, "add", "--all", "."); err != nil {
		return "", err
	}
	status, err := w.git(ctx, "status", "--porcelain")
	if err != nil || status == "" {
		return "", err
	}
	commit := []string{"commit", "--quiet", "-m", message}
	if author != "" {
		commit = append(commit, "--author", author)
	}
	if _, err := w.git(ctx, commit...); err != nil {
		return "", err
	}
	if _, err := w.git(ctx, "push", "--quiet", "--force-with-lease", "origin", "HEAD:refs/heads/"+target); err != nil {
		if rerr := w.reset(ctx); rerr != nil {
			// The next sync's checkout resets it again.
			w.log.Warn("repository sync: taking back a commit that was not pushed", "err", rerr)
		}
		if failure, ok := errors.AsType[*gitFailure](err); ok && strings.Contains(failure.said, "checked out") {
			return "", errCheckedOut
		}
		return "", fmt.Errorf("the repository refused the push to %s: %w", target, err)
	}
	head := w.head(ctx)
	if target != w.branch {
		if err := w.reset(ctx); err != nil {
			// The next sync's checkout resets it again.
			w.log.Warn("repository sync: going back to the branch after a proposal", "err", err)
		}
	}
	return head, nil
}

// git runs one git command in the working copy.
func (w *workingCopy) git(ctx context.Context, args ...string) (string, error) {
	return git(ctx, w.dir, args...)
}

// git runs one git command in dir and gives back what it printed. A
// failure is a *gitFailure.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=Quadit", "GIT_AUTHOR_EMAIL=quadit@localhost",
		"GIT_COMMITTER_NAME=Quadit", "GIT_COMMITTER_EMAIL=quadit@localhost")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", &gitFailure{command: args[0], said: oneLine(strings.TrimSpace(string(out)), 300)}
	}
	return strings.TrimSpace(string(out)), nil
}

// gitFailure is a git command that failed, and what git said. Its message
// says what a person can do about it, where git's words make that clear.
type gitFailure struct {
	command string // clone, fetch, push…
	said    string
}

func (f *gitFailure) Error() string {
	said := f.said
	switch {
	case strings.Contains(said, "does not exist") || strings.Contains(said, "not found") && f.command == "clone" || strings.Contains(said, "Could not resolve host") ||
		strings.Contains(said, "does not appear to be a git repository") || strings.Contains(said, "unable to access") || strings.Contains(said, "Could not read from remote"):
		return fmt.Sprintf("the repository could not be found at that address; check it, and that the server may read it (git %s: %s)", f.command, said)
	case strings.Contains(said, "Authentication failed") || strings.Contains(said, "could not read Username") || strings.Contains(said, "Permission denied"):
		return fmt.Sprintf("the repository refused the server; give the source a token or key that may read it (git %s: %s)", f.command, said)
	}
	return fmt.Sprintf("git %s: %s", f.command, said)
}
