package importer

import (
	"fmt"
	"strconv"
	"strings"
)

// github reads a repository's issues (not its pull requests) with their
// comments, from GitHub's API. The source is owner/repo.
type github struct{}

func (github) Kind() string { return "github" }

type githubIssue struct {
	Number      int
	Title, Body string
	State       string
	HTMLURL     string `json:"html_url"`
	Comments    int
	PullRequest *struct{} `json:"pull_request"`
	Labels      []struct{ Name string }
	Assignee    *struct{ Login string }
	Milestone   *struct{ Title string }
	StateReason string `json:"state_reason"`
}

func (github) Read(repo string, opts Options) (Plan, error) {
	plan := Plan{Source: "github"}
	token := opts["token"]
	api := strings.TrimRight(orStr(opts["api"], "https://api.github.com"), "/")
	for page := 1; page < 200; page++ {
		var issues []githubIssue
		if _, err := getJSON(fmt.Sprintf("%s/repos/%s/issues?state=all&per_page=100&direction=asc&page=%d", api, repo, page), token, &issues); err != nil {
			return plan, err
		}
		for _, is := range issues {
			if is.PullRequest != nil {
				continue
			}
			t := is.task(repo)
			if is.Comments > 0 {
				var err error
				if t.Comments, err = githubComments(api, repo, token, is.Number); err != nil {
					return plan, err
				}
			}
			plan.Tasks = append(plan.Tasks, t)
		}
		if len(issues) < 100 {
			break
		}
	}
	return plan, nil
}

func (is githubIssue) task(repo string) Task {
	t := Task{Ext: repo + "#" + strconv.Itoa(is.Number), Title: is.Title, Description: is.Body, URL: is.HTMLURL, Category: "unstarted"}
	if is.State == "closed" {
		t.Category = "done"
		if is.StateReason == "not_planned" {
			t.Category = "canceled"
		}
	}
	for _, l := range is.Labels {
		t.Labels = append(t.Labels, l.Name)
	}
	if is.Assignee != nil {
		t.Assignee = is.Assignee.Login
	}
	if is.Milestone != nil {
		t.Epic = is.Milestone.Title
	}
	return t
}

func githubComments(api, repo, token string, issue int) ([]Comment, error) {
	var cs []struct {
		Body      string
		CreatedAt string `json:"created_at"`
		User      struct{ Login string }
	}
	if _, err := getJSON(fmt.Sprintf("%s/repos/%s/issues/%d/comments?per_page=100", api, repo, issue), token, &cs); err != nil {
		return nil, err
	}
	var out []Comment
	for _, c := range cs {
		out = append(out, Comment{Author: c.User.Login, At: c.CreatedAt, Body: c.Body})
	}
	return out, nil
}
