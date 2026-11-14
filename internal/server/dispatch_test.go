package server_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/testdb"
)

// receiver collects webhook deliveries.
type receiver struct {
	mu   sync.Mutex
	got  []map[string]any
	sigs []bool
	fail int // answer 500 this many times first
	srv  *httptest.Server
}

func newReceiver(t *testing.T, secret string) *receiver {
	r := &receiver{}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.fail > 0 {
			r.fail--
			w.WriteHeader(500)
			return
		}
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		r.sigs = append(r.sigs, req.Header.Get("X-Quadit-Signature") == "sha256="+hex.EncodeToString(mac.Sum(nil)))
		var m map[string]any
		json.Unmarshal(body, &m)
		r.got = append(r.got, m)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *receiver) types() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, m := range r.got {
		out = append(out, m["type"].(string))
	}
	return strings.Join(out, " ")
}

// eventually waits for a condition the background workers bring about.
func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(12 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func TestWakeUps(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	artist := s.change(s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})["ref"].(string)
	s.change(s.owner, "", "agent.create", M{"name": "Coordinator", "handle": "coordinator"})

	all := newReceiver(t, "s3cret")
	mine := newReceiver(t, "")
	woken := newReceiver(t, "")
	all.fail = 1 // the first try fails; the delivery is retried
	s.change(s.owner, "", "webhook.create", M{"name": "everything about tasks", "url": all.srv.URL, "secret": "s3cret", "event_types": []string{"task.*", "decision.*"}})
	s.change(s.owner, "", "webhook.create", M{"name": "artist inbox", "url": mine.srv.URL, "for": "@artist"})
	hook := s.change(s.owner, "", "webhook.create", M{"name": "wake coordinator", "url": woken.srv.URL, "event_types": []string{"never.matches"}})["ref"].(string)
	// "When the owner picks, wake the coordinator": a webhook and an inbox item.
	s.change(s.owner, "", "rule.create", M{"name": "pick wakes coordinator", "match": M{"event_types": []string{"decision.picked"}, "actor_kind": "person"},
		"action": M{"kind": "webhook", "webhook_id": hook}})
	s.change(s.owner, "", "rule.create", M{"name": "The owner picked: plan the next step", "match": M{"event_types": []string{"decision.picked"}},
		"action": M{"kind": "notify", "user_id": "@coordinator"}})

	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion", "assignee": "@artist"})
	d := s.change(nil, tok.Token, "decision.open", M{"task": "SVA-1", "question": "Which?", "options": []M{{"label": "A"}, {"label": "B"}}})
	s.change(s.owner, "", "decision.pick", M{"id": d["ref"], "option": 2})

	eventually(t, "the task webhook to get the pick", func() bool { return strings.Contains(all.types(), "decision.picked") })
	if got := all.types(); !strings.HasPrefix(got, "task.created") || strings.Contains(got, "notification") || strings.Contains(got, "project.created") {
		t.Fatalf("task webhook got: %s", got)
	}
	for _, ok := range all.sigs {
		if !ok {
			t.Fatal("a delivery was not signed with the webhook's secret")
		}
	}
	// The agent's own webhook gets its inbox and only that.
	eventually(t, "the artist's webhook to hear of the pick", func() bool { return strings.Count(mine.types(), "notification.created") >= 2 })
	if strings.Contains(mine.types(), "task.") {
		t.Fatalf("inbox webhook got public events: %s", mine.types())
	}
	mine.mu.Lock()
	text := mine.got[len(mine.got)-1]["text"].(string)
	mine.mu.Unlock()
	if !strings.Contains(text, "picked") || !strings.Contains(text, "SVA-1") {
		t.Fatalf("delivery text = %q", text)
	}
	// The rule's webhook fired although its own filter matches nothing.
	eventually(t, "the rule to wake the coordinator", func() bool { return woken.types() == "decision.picked" })
	// And the rule's inbox item reached the coordinator, once.
	eventually(t, "the coordinator's inbox item", func() bool {
		var ctok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@coordinator"}, 201, &ctok)
		out := s.call(nil, ctok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil)
		return strings.Count(out, "plan the next step") == 1
	})
	// The delivery log shows the failed first try, and health sees nothing dead.
	var log struct {
		Deliveries []struct {
			State    string
			Attempts int
		}
	}
	s.call(s.owner, "", "GET", w+"/list/deliveries", nil, 200, &log)
	retried := false
	for _, dl := range log.Deliveries {
		if dl.State != "ok" {
			t.Fatalf("delivery left in state %s", dl.State)
		}
		retried = retried || dl.Attempts > 1
	}
	if !retried {
		t.Fatal("no delivery shows a retry")
	}
	_ = artist
}
