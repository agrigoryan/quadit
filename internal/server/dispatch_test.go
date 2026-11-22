package server_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
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
			w.WriteHeader(http.StatusInternalServerError)
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

// signed is a copy of whether each delivery so far was signed correctly.
func (r *receiver) signed() []bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]bool(nil), r.sigs...)
}

// last is the newest delivery.
func (r *receiver) last() map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.got[len(r.got)-1]
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		artist := s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})["ref"].(string)
		s.change(t, s.owner, "", "agent.create", M{"name": "Coordinator", "handle": "coordinator"})

		all := newReceiver(t, "s3cret")
		mine := newReceiver(t, "")
		woken := newReceiver(t, "")
		all.fail = 1 // the first try fails; the delivery is retried
		s.change(t, s.owner, "", "webhook.create", M{"name": "everything about tasks", "url": all.srv.URL, "secret": "s3cret", "event_types": []string{"task.*", "decision.*"}})
		s.change(t, s.owner, "", "webhook.create", M{"name": "artist inbox", "url": mine.srv.URL, "for": "@artist"})
		hook := s.change(t, s.owner, "", "webhook.create", M{"name": "wake coordinator", "url": woken.srv.URL, "event_types": []string{"never.matches"}})["ref"].(string)
		// "When the owner picks, wake the coordinator": a webhook and an inbox item.
		s.change(t, s.owner, "", "rule.create", M{"name": "pick wakes coordinator", "match": M{"event_types": []string{"decision.picked"}, "actor_kind": "person"},
			"action": M{"kind": "webhook", "webhook_id": hook}})
		s.change(t, s.owner, "", "rule.create", M{"name": "The owner picked: plan the next step", "match": M{"event_types": []string{"decision.picked"}},
			"action": M{"kind": "notify", "user_id": "@coordinator"}})

		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Explosion", "assignee": "@artist"})
		d := s.change(t, nil, tok.Token, "decision.open", M{"task": "SVA-1", "question": "Which?", "options": []M{{"label": "A"}, {"label": "B"}}})
		s.change(t, s.owner, "", "decision.pick", M{"id": d["ref"], "option": 2})

		eventually(t, "the task webhook to get the pick", func() bool { return strings.Contains(all.types(), "decision.picked") })
		if got := all.types(); !strings.HasPrefix(got, "task.created") || strings.Contains(got, "notification") || strings.Contains(got, "project.created") {
			t.Fatalf("task webhook got: %s", got)
		}
		for _, ok := range all.signed() {
			if !ok {
				t.Fatal("a delivery was not signed with the webhook's secret")
			}
		}
		// The agent's own webhook gets its inbox and only that.
		eventually(t, "the artist's webhook to hear of the pick", func() bool { return strings.Count(mine.types(), "notification.created") >= 2 })
		if strings.Contains(mine.types(), "task.") {
			t.Fatalf("inbox webhook got public events: %s", mine.types())
		}
		text := mine.last()["text"].(string)
		if !strings.Contains(text, "picked") || !strings.Contains(text, "SVA-1") {
			t.Fatalf("delivery text = %q", text)
		}
		// The rule's webhook fired although its own filter matches nothing.
		eventually(t, "the rule to wake the coordinator", func() bool { return woken.types() == "decision.picked" })
		// And the rule's inbox item reached the coordinator, once.
		eventually(t, "the coordinator's inbox item", func() bool {
			var ctok struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@coordinator"}, 201, &ctok)
			out := s.call(t, nil, ctok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil)
			return strings.Count(out, "plan the next step") == 1
		})
		// The delivery log shows the failed first try, and health sees nothing dead.
		var log struct {
			Deliveries []struct {
				State    string
				Attempts int
			}
		}
		s.call(t, s.owner, "", "GET", w+"/list/deliveries", nil, 200, &log)
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
	})
}

func TestWatchedView(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "label.create", M{"name": "art", "project": "SVA"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
		// The agent saves a view of unassigned art tasks and watches it.
		view := s.change(t, nil, tok.Token, "view.create", M{"name": "Art nobody has", "query": M{"label": []string{"art"}, "assignee": []string{"none"}, "open": true}})
		s.change(t, nil, tok.Token, "watch.set", M{"type": "view", "subject": view["ref"]})
		inbox := func() string { return s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/inbox?format=text", nil, 200, nil) }

		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Not art"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Dock crane sprites", "labels": []string{"art"}})
		eventually(t, "the view's watcher to hear of the new art task", func() bool {
			return strings.Contains(inbox(), `SVA-2 Dock crane sprites — in your view "Art nobody has"`)
		})
		if strings.Contains(inbox(), "SVA-1") {
			t.Fatalf("a task outside the view was announced:\n%s", inbox())
		}
		// The saved view can be run by its slug.
		if out := s.call(t, nil, tok.Token, "GET", "/api/v1/w/-/tasks?view=art-nobody-has&format=text", nil, 200, nil); !strings.Contains(out, "SVA-2") || strings.Contains(out, "SVA-1") {
			t.Fatalf("view query:\n%s", out)
		}
	})
}

// TestAFailingWebhookDoesNotHoldUpTheOthers: one webhook that cannot be
// reached, with a backlog of thousands, takes nothing from another's queue.
func TestAFailingWebhookDoesNotHoldUpTheOthers(t *testing.T) {
	t.Parallel()
	s := newSite(t, testdb.SQLite(t))
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Talked about"})
	fine := newReceiver(t, "")
	s.change(t, s.owner, "", "webhook.create", M{"name": "nowhere", "url": "http://127.0.0.1:9/x", "event_types": []string{"task.*"}})
	s.change(t, s.owner, "", "webhook.create", M{"name": "fine", "url": fine.srv.URL, "event_types": []string{"comment.created"}})
	for b := range 7 {
		batch := make([]M, 300)
		for i := range batch {
			batch[i] = M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": fmt.Sprintf("Backlog %d-%d", b, i)}}
		}
		s.call(t, s.owner, "", "POST", w+"/changes", M{"changes": batch}, 200, nil)
	}
	s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "after the backlog"})
	eventually(t, "the working webhook to hear the comment", func() bool { return strings.Contains(fine.types(), "comment.created") })
}

// TestAProjectsWebhookIsNotToldOfTasksOfOtherProjects: a webhook made for
// one project is sent a relation of its tasks to another project's task
// as a reader of that project alone reads it, with the far end blank; a
// webhook for the whole workspace is sent both ends.
func TestAProjectsWebhookIsNotToldOfTasksOfOtherProjects(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
		var sva struct{ Task struct{ ID string } }
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &sva)
		ops, all := newReceiver(t, ""), newReceiver(t, "")
		s.change(t, s.owner, "", "webhook.create", M{"name": "ops", "url": ops.srv.URL, "project": "OPS", "event_types": []string{"relation.*", "task.related"}})
		s.change(t, s.owner, "", "webhook.create", M{"name": "all", "url": all.srv.URL, "event_types": []string{"relation.*", "task.related"}})
		s.change(t, s.owner, "", "relation.add", M{"task": "OPS-1", "type": "blocks", "other": "SVA-1"})
		s.change(t, s.owner, "", "relation.add", M{"task": "SVA-1", "type": "relates", "other": "OPS-1"})

		eventually(t, "both webhooks to hear of both relations", func() bool {
			return strings.Count(ops.types(), "relation.created")+strings.Count(ops.types(), "task.related") >= 2 &&
				strings.Count(all.types(), "relation.created") == 2
		})
		said := func(r *receiver) string {
			r.mu.Lock()
			defer r.mu.Unlock()
			raw, _ := json.Marshal(r.got)
			return string(raw)
		}
		if got := said(ops); strings.Contains(got, sva.Task.ID) || strings.Contains(got, "SVA-1") {
			t.Fatalf("the OPS webhook is told of SVA-1: %s", got)
		}
		if got := said(all); !strings.Contains(got, sva.Task.ID) || !strings.Contains(got, `"other_key":"SVA-1"`) {
			t.Fatalf("the workspace's webhook is not told of SVA-1: %s", got)
		}
	})
}
