package server_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestGitHub(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Jump feels floaty"})

		// A stand-in for GitHub with one pull request whose branch names the task.
		var mu sync.Mutex
		pull := M{"number": 7, "title": "Fix the jump", "body": "", "state": "open", "draft": false, "html_url": "https://github.example/acme/game/pull/7",
			"updated_at": "2026-11-14T10:00:00Z", "merged_at": nil, "head": M{"ref": "sva-1-jump", "sha": "abc123"}, "user": M{"login": "coder"}}
		checks := []M{{"status": "in_progress", "conclusion": nil}}
		var comments []string
		issues := []M{}
		gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			if r.Header.Get("Authorization") != "Bearer ghp_secret" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			switch {
			case strings.HasSuffix(r.URL.Path, "/issues") && r.Method == http.MethodGet:
				if r.URL.Query().Get("labels") != "quadit" {
					w.WriteHeader(http.StatusUnprocessableEntity)
					return
				}
				json.NewEncoder(w).Encode(issues)
			case strings.HasSuffix(r.URL.Path, "/pulls"):
				json.NewEncoder(w).Encode([]M{pull})
			case strings.HasSuffix(r.URL.Path, "/check-runs"):
				json.NewEncoder(w).Encode(M{"check_runs": checks})
			case strings.HasSuffix(r.URL.Path, "/comments") && r.Method == http.MethodPost:
				var b struct{ Body string }
				json.NewDecoder(r.Body).Decode(&b)
				comments = append(comments, b.Body)
				w.WriteHeader(http.StatusCreated)
				w.Write([]byte("{}"))
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		t.Cleanup(gh.Close)

		in := s.change(s.owner, "", "integration.create", M{"kind": "github", "secret": "ghp_secret",
			"config": M{"repo": "acme/game", "api_url": gh.URL, "on_open": "started", "on_merge": "done", "comment_back": true}})["ref"].(string)
		// The token is never sent back.
		if out := s.call(s.owner, "", "GET", w+"/list/integrations", nil, 200, nil); strings.Contains(out, "ghp_secret") || !strings.Contains(out, `"has_secret":true`) {
			t.Fatalf("integration list: %s", out)
		}
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)

		type link struct{ Kind, Ref, State, Checks, URL string }
		read := func() (string, link) {
			var d struct {
				Task  struct{ Status string }
				Links []link
			}
			s.call(s.owner, "", "GET", w+"/tasks/SVA-1", nil, 200, &d)
			if len(d.Links) != 1 {
				t.Fatalf("links = %+v", d.Links)
			}
			return d.Task.Status, d.Links[0]
		}
		status, l := read()
		if l.Kind != "pr" || l.Ref != "7" || l.State != "open" || l.Checks != "pending" || status != "In Progress" {
			t.Fatalf("after opening: status %q link %+v", status, l)
		}
		mu.Lock()
		if len(comments) != 1 || !strings.Contains(comments[0], "SVA-1") {
			t.Fatalf("comment on the pull request: %v", comments)
		}
		// The checks finish without the pull request itself changing.
		checks = []M{{"status": "completed", "conclusion": "success"}}
		mu.Unlock()
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)
		if _, l = read(); l.Checks != "passing" {
			t.Fatalf("checks did not update: %+v", l)
		}

		// The merge arrives by webhook, signed.
		mu.Lock()
		pull["state"], pull["merged_at"], pull["updated_at"] = "closed", "2026-11-14T11:00:00Z", "2026-11-14T11:00:00Z"
		mu.Unlock()
		var hook struct{ URL, Secret string }
		s.call(s.owner, "", "GET", w+"/integrations/"+in+"/webhook", nil, 200, &hook)
		body := `{"action":"closed"}`
		post := func(sig string) int {
			req, _ := http.NewRequest(http.MethodPost, hook.URL, strings.NewReader(body))
			req.Header.Set("X-Hub-Signature-256", sig)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}
		if code := post("sha256=bogus"); code != 401 {
			t.Fatalf("an unsigned webhook got %d", code)
		}
		mac := hmac.New(sha256.New, []byte(hook.Secret))
		mac.Write([]byte(body))
		if code := post("sha256=" + hex.EncodeToString(mac.Sum(nil))); code != 202 {
			t.Fatalf("a signed webhook got %d", code)
		}
		eventually(t, "the merge to close the task", func() bool {
			status, l := read()
			return status == "Done" && l.State == "merged"
		})
		mu.Lock()
		said := len(comments)
		mu.Unlock()
		if said != 1 {
			t.Fatalf("the pull request was commented on %d times", said)
		}

		// Issues with the label become tasks, and stay in step with the issue.
		s.change(s.owner, "", "integration.update", M{"id": in, "config": M{"repo": "acme/game", "api_url": gh.URL, "on_open": "started", "on_merge": "done",
			"issues_label": "quadit", "issues_project": "SVA"}})
		mu.Lock()
		issues = []M{
			{"number": 12, "title": "Crash on the title screen", "body": "Steps: start, wait.", "state": "open", "html_url": "https://github.example/acme/game/issues/12", "updated_at": "2026-11-14T12:00:00Z"},
			{"number": 13, "title": "A pull request, not an issue", "state": "open", "html_url": "x", "updated_at": "2026-11-14T12:00:01Z", "pull_request": M{"url": "x"}},
		}
		mu.Unlock()
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil) // twice: still one task
		list := s.call(s.owner, "", "GET", w+"/tasks?q=Crash&format=text", nil, 200, nil)
		if strings.Count(list, "Crash on the title screen") != 1 || strings.Contains(s.call(s.owner, "", "GET", w+"/tasks?format=text", nil, 200, nil), "A pull request") {
			t.Fatalf("tasks from issues: %s", list)
		}
		key := strings.Fields(list)[0]
		if out := s.call(s.owner, "", "GET", w+"/tasks/"+key+"?format=text", nil, 200, nil); !strings.Contains(out, "Steps: start, wait.") || !strings.Contains(out, "acme/game#12") {
			t.Fatalf("the task made from an issue: %s", out)
		}
		// The issue is renamed and closed there: the task follows.
		mu.Lock()
		issues[0]["title"], issues[0]["state"], issues[0]["updated_at"] = "Crash on the title screen (fixed)", "closed", "2026-11-14T13:00:00Z"
		mu.Unlock()
		s.call(s.owner, "", "POST", w+"/integrations/"+in+"/sync", nil, 200, nil)
		if out := s.call(s.owner, "", "GET", w+"/tasks/"+key+"?format=text", nil, 200, nil); !strings.Contains(out, "(fixed)") || !strings.Contains(out, "status: Done") {
			t.Fatalf("the task after the issue closed: %s", out)
		}
	})
}
