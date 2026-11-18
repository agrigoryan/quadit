// Package github is the GitHub integration's work: GitHub's REST API, and
// one pass over a repository that links pull requests and their checks to
// the tasks they name and turns labeled issues into tasks. It hides the API,
// the mapping from pull requests and issues to tasks, and what is
// remembered between passes (State) behind Syncer.Pass; when a pass runs,
// and the webhook GitHub calls, are the server's. Sign-in with GitHub uses
// Client too.
//
// How the package is laid out:
//
//	github.go  what an integration is set to do and remembers, and one pass
//	pulls.go   pull requests and their checks, onto the tasks they name
//	issues.go  labeled issues, made into tasks
//	client.go  asking GitHub's REST API
package github

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// Syncer runs passes over GitHub integrations' repositories.
type Syncer struct {
	Store  store.Store
	Engine *engine.Engine // every task and link is written as a change
	Sealer *auth.Sealer   // opens the integration's token
	// HTTP makes the requests to the API, at the address an admin gave: one
	// that keeps to the addresses the server may reach for its users.
	HTTP    *http.Client
	BaseURL string // where people reach Quadit: links posted on GitHub
	Version string // this Quadit's version, said to GitHub
}

// client is the client of a GitHub integration: it carries the token an
// admin gave the integration.
func (sy *Syncer) client(api, token string) *Client {
	g := NewClient(sy.HTTP, api, sy.Version)
	if token != "" {
		g.header["Authorization"] = "Bearer " + token
	}
	return g
}

// Config is what an admin sets on a GitHub integration.
type Config struct {
	Repo   string `json:"repo"`    // owner/name
	APIURL string `json:"api_url"` // for GitHub Enterprise; default api.github.com
	// OnOpen and OnMerge name the status category a task moves to when its
	// pull request opens or merges; empty leaves the task alone.
	OnOpen  string `json:"on_open"`
	OnMerge string `json:"on_merge"`
	// CommentBack posts a link to the task on the pull request, once.
	CommentBack bool `json:"comment_back"`
	// IssuesLabel turns the repository's issues carrying this label into
	// tasks and keeps them up to date: title, text, and closed or open.
	// "*" takes every issue. Empty leaves issues alone.
	IssuesLabel string `json:"issues_label"`
	// IssuesProject is the key of the project the tasks are made in; the
	// integration's own project when empty.
	IssuesProject string `json:"issues_project"`
}

// State is what an integration remembers between passes.
type State struct {
	Since         string            `json:"since"`          // newest pull request update seen
	HookSecret    string            `json:"hook_secret"`    // signs webhook calls
	Heads         map[string]string `json:"heads"`          // pull request number -> head commit whose checks were read
	Commented     map[string]bool   `json:"commented"`      // pull request number + task key
	PendingChecks map[string]bool   `json:"pending_checks"` // pull requests whose checks have not finished
	IssuesSince   string            `json:"issues_since"`   // newest issue update seen
	IssueTasks    map[string]string `json:"issue_tasks"`    // issue number -> the task made from it
}

// pass is one pass over one integration's repository: what the
// integration is set to do, what it remembers between passes, and the
// client it asks GitHub with.
type pass struct {
	sy    *Syncer
	db    store.DB
	in    core.Integration
	cfg   Config
	state *State
	gh    *Client
	// token is the integration's own; without one nothing is written on GitHub.
	token string
}

// ghRepoRE is the shape of a repository's name: owner/name.
var ghRepoRE = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// Pass looks at the repository once: its pull requests
// (pulls.go), then its issues (issues.go). It returns how
// many of them it handled.
func (sy *Syncer) Pass(ctx context.Context, db store.DB, in core.Integration, cfg Config, state *State) (int, error) {
	if !ghRepoRE.MatchString(cfg.Repo) {
		return 0, fmt.Errorf("the repository must be given as owner/name, got %q", cfg.Repo)
	}
	token, err := sy.Sealer.Open(in.Secret)
	if err != nil {
		return 0, err
	}
	api := strings.TrimRight(cmp.Or(cfg.APIURL, "https://api.github.com"), "/")
	g := &pass{sy: sy, db: db, in: in, cfg: cfg, state: state, gh: sy.client(api, token), token: token}
	handled, err := g.syncPulls(ctx)
	if err != nil {
		return handled, err
	}
	n, err := g.syncIssues(ctx)
	return handled + n, err
}
