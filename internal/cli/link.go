package cli

import (
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var branchKey = regexp.MustCompile(`(?i)\b([a-z][a-z0-9]{1,9}-\d+)\b`)

func gitOut(args ...string) (string, error) {
	out, err := exec.Command("git", args...).Output()
	return strings.TrimSpace(string(out)), err
}

// link ties the git branch in the current directory to a task: its name,
// its commits ahead of the main branch, and whether it is merged. It needs
// no hosting service, only a local repository.
func (r *runner) link(in input) error {
	pos := in.pos
	if len(pos) == 2 && strings.Contains(pos[1], "://") {
		_, err := r.change("link.set", map[string]any{"task": pos[0], "kind": "url", "url": pos[1]}, in.approval)
		return err
	}
	branch, err := gitOut("rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return errors.New("this is not a git repository; run it inside one, or give a URL: quadit link KEY URL")
	}
	key := ""
	if len(pos) > 0 {
		key = pos[0]
	} else if m := branchKey.FindString(branch); m != "" {
		key = strings.ToUpper(m)
	} else {
		return fmt.Errorf("the branch %q does not name a task; give the key: quadit link KEY", branch)
	}
	repo := gitRepo()
	base := gitBase()
	var commits []gitCommit
	state := "open"
	if base != "" {
		commits = gitAhead(base)
		if len(commits) == 0 && branch != strings.TrimPrefix(base, "origin/") {
			if _, err := gitOut("merge-base", "--is-ancestor", "HEAD", base); err == nil {
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
	_, err = r.change("link.set", args, in.approval)
	return err
}

// gitRepo is the repository as its origin names it (owner/name), or the
// name of its folder when it has no origin.
func gitRepo() string {
	repo, _ := gitOut("remote", "get-url", "origin")
	repo = strings.TrimSuffix(repo, ".git")
	if i := strings.LastIndexAny(repo, ":"); i >= 0 && !strings.Contains(repo, "://") {
		repo = repo[i+1:] // git@host:owner/name
	} else if u, perr := url.Parse(repo); perr == nil && u.Host != "" {
		repo = strings.Trim(u.Path, "/")
	}
	if repo == "" {
		top, _ := gitOut("rev-parse", "--show-toplevel")
		repo = filepath.Base(top)
	}
	return repo
}

// gitBase is the main branch, the one a branch's commits are counted
// from: the first of the usual names that exists, or "" when none does.
func gitBase() string {
	for _, cand := range []string{"origin/HEAD", "origin/main", "origin/master", "main", "master"} {
		if _, err := gitOut("rev-parse", "--verify", "--quiet", cand); err == nil {
			return cand
		}
	}
	return ""
}

type gitCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
}

// gitAhead lists the commits HEAD has that base does not, newest first,
// fifty at most.
func gitAhead(base string) []gitCommit {
	var commits []gitCommit
	log, _ := gitOut("log", "--format=%h%x09%s", "-n", "50", base+"..HEAD")
	for _, line := range strings.Split(log, "\n") {
		if sha, subject, ok := strings.Cut(line, "\t"); ok {
			commits = append(commits, gitCommit{sha, subject})
		}
	}
	return commits
}
