package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

func init() {
	runners = append(runners, (*Server).runGitHub)
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /hooks/github/{id}", s.hGitHubHook)
		m.HandleFunc("POST /api/v1/w/{ws}/integrations/{id}/sync", s.in(s.hIntegrationSync))
		m.HandleFunc("GET /api/v1/w/{ws}/integrations/{id}/webhook", s.in(s.hIntegrationWebhook))
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
}

// githubState is what the server remembers between polls.
type githubState struct {
	Since         string            `json:"since"`          // newest pull request update seen
	HookSecret    string            `json:"hook_secret"`    // signs webhook calls
	Heads         map[string]string `json:"heads"`          // pull request number -> head commit whose checks were read
	Commented     map[string]bool   `json:"commented"`      // pull request number + task key
	PendingChecks map[string]bool   `json:"pending_checks"` // pull requests whose checks have not finished
}

var ghLocks sync.Map

func (s *Server) runGitHub(ctx context.Context) {
	tick := time.NewTicker(20 * time.Second)
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
			if time.Now().UnixMilli()-in.LastSyncAt < 60_000 {
				continue
			}
			if _, err := s.syncGitHub(ctx, in); err != nil {
				s.log.Warn("github sync", "integration", in.ID, "err", err)
			}
		}
	}
}

func (s *Server) hIntegrationSync(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	var in core.Integration
	if err := x.db.Get(x.ctx(), &in, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("integration")
	}
	n, err := s.syncGitHub(x.ctx(), in)
	if err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: err.Error()}
	}
	return x.ok(map[string]any{"pull_requests": n})
}

// hIntegrationWebhook returns the address and secret to enter in the
// repository's webhook settings on GitHub.
func (s *Server) hIntegrationWebhook(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	var in core.Integration
	if err := x.db.Get(x.ctx(), &in, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("integration")
	}
	var st githubState
	json.Unmarshal(in.State, &st)
	if st.HookSecret == "" {
		st.HookSecret = auth.Random(24)
		raw, _ := json.Marshal(st)
		if _, err := x.db.Update(x.ctx(), "integrations", map[string]any{"state": json.RawMessage(raw)}, store.Eq("id", in.ID)); err != nil {
			return err
		}
	}
	return x.ok(map[string]any{"url": s.cfg.BaseURL + "/hooks/github/" + in.ID, "secret": st.HookSecret, "content_type": "application/json",
		"events": []string{"pull_request", "check_suite", "check_run", "status"}})
}

// hGitHubHook takes a signed call from GitHub and syncs at once.
func (s *Server) hGitHubHook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in core.Integration
	if err := s.st.Get(ctx, &in, store.Eq("id", r.PathValue("id")), store.Eq("kind", "github"), store.Live); err != nil {
		http.Error(w, "unknown integration", http.StatusNotFound)
		return
	}
	body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
	var st githubState
	json.Unmarshal(in.State, &st)
	mac := hmac.New(sha256.New, []byte(st.HookSecret))
	mac.Write(body)
	if st.HookSecret == "" || !hmac.Equal([]byte(r.Header.Get("X-Hub-Signature-256")), []byte("sha256="+hex.EncodeToString(mac.Sum(nil)))) {
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

type ghPull struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	State     string `json:"state"`
	Draft     bool   `json:"draft"`
	HTMLURL   string `json:"html_url"`
	UpdatedAt string `json:"updated_at"`
	MergedAt  string `json:"merged_at"`
	Head      struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"head"`
	User struct {
		Login string `json:"login"`
	} `json:"user"`
}

var ghKeyRE = regexp.MustCompile(`(?i)\b([A-Z][A-Z0-9]{1,9})-(\d+)\b`)

// syncGitHub reads what changed on GitHub and updates the tasks' links.
func (s *Server) syncGitHub(ctx context.Context, in core.Integration) (int, error) {
	mu, _ := ghLocks.LoadOrStore(in.ID, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	db := s.st.In(in.WorkspaceID)
	if err := db.Get(ctx, &in, store.Eq("id", in.ID)); err != nil { // the freshest state
		return 0, err
	}
	var cfg githubConfig
	var st githubState
	json.Unmarshal(in.Config, &cfg)
	json.Unmarshal(in.State, &st)
	if st.Heads == nil {
		st.Heads, st.Commented, st.PendingChecks = map[string]string{}, map[string]bool{}, map[string]bool{}
	}
	if st.PendingChecks == nil {
		st.PendingChecks = map[string]bool{}
	}
	n, err := s.githubPass(ctx, db, in, cfg, &st)
	set := map[string]any{"last_sync_at": time.Now().UnixMilli(), "last_error": ""}
	if err != nil {
		set["last_error"] = oneLine(err.Error(), 400)
	}
	raw, _ := json.Marshal(st)
	set["state"] = json.RawMessage(raw)
	db.Update(context.WithoutCancel(ctx), "integrations", set, store.Eq("id", in.ID))
	return n, err
}

func (s *Server) githubPass(ctx context.Context, db store.DB, in core.Integration, cfg githubConfig, st *githubState) (int, error) {
	if !regexp.MustCompile(`^[\w.-]+/[\w.-]+$`).MatchString(cfg.Repo) {
		return 0, fmt.Errorf("the repository must be given as owner/name, got %q", cfg.Repo)
	}
	token, err := s.sealer.Open(in.Secret)
	if err != nil {
		return 0, err
	}
	api := strings.TrimRight(orText(cfg.APIURL, "https://api.github.com"), "/")
	call := func(method, path string, body any, dst any) error {
		var rd io.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			rd = strings.NewReader(string(raw))
		}
		rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(rctx, method, api+path, rd)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("User-Agent", "Quadit/"+s.cfg.Version)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if resp.StatusCode >= 300 {
			return fmt.Errorf("GitHub answered %s to %s %s: %s", resp.Status, method, path, oneLine(string(raw), 160))
		}
		if dst != nil {
			return json.Unmarshal(raw, dst)
		}
		return nil
	}
	var pulls []ghPull
	if err := call("GET", "/repos/"+cfg.Repo+"/pulls?state=all&sort=updated&direction=desc&per_page=50", nil, &pulls); err != nil {
		return 0, err
	}
	// Which keys are real: the workspace's project keys.
	var projects []core.Project
	if err := db.List(ctx, &projects, store.Where(store.Live)); err != nil {
		return 0, err
	}
	isKey := map[string]bool{}
	for _, p := range projects {
		if in.ProjectID == "" || in.ProjectID == p.ID {
			isKey[p.Key] = true
		}
	}
	newest := st.Since
	handled := 0
	for _, pr := range pulls {
		num := fmt.Sprint(pr.Number)
		changed := pr.UpdatedAt > st.Since
		if !changed && !st.PendingChecks[num] {
			continue
		}
		if pr.UpdatedAt > newest {
			newest = pr.UpdatedAt
		}
		keys := map[string]bool{}
		for _, m := range ghKeyRE.FindAllStringSubmatch(pr.Title+"\n"+pr.Head.Ref+"\n"+pr.Body, -1) {
			if isKey[strings.ToUpper(m[1])] {
				keys[strings.ToUpper(m[1])+"-"+m[2]] = true
			}
		}
		if len(keys) == 0 {
			continue
		}
		state := pr.State
		switch {
		case pr.MergedAt != "":
			state = "merged"
		case pr.Draft && pr.State == "open":
			state = "draft"
		}
		checks := ""
		if state == "open" || state == "draft" {
			var runs struct {
				CheckRuns []struct {
					Status     string `json:"status"`
					Conclusion string `json:"conclusion"`
				} `json:"check_runs"`
			}
			if err := call("GET", "/repos/"+cfg.Repo+"/commits/"+pr.Head.SHA+"/check-runs?per_page=100", nil, &runs); err == nil && len(runs.CheckRuns) > 0 {
				checks = "passing"
				for _, r := range runs.CheckRuns {
					switch {
					case r.Status != "completed":
						if checks != "failing" {
							checks = "pending"
						}
					case r.Conclusion == "failure" || r.Conclusion == "timed_out" || r.Conclusion == "cancelled" || r.Conclusion == "action_required":
						checks = "failing"
					}
				}
			}
			st.PendingChecks[num] = checks == "pending"
		} else {
			delete(st.PendingChecks, num)
		}
		st.Heads[num] = pr.Head.SHA
		for key := range keys {
			var t core.Task
			if err := db.Get(ctx, &t, store.Eq("key", key), store.Live); err != nil {
				continue
			}
			data, _ := json.Marshal(map[string]any{"branch": pr.Head.Ref, "author": pr.User.Login, "sha": pr.Head.SHA})
			err := s.eng.System(ctx, in.WorkspaceID, in.CreatedBy, func(sys *engine.Sys) error {
				if err := sys.Do("link.set", map[string]any{"task": t.ID, "kind": "pr", "repo": cfg.Repo, "ref": num, "url": pr.HTMLURL, "title": pr.Title,
					"state": state, "checks": checks, "data": json.RawMessage(data)}); err != nil {
					return err
				}
				// Move the task along with its pull request, when asked to.
				to := ""
				switch {
				case state == "merged" && cfg.OnMerge != "":
					to = cfg.OnMerge
				case (state == "open" || state == "draft") && cfg.OnOpen != "":
					var cur core.Status
					if sys.Tx().Get(ctx, &cur, store.Eq("id", t.StatusID)) == nil && (cur.Category == core.CatBacklog || cur.Category == core.CatUnstarted) {
						to = cfg.OnOpen
					}
				}
				if to == "" {
					return nil
				}
				return sys.Do("task.update", map[string]any{"id": t.ID, "status": to})
			})
			if err != nil {
				return handled, fmt.Errorf("%s: %w", key, err)
			}
			if cfg.CommentBack && !st.Commented[num+" "+key] && token != "" {
				var ws core.Workspace
				s.st.Get(ctx, &ws, store.Eq("id", in.WorkspaceID))
				body := fmt.Sprintf("Linked to **%s** %s — %s/%s/task/%s", key, t.Title, s.cfg.BaseURL, ws.Slug, key)
				if err := call("POST", fmt.Sprintf("/repos/%s/issues/%d/comments", cfg.Repo, pr.Number), map[string]string{"body": body}, nil); err == nil {
					st.Commented[num+" "+key] = true
				}
			}
		}
		handled++
	}
	st.Since = newest
	return handled, nil
}
