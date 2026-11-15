package server

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Labeled issues, made into tasks and kept in step with them.

// ghIssue is an issue as GitHub's API gives it.
type ghIssue struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	State       string `json:"state"`
	HTMLURL     string `json:"html_url"`
	UpdatedAt   string `json:"updated_at"`
	PullRequest any    `json:"pull_request"` // set when the "issue" is a pull request
}

// syncIssues makes a task of each labeled issue and keeps it in step
// with the issue: its title and text, and whether it is closed.
func (g *githubSync) syncIssues(ctx context.Context) (int, error) {
	if g.cfg.IssuesLabel == "" {
		return 0, nil
	}
	project := g.cfg.IssuesProject
	if project == "" {
		var p core.Project
		there := false
		if g.in.ProjectID != "" {
			var err error
			if there, err = store.Find(ctx, g.db, &p, store.Eq("id", g.in.ProjectID), store.Live); err != nil {
				return 0, err
			}
		}
		if !there {
			return 0, errors.New("issues are turned into tasks in a project: set issues_project to its key")
		}
		project = p.Key
	}
	if g.state.IssueTasks == nil {
		g.state.IssueTasks = map[string]string{}
	}
	q := "/repos/" + g.cfg.Repo + "/issues?state=all&sort=updated&direction=desc&per_page=50"
	if g.cfg.IssuesLabel != "*" {
		q += "&labels=" + url.QueryEscape(g.cfg.IssuesLabel)
	}
	if g.state.IssuesSince != "" {
		q += "&since=" + url.QueryEscape(g.state.IssuesSince)
	}
	var issues []ghIssue
	if err := g.gh.call(ctx, "GET", q, nil, &issues); err != nil {
		return 0, err
	}
	newest, handled := g.state.IssuesSince, 0
	// Oldest first, so tasks are numbered in the order the issues changed.
	for _, is := range slices.Backward(issues) {
		if is.PullRequest != nil || is.UpdatedAt <= g.state.IssuesSince {
			continue
		}
		if is.UpdatedAt > newest {
			newest = is.UpdatedAt
		}
		err := g.s.eng.System(ctx, g.in.WorkspaceID, g.in.CreatedBy, func(sys *engine.Sys) error {
			return g.issueTask(ctx, sys, project, is)
		})
		if err != nil {
			return handled, fmt.Errorf("issue #%d: %w", is.Number, err)
		}
		handled++
	}
	g.state.IssuesSince = newest
	return handled, nil
}

// taskOfIssue finds the task made from an issue, or makes it, in the given
// project, with the issue's text and a link to it.
func (g *githubSync) taskOfIssue(ctx context.Context, sys *engine.Sys, project string, is ghIssue, text string) (core.Task, error) {
	num := strconv.Itoa(is.Number)
	var t core.Task
	if known := g.state.IssueTasks[num]; known != "" {
		there, err := store.Find(ctx, sys.Tx(), &t, store.Eq("id", known))
		if err != nil || there {
			return t, err
		}
	}
	tid := id.From("github-issue", g.in.ID, num) // the same issue is the same task, whatever happens between
	there, err := store.Find(ctx, sys.Tx(), &t, store.Eq("id", tid))
	if err != nil {
		return t, err
	}
	if !there {
		if err := sys.Do("task.create", map[string]any{"id": tid, "project": project, "title": is.Title, "description": text}); err != nil {
			return t, err
		}
		if err := sys.Do("link.set", map[string]any{"task": tid, "kind": "issue", "repo": g.cfg.Repo, "ref": num, "url": is.HTMLURL, "title": is.Title, "state": is.State}); err != nil {
			return t, err
		}
		if err := sys.Tx().Get(ctx, &t, store.Eq("id", tid)); err != nil {
			return t, err
		}
	}
	g.state.IssueTasks[num] = t.ID
	return t, nil
}

// issueTask makes the task of one issue, in the given project, when the
// issue has none yet, and brings a task it has up to date with the issue.
func (g *githubSync) issueTask(ctx context.Context, sys *engine.Sys, project string, is ghIssue) error {
	num := strconv.Itoa(is.Number)
	text := strings.TrimSpace(is.Body)
	if text != "" {
		text += "\n\n"
	}
	text += fmt.Sprintf("From GitHub issue [%s#%d](%s).", g.cfg.Repo, is.Number, is.HTMLURL)
	t, err := g.taskOfIssue(ctx, sys, project, is, text)
	if err != nil {
		return err
	}
	if t.DeletedAt != 0 {
		return nil // deleted here on purpose: the issue does not bring it back
	}
	set := map[string]any{"id": t.ID}
	if t.Title != is.Title {
		set["title"] = is.Title
	}
	if t.Description != text {
		set["description"] = text
	}
	var cur core.Status
	if err := sys.Tx().Get(ctx, &cur, store.Eq("id", t.StatusID)); err != nil {
		return err
	}
	switch open := core.OpenCategory(cur.Category); {
	case is.State == "closed" && open:
		set["status"] = core.CatDone
	case is.State == "open" && !open:
		set["status"] = core.CatUnstarted
	}
	if len(set) > 1 {
		if err := sys.Do("task.update", set); err != nil {
			return err
		}
	}
	return sys.Do("link.set", map[string]any{"task": t.ID, "kind": "issue", "repo": g.cfg.Repo, "ref": num, "url": is.HTMLURL, "title": is.Title, "state": is.State})
}
