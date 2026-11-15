package server

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

type ghIssue struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	State       string `json:"state"`
	HTMLURL     string `json:"html_url"`
	UpdatedAt   string `json:"updated_at"`
	PullRequest any    `json:"pull_request"` // set when the "issue" is a pull request
}

// syncIssues makes a task of each labelled issue and keeps it in step
// with the issue: its title and text, and whether it is closed.
func (g *githubSync) syncIssues(ctx context.Context) (int, error) {
	if g.cfg.IssuesLabel == "" {
		return 0, nil
	}
	project := g.cfg.IssuesProject
	if project == "" {
		var p core.Project
		if g.in.ProjectID == "" || g.db.Get(ctx, &p, store.Eq("id", g.in.ProjectID), store.Live) != nil {
			return 0, errors.New("issues are turned into tasks in a project: set issues_project to its key")
		}
		project = p.Key
	}
	if g.st.IssueTasks == nil {
		g.st.IssueTasks = map[string]string{}
	}
	q := "/repos/" + g.cfg.Repo + "/issues?state=all&sort=updated&direction=desc&per_page=50"
	if g.cfg.IssuesLabel != "*" {
		q += "&labels=" + url.QueryEscape(g.cfg.IssuesLabel)
	}
	if g.st.IssuesSince != "" {
		q += "&since=" + url.QueryEscape(g.st.IssuesSince)
	}
	var issues []ghIssue
	if err := g.gh.call(ctx, "GET", q, nil, &issues); err != nil {
		return 0, err
	}
	newest, handled := g.st.IssuesSince, 0
	// Oldest first, so tasks are numbered in the order the issues changed.
	for i := len(issues) - 1; i >= 0; i-- {
		is := issues[i]
		if is.PullRequest != nil || is.UpdatedAt <= g.st.IssuesSince {
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
	g.st.IssuesSince = newest
	return handled, nil
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
	var t core.Task
	known := g.st.IssueTasks[num] != "" && sys.Tx().Get(ctx, &t, store.Eq("id", g.st.IssueTasks[num])) == nil
	if !known {
		tid := id.From("github-issue", g.in.ID, num) // the same issue is the same task, whatever happens between
		if sys.Tx().Get(ctx, &t, store.Eq("id", tid)) != nil {
			if err := sys.Do("task.create", map[string]any{"id": tid, "project": project, "title": is.Title, "description": text}); err != nil {
				return err
			}
			if err := sys.Do("link.set", map[string]any{"task": tid, "kind": "issue", "repo": g.cfg.Repo, "ref": num, "url": is.HTMLURL, "title": is.Title, "state": is.State}); err != nil {
				return err
			}
			if err := sys.Tx().Get(ctx, &t, store.Eq("id", tid)); err != nil {
				return err
			}
		}
		g.st.IssueTasks[num] = t.ID
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
