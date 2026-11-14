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

	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestGitHub(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Jump feels floaty"})

	// A stand-in for GitHub with one pull request whose branch names the task.
	var mu sync.Mutex
	pull := M{"number": 7, "title": "Fix the jump", "body": "", "state": "open", "draft": false, "html_url": "https://github.example/acme/game/pull/7",
		"updated_at": "2026-11-14T10:00:00Z", "merged_at": nil, "head": M{"ref": "sva-1-jump", "sha": "abc123"}, "user": M{"login": "coder"}}
	checks := []M{{"status": "in_progress", "conclusion": nil}}
	var comments []string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer ghp_secret" {
			w.WriteHeader(401)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/pulls"):
			json.NewEncoder(w).Encode([]M{pull})
		case strings.HasSuffix(r.URL.Path, "/check-runs"):
			json.NewEncoder(w).Encode(M{"check_runs": checks})
		case strings.HasSuffix(r.URL.Path, "/comments") && r.Method == "POST":
			var b struct{ Body string }
			json.NewDecoder(r.Body).Decode(&b)
			comments = append(comments, b.Body)
			w.WriteHeader(201)
			w.Write([]byte("{}"))
		default:
			w.WriteHeader(404)
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
		req, _ := http.NewRequest("POST", hook.URL, strings.NewReader(body))
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
	defer mu.Unlock()
	if len(comments) != 1 {
		t.Fatalf("the pull request was commented on %d times", len(comments))
	}
}
