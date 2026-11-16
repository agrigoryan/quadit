// The link command: tying a git branch, a URL or a page to a task.

package cli

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// branchKey finds a task key in a branch's name (sva-12-fix-login).
var branchKey = regexp.MustCompile(`(?i)\b([a-z][a-z0-9]{1,9}-\d+)\b`)

// gitOutput runs git in the current directory and gives what it printed.
func gitOutput(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", args...).Output()
	return strings.TrimSpace(string(out)), err
}

// gitAnswer is what git printed, or nothing when it failed: for the
// questions where git failing (no origin, nothing to log) means there is
// nothing to say.
func gitAnswer(ctx context.Context, args ...string) string {
	out, err := gitOutput(ctx, args...)
	if err != nil {
		return ""
	}
	return out
}

// link ties the git branch in the current directory to a task: its name,
// its commits ahead of the main branch, and whether it is merged. It needs
// no hosting service, only a local repository. Given a URL, or page=ID, it
// links that instead.
func (r *runner) link(in input) error {
	pos := in.pos
	if page := in.f["page"]; len(page) > 0 {
		if len(pos) != 1 {
			return errors.New("name the task: quadit link KEY page=ID")
		}
		return r.change("link.set", map[string]any{"task": pos[0], "kind": "doc", "ref": page[0]}, in.approval)
	}
	if len(pos) == 2 && strings.Contains(pos[1], "://") {
		return r.change("link.set", map[string]any{"task": pos[0], "kind": "url", "url": pos[1]}, in.approval)
	}
	branch, err := gitOutput(r.ctx, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return errors.New("this is not a git repository; run it inside one, or give a URL: quadit link KEY URL")
	}
	var key string
	switch m := branchKey.FindString(branch); {
	case len(pos) > 0:
		key = pos[0]
	case m != "":
		key = strings.ToUpper(m)
	default:
		return fmt.Errorf("the branch %q does not name a task; give the key: quadit link KEY", branch)
	}
	repo := gitRepo(r.ctx)
	base := gitBase(r.ctx)
	var commits []gitCommit
	state := "open"
	if base != "" {
		commits = gitAhead(r.ctx, base)
		if len(commits) == 0 && branch != strings.TrimPrefix(base, "origin/") {
			if _, err := gitOutput(r.ctx, "merge-base", "--is-ancestor", "HEAD", base); err == nil {
				state = "merged"
			}
		}
	}
	// The link is called by its branch; what was committed is in its commits.
	args := map[string]any{"task": key, "kind": "branch", "repo": repo, "ref": branch, "state": state, "title": branch}
	if state != "merged" {
		// Once merged nothing is ahead any more: the commits listed while
		// the branch was open stay on the link as they were.
		args["data"] = map[string]any{"commits": commits, "ahead": len(commits), "base": base}
	}
	return r.change("link.set", args, in.approval)
}

// gitRepo is the repository as its origin names it (owner/name), or the
// name of its folder when it has no origin.
func gitRepo(ctx context.Context) string {
	repo := gitAnswer(ctx, "remote", "get-url", "origin")
	repo = strings.TrimSuffix(repo, ".git")
	if i := strings.LastIndexAny(repo, ":"); i >= 0 && !strings.Contains(repo, "://") {
		repo = repo[i+1:] // git@host:owner/name
	} else if u, perr := url.Parse(repo); perr == nil && u.Host != "" {
		repo = strings.Trim(u.Path, "/")
	}
	if repo == "" {
		repo = filepath.Base(gitAnswer(ctx, "rev-parse", "--show-toplevel"))
	}
	return repo
}

// gitBase is the main branch, the one a branch's commits are counted
// from: the first of the usual names that exists, or "" when none does.
func gitBase(ctx context.Context) string {
	for _, cand := range []string{"origin/HEAD", "origin/main", "origin/master", "main", "master"} {
		if _, err := gitOutput(ctx, "rev-parse", "--verify", "--quiet", cand); err == nil {
			return cand
		}
	}
	return ""
}

// gitCommit is one commit of a branch, as the link lists it.
type gitCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
}

// gitAhead lists the commits HEAD has that base does not, newest first,
// fifty at most.
func gitAhead(ctx context.Context, base string) []gitCommit {
	var commits []gitCommit
	log := gitAnswer(ctx, "log", "--format=%h%x09%s", "-n", "50", base+"..HEAD")
	for line := range strings.SplitSeq(log, "\n") {
		if sha, subject, ok := strings.Cut(line, "\t"); ok {
			commits = append(commits, gitCommit{sha, subject})
		}
	}
	return commits
}
