package server_test

import (
	"context"
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
	"sync/atomic"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
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

// seqs are the events' numbers, in the order heard.
func (r *receiver) seqs() []float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []float64
	for _, m := range r.got {
		seq, _ := m["seq"].(float64)
		out = append(out, seq)
	}
	return out
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
	// Not in parallel: it times the background work against a backlog, which a busy machine delays.
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

// TestADispatchedBatchDoneAgainSendsNothingTwice: a batch the dispatcher
// handles again, because a reaction failed (a wake-up that could not be
// queued) or because the server stopped before it recorded how far it
// got, leaves every delivery already queued or made as it is: none is
// sent twice, and one made keeps its id, state, attempts and times.
func TestADispatchedBatchDoneAgainSendsNothingTwice(t *testing.T) {
	// Not in parallel: it times the background work against a fault, which a busy machine delays.
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := newFaultyStore(plain)
		s := newSite(t, st)
		_, bea := s.invitedPerson(t)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		hook := newReceiver(t, "")
		s.change(t, s.owner, "", "webhook.create", M{"name": "tasks", "url": hook.srv.URL, "event_types": []string{"task.created"}})
		deliveries := func() []core.WebhookDelivery {
			var list []core.WebhookDelivery
			if err := plain.List(t.Context(), &list, store.Q{Order: "seq"}); err != nil {
				t.Fatal(err)
			}
			return list
		}

		// The daily jobs are queued when the server starts; wait for them,
		// so the fault meets the wake-up. The task's wake-up for Bea cannot
		// be queued the first time: the batch is handled again.
		eventually(t, "the daily jobs to be queued", func() bool {
			n, err := plain.Count(t.Context(), "jobs", store.Eq("kind", "trash.purge"))
			return err == nil && n > 0
		})
		fired := st.faults.arm(fault{op: "insert", table: "jobs", times: 1})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Dock crane", "assignee": bea})
		// Every event dispatched and every delivery made.
		settled := func() bool {
			var ws core.Workspace
			if err := plain.Get(t.Context(), &ws, store.Eq("slug", "games")); err != nil || ws.DispatchedSeq != ws.Seq {
				return false
			}
			list := deliveries()
			for _, d := range list {
				if d.State != core.DeliveryOK {
					return false
				}
			}
			return len(list) > 0
		}
		eventually(t, "the tasks' deliveries to be made", func() bool { return fired() == 1 && settled() })
		made := deliveries()

		// The server stopped before it recorded how far it got: the batch
		// is handled again from before the delivery made.
		if _, err := plain.Update(t.Context(), "workspaces", map[string]any{"dispatched_seq": made[0].Seq - 1}, store.Eq("slug", "games")); err != nil {
			t.Fatal(err)
		}
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Second"})
		eventually(t, "the second task's delivery to be made", func() bool { return settled() && len(deliveries()) == len(made)+1 })
		for i, again := range deliveries()[:len(made)] {
			if again != made[i] {
				t.Fatalf("a delivery made was changed by the batch done again:\n%+v\nwas\n%+v", again, made[i])
			}
		}
		heard := map[float64]bool{}
		for _, seq := range hook.seqs() {
			if heard[seq] {
				t.Fatalf("the webhook heard event %v twice", seq)
			}
			heard[seq] = true
		}
		if len(heard) != len(made)+1 {
			t.Fatalf("the webhook heard %d events, want %d", len(heard), len(made)+1)
		}
	})
}

// TestAWebhookHearsEventsInOrder: a webhook hears its events in the order
// they happened, also when one reaches it through a rule and a later one
// through its own subscription, and when the batch holding them is handled
// a second time because a reaction failed the first.
func TestAWebhookHearsEventsInOrder(t *testing.T) {
	// Not in parallel: it times the background work against a fault, which a busy machine delays.
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := newFaultyStore(plain)
		s := newSite(t, st)
		_, bea := s.invitedPerson(t)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Talked about"})
		hook := newReceiver(t, "")
		ref := s.change(t, s.owner, "", "webhook.create", M{"name": "mirror", "url": hook.srv.URL, "event_types": []string{"task.updated"}})["ref"]
		s.change(t, s.owner, "", "rule.create", M{"name": "comments too", "match": M{"event_types": []string{"comment.created"}},
			"action": M{"kind": "webhook", "webhook_id": ref}})
		eventually(t, "the daily jobs to be queued, and the events so far to be dispatched", func() bool {
			var ws core.Workspace
			if err := plain.Get(t.Context(), &ws, store.Eq("slug", "games")); err != nil || ws.DispatchedSeq != ws.Seq {
				return false
			}
			n, err := plain.Count(t.Context(), "jobs", store.Eq("kind", "trash.purge"))
			return err == nil && n > 0
		})

		// One batch: a wake-up for Bea, which cannot be queued the first
		// time; a comment, which reaches the webhook through the rule; a
		// change of the task, which reaches it through its subscription.
		fired := st.faults.arm(fault{op: "insert", table: "jobs", times: 1})
		s.call(t, s.owner, "", "POST", w+"/changes", M{"changes": []M{
			{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Dock crane", "assignee": bea}},
			{"id": id.New(), "type": "comment.create", "args": M{"task": "SVA-1", "body": "first"}},
			{"id": id.New(), "type": "task.update", "args": M{"id": "SVA-1", "title": "Talked about, then"}},
		}}, 200, nil)
		eventually(t, "the webhook to hear the comment and the change", func() bool { return strings.Count(hook.types(), " ") == 1 })
		if fired() != 1 {
			t.Fatalf("the fault fired %d times, want once", fired())
		}
		if got := hook.types(); got != "comment.created task.updated" {
			t.Fatalf("the webhook heard %q, want the comment, then the change", got)
		}
	})
}

// TestAWebhooksDeliveriesAreQueuedABatchAtATime: the dispatcher queues the
// deliveries of a batch of events (dispatchBatch, 300) in one write, not
// one write each: on a slow disk a commit for every event a busy webhook
// wants would hold every later event, and every other webhook, behind it.
func TestAWebhooksDeliveriesAreQueuedABatchAtATime(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := &deliveryWrites{Store: plain}
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "webhook.create", M{"name": "nowhere", "url": "http://127.0.0.1:9/x", "event_types": []string{"task.*"}})
		batch := make([]M, 400)
		for i := range batch {
			batch[i] = M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": fmt.Sprintf("Backlog %d", i)}}
		}
		s.call(t, s.owner, "", "POST", w+"/changes", M{"changes": batch}, 200, nil)
		eventually(t, "every task's delivery to be queued", func() bool {
			n, err := plain.Count(t.Context(), "webhook_deliveries")
			return err == nil && n == len(batch)
		})
		// The 400 events, and the few before them, are two batches at most.
		if n := st.writes.Load(); n > 2 {
			t.Fatalf("the deliveries of %d events were queued in %d writes, want two at most", len(batch), n)
		}
	})
}

// deliveryWrites is a store that counts the writes that queue webhook
// deliveries: each delivery queued on its own, and each transaction
// (Atomic) that queues any.
type deliveryWrites struct {
	store.Store
	writes atomic.Int64
}

func (s *deliveryWrites) In(workspaceID string) store.DB {
	return &deliveryWritesDB{DB: s.Store.In(workspaceID), writes: &s.writes}
}

func (s *deliveryWrites) Atomic(ctx context.Context, fn func(store.DB) error) error {
	var inside atomic.Int64
	err := s.Store.Atomic(ctx, func(db store.DB) error { return fn(&deliveryWritesDB{DB: db, writes: &inside}) })
	if inside.Load() > 0 {
		s.writes.Add(1)
	}
	return err
}

// deliveryWritesDB counts the deliveries it queues.
type deliveryWritesDB struct {
	store.DB
	writes *atomic.Int64
}

func (db *deliveryWritesDB) Ensure(ctx context.Context, row any, key ...string) error {
	if _, ok := row.(core.WebhookDelivery); ok {
		db.writes.Add(1)
	}
	return db.DB.Ensure(ctx, row, key...)
}

func (db *deliveryWritesDB) Upsert(ctx context.Context, row any, key ...string) error {
	if _, ok := row.(core.WebhookDelivery); ok {
		db.writes.Add(1)
	}
	return db.DB.Upsert(ctx, row, key...)
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
