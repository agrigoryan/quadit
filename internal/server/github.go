package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// The GitHub integration links pull requests and their checks to tasks. A
// pull request belongs to a task when the task's key (SVA-12) is in its
// title, its description or its branch name. The server asks GitHub for
// news once a minute, so it works on a machine GitHub cannot reach; where
// GitHub can reach it, a webhook makes the same thing immediate.
//
// How it is laid out:
//
//	github.go         what an integration is set to do and remembers, when
//	                  it syncs (the timer, the button, the webhook), one pass
//	github_pulls.go   pull requests and their checks, onto the tasks they name
//	github_issues.go  labeled issues, made into tasks
//	github_client.go  asking GitHub's REST API; sign-in with GitHub uses it too

func init() {
	runners = append(runners, (*Server).runGitHub)
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /hooks/github/{id}", s.handleReceiveGitHubEvent)
		m.HandleFunc("POST /api/v1/w/{ws}/integrations/{id}/sync", s.workspaceMember(s.handleSyncIntegration))
		m.HandleFunc("GET /api/v1/w/{ws}/integrations/{id}/webhook", s.workspaceMember(s.handleShowIntegrationWebhook))
	})
}

// githubConfig is what an admin sets on a GitHub integration.
type githubConfig struct {
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

// githubState is what the server remembers between polls.
type githubState struct {
	Since         string            `json:"since"`          // newest pull request update seen
	HookSecret    string            `json:"hook_secret"`    // signs webhook calls
	Heads         map[string]string `json:"heads"`          // pull request number -> head commit whose checks were read
	Commented     map[string]bool   `json:"commented"`      // pull request number + task key
	PendingChecks map[string]bool   `json:"pending_checks"` // pull requests whose checks have not finished
	IssuesSince   string            `json:"issues_since"`   // newest issue update seen
	IssueTasks    map[string]string `json:"issue_tasks"`    // issue number -> the task made from it
}

// ghLocks holds a mutex for each integration, so one integration is
// synced by one pass at a time.
var ghLocks sync.Map

// How often integrations are looked at, and how often each one syncs.
const (
	githubTick  = 20 * time.Second
	githubEvery = time.Minute
	// githubHookBodyLimit is the largest webhook call from GitHub read.
	githubHookBodyLimit = 5 << 20
)

// runGitHub syncs each active GitHub integration once a minute until ctx ends.
func (s *Server) runGitHub(ctx context.Context) {
	tick := time.NewTicker(githubTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		var list []core.Integration
		if err := s.st.List(ctx, &list, store.Where(store.Eq("kind", "github"), store.Eq("active", true), store.Live)); err != nil {
			continue
		}
		for _, in := range list {
			if time.Now().UnixMilli()-in.LastSyncAt < githubEvery.Milliseconds() {
				continue
			}
			if _, err := s.syncGitHub(ctx, in); err != nil {
				s.log.Warn("github sync", "integration", in.ID, "err", err)
			}
		}
	}
}

// githubStateOf reads what an integration remembers. State that does not
// read is taken as nothing remembered: the next pass starts afresh.
func githubStateOf(raw json.RawMessage) githubState {
	var state githubState
	if len(raw) > 0 && json.Unmarshal(raw, &state) != nil {
		return githubState{}
	}
	return state
}

// integrationOf reads the integration a request names.
func integrationOf(x *c) (core.Integration, error) {
	var in core.Integration
	there, err := rowFound(x.db.Get(x.ctx(), &in, store.Eq("id", x.r.PathValue("id")), store.Live))
	if err != nil {
		return in, err
	}
	if !there {
		return in, errNotFound("integration")
	}
	return in, nil
}

// handleSyncIntegration syncs an integration now and says how many pull
// requests and issues it handled.
func (s *Server) handleSyncIntegration(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	in, err := integrationOf(x)
	if err != nil {
		return err
	}
	n, err := s.syncGitHub(x.ctx(), in)
	if err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: err.Error()}
	}
	return x.ok(map[string]any{"pull_requests": n})
}

// handleShowIntegrationWebhook returns the address and secret to enter in the
// repository's webhook settings on GitHub.
func (s *Server) handleShowIntegrationWebhook(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	in, err := integrationOf(x)
	if err != nil {
		return err
	}
	state := githubStateOf(in.State)
	if state.HookSecret == "" {
		state.HookSecret = auth.Random(24)
		raw, _ := json.Marshal(state) // plain fields: always encodes
		if _, err := x.db.Update(x.ctx(), "integrations", map[string]any{"state": json.RawMessage(raw)}, store.Eq("id", in.ID)); err != nil {
			return err
		}
	}
	return x.ok(map[string]any{"url": s.cfg.BaseURL + "/hooks/github/" + in.ID, "secret": state.HookSecret, "content_type": "application/json",
		"events": []string{"pull_request", "check_suite", "check_run", "status"}})
}

// handleReceiveGitHubEvent takes a signed call from GitHub and syncs at once.
func (s *Server) handleReceiveGitHubEvent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in core.Integration
	there, err := rowFound(s.st.Get(ctx, &in, store.Eq("id", r.PathValue("id")), store.Eq("kind", "github"), store.Live))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !there {
		http.Error(w, "unknown integration", http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, githubHookBodyLimit))
	if err != nil {
		http.Error(w, "the body could not be read: "+err.Error(), http.StatusBadRequest)
		return
	}
	state := githubStateOf(in.State)
	mac := hmac.New(sha256.New, []byte(state.HookSecret))
	mac.Write(body)
	if state.HookSecret == "" || !hmac.Equal([]byte(r.Header.Get("X-Hub-Signature-256")), []byte("sha256="+hex.EncodeToString(mac.Sum(nil)))) {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	if !in.Active {
		w.WriteHeader(http.StatusAccepted) // paused: taken, not acted on
		return
	}
	go func() {
		if _, err := s.syncGitHub(context.WithoutCancel(ctx), in); err != nil {
			s.log.Warn("github sync", "integration", in.ID, "err", err)
		}
	}()
	w.WriteHeader(http.StatusAccepted)
}

// syncGitHub reads what changed on GitHub and updates the tasks' links.
func (s *Server) syncGitHub(ctx context.Context, in core.Integration) (int, error) {
	mu, _ := ghLocks.LoadOrStore(in.ID, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	db := s.st.In(in.WorkspaceID)
	if err := db.Get(ctx, &in, store.Eq("id", in.ID)); err != nil { // the freshest state
		return 0, err
	}
	state := githubStateOf(in.State)
	if state.Heads == nil {
		state.Heads, state.Commented, state.PendingChecks = map[string]string{}, map[string]bool{}, map[string]bool{}
	}
	if state.PendingChecks == nil {
		state.PendingChecks = map[string]bool{}
	}
	n := 0
	var cfg githubConfig
	var err error
	if len(in.Config) > 0 {
		err = json.Unmarshal(in.Config, &cfg)
	}
	if err != nil {
		err = fmt.Errorf("the integration's settings do not read: %w", err)
	} else {
		n, err = s.githubPass(ctx, db, in, cfg, &state)
	}
	set := map[string]any{"last_sync_at": time.Now().UnixMilli(), "last_error": ""}
	if err != nil {
		set["last_error"] = oneLine(err.Error(), lastErrorSize)
	}
	raw, _ := json.Marshal(state) // plain fields: always encodes
	set["state"] = json.RawMessage(raw)
	// Not remembered, what was done is done again on the next pass (a
	// second comment on a pull request), so the write is retried, and a
	// failure is told.
	recorded := s.recordOutcome(context.WithoutCancel(ctx), "github sync", func(ctx context.Context) error {
		_, err := db.Update(ctx, "integrations", set, store.Eq("id", in.ID))
		return err
	}, "integration", in.ID)
	if !recorded && err == nil {
		err = errors.New("what was synced could not be remembered; it is done again on the next pass")
	}
	return n, err
}

// githubSync is one pass over one integration's repository: what the
// integration is set to do, what it remembers between passes, and the
// client it asks GitHub with.
type githubSync struct {
	s     *Server
	db    store.DB
	in    core.Integration
	cfg   githubConfig
	state *githubState
	gh    *githubClient
	// token is the integration's own; without one nothing is written on GitHub.
	token string
}

// ghRepoRE is the shape of a repository's name: owner/name.
var ghRepoRE = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

// githubPass looks at the repository once: its pull requests
// (github_pulls.go), then its issues (github_issues.go). It returns how
// many of them it handled.
func (s *Server) githubPass(ctx context.Context, db store.DB, in core.Integration, cfg githubConfig, state *githubState) (int, error) {
	if !ghRepoRE.MatchString(cfg.Repo) {
		return 0, fmt.Errorf("the repository must be given as owner/name, got %q", cfg.Repo)
	}
	token, err := s.sealer.Open(in.Secret)
	if err != nil {
		return 0, err
	}
	api := strings.TrimRight(firstNonEmpty(cfg.APIURL, "https://api.github.com"), "/")
	g := &githubSync{s: s, db: db, in: in, cfg: cfg, state: state, gh: s.githubAPI(api, token), token: token}
	handled, err := g.syncPulls(ctx)
	if err != nil {
		return handled, err
	}
	n, err := g.syncIssues(ctx)
	return handled + n, err
}
