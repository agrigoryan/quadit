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
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/github"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// The GitHub integration links pull requests and their checks to tasks. A
// pull request belongs to a task when the task's key (SVA-12) is in its
// title, its description or its branch name. The server asks GitHub for
// news once a minute, so it works on a machine GitHub cannot reach; where
// GitHub can reach it, a webhook makes the same thing immediate.
//
// This file is when an integration syncs (the timer, the button, the
// webhook), one integration at a time, and what each sync is remembered
// as. One pass over the repository is package github.

// githubRoutes are the routes of GitHub integrations: GitHub's calls in, and syncing by hand.
func (s *Server) githubRoutes() []route {
	return []route{
		{"POST /hooks/github/{id}", s.handleReceiveGitHubEvent, "Where GitHub sends events for an integration, signed with its secret.", "", "integrations"},
		{"POST /api/v1/w/{ws}/integrations/{id}/sync", s.workspaceMember(s.handleSyncIntegration), "Sync one integration now. Admins.", "", "admin"},
		{"GET /api/v1/w/{ws}/integrations/{id}/webhook", s.workspaceMember(s.handleShowIntegrationWebhook), "The address and secret to give the outside service so it can call in. Admins.", "", "admin"},
	}
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
func githubStateOf(raw json.RawMessage) github.State {
	var state github.State
	if len(raw) > 0 && json.Unmarshal(raw, &state) != nil {
		return github.State{}
	}
	return state
}

// integrationOf reads the integration a request names.
func integrationOf(x *c) (core.Integration, error) {
	var in core.Integration
	err := x.db.Get(x.ctx(), &in, store.Eq("id", x.r.PathValue("id")), store.Live)
	return in, err
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
		raw := plainjson.Marshal(state)
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
	there, err := store.Find(ctx, s.st, &in, store.Eq("id", r.PathValue("id")), store.Eq("kind", "github"), store.Live)
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
	var cfg github.Config
	var err error
	if len(in.Config) > 0 {
		err = json.Unmarshal(in.Config, &cfg)
	}
	if err != nil {
		err = fmt.Errorf("the integration's settings do not read: %w", err)
	} else {
		n, err = s.github.Pass(ctx, db, in, cfg, &state)
	}
	set := map[string]any{"last_sync_at": time.Now().UnixMilli(), "last_error": ""}
	if err != nil {
		set["last_error"] = oneLine(err.Error(), lastErrorSize)
	}
	raw := plainjson.Marshal(state)
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
