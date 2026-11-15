package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// Webhook deliveries wait in the database, a queue for each webhook. A
// webhook gets its events in order, one at a time; a delivery that fails is
// tried again later and holds up only its own queue.

// Timing of deliveries.
const (
	deliveryTick    = 2 * time.Second  // how often the queues are looked at
	deliveryClaim   = 60 * time.Second // how long a claimed delivery is held before another try
	deliveryTimeout = 15 * time.Second // how long a receiver has to answer
	deliveryBatch   = 200              // how many waiting deliveries of one webhook are read at a time
	maxAttempts     = 8
)

// queueDelivery puts one event in a webhook's queue.
func (s *Server) queueDelivery(ctx context.Context, db store.DB, h core.Webhook, ev core.Event) error {
	now := time.Now().UnixMilli()
	return db.Upsert(ctx, core.WebhookDelivery{ID: id.New(), WorkspaceID: h.WorkspaceID, WebhookID: h.ID, Seq: ev.Seq, EventType: ev.Type,
		State: core.DeliveryPending, CreatedAt: now, NextAt: now}, "webhook_id", "seq")
}

// busyHooks is the set of webhooks being delivered to right now, shared by
// the loop that starts deliveries and the goroutines that make them.
type busyHooks struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (b *busyHooks) has(hookID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ids[hookID]
}

// claim marks a webhook busy unless it already is, and reports whether it did.
func (b *busyHooks) claim(hookID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ids[hookID] {
		return false
	}
	b.ids[hookID] = true
	return true
}

func (b *busyHooks) release(hookID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.ids, hookID)
}

// runDeliveries works through the webhooks' queues until ctx ends, and
// returns once the deliveries it started have.
func (s *Server) runDeliveries(ctx context.Context) {
	tick := time.NewTicker(deliveryTick)
	defer tick.Stop()
	busy := &busyHooks{ids: map[string]bool{}}
	var sending sync.WaitGroup
	defer sending.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		byHook, err := s.waitingDeliveries(ctx, busy)
		if err != nil {
			continue
		}
		now := time.Now().UnixMilli()
		for hookID, list := range byHook {
			if list[0].NextAt > now || !busy.claim(hookID) {
				continue
			}
			sending.Go(func() {
				defer busy.release(hookID)
				s.deliverInOrder(ctx, list)
			})
		}
	}
}

// waitingDeliveries reads the waiting deliveries of each webhook that is
// not busy, oldest first. Each webhook's own queue is read by itself: one
// that keeps failing, however long its backlog, takes nothing from the
// others.
func (s *Server) waitingDeliveries(ctx context.Context, busy *busyHooks) (map[string][]core.WebhookDelivery, error) {
	var hooks []core.Webhook
	if err := s.st.List(ctx, &hooks, store.Where(store.Live)); err != nil {
		return nil, err
	}
	byHook := map[string][]core.WebhookDelivery{}
	for _, h := range hooks {
		if busy.has(h.ID) {
			continue
		}
		var list []core.WebhookDelivery
		q := store.Q{Where: []store.Cond{store.Eq("webhook_id", h.ID), store.Eq("state", core.DeliveryPending)}, Order: "seq", Limit: deliveryBatch}
		if err := s.st.List(ctx, &list, q); err == nil && len(list) > 0 {
			byHook[h.ID] = list
		}
	}
	return byHook, nil
}

// deliverInOrder makes one webhook's deliveries one after another. A
// webhook gets its events in order: nothing overtakes a delivery that is
// waiting to be retried, so it stops at the first that is not finished.
func (s *Server) deliverInOrder(ctx context.Context, list []core.WebhookDelivery) {
	for _, d := range list {
		// Claim it by moving its time on; only one server wins.
		n, err := s.st.Update(ctx, "webhook_deliveries", map[string]any{"next_at": time.Now().UnixMilli() + deliveryClaim.Milliseconds(), "attempts": d.Attempts + 1},
			store.Eq("id", d.ID), store.Eq("state", core.DeliveryPending), store.Eq("attempts", d.Attempts))
		if err != nil || n != 1 {
			return
		}
		d.Attempts++
		if !s.deliver(ctx, d) {
			return // the rest wait behind this one
		}
	}
}

// backoff says how long to wait before the next attempt: 3s, 15s, 30s, 1m
// and so on, up to an hour.
func backoff(attempts int) time.Duration {
	if attempts <= 1 {
		return 3 * time.Second
	}
	return min(15*time.Second<<min(attempts-2, 10), time.Hour)
}

// deliver sends one event to one webhook and records what happened. It
// reports whether the delivery is finished, so the next one may go. A
// delivery whose webhook or event is gone is given up; one that could not
// be read for any other reason waits for its claim to run out and is tried
// again. When ctx ends during the send, the send is cut off and the
// delivery is put back as it was before this attempt, to go first thing
// when a server runs again.
func (s *Server) deliver(ctx context.Context, d core.WebhookDelivery) bool {
	// Only the send ends with ctx: what came of it is read and recorded even
	// while the server stops, which waits for this.
	sendCtx, ctx := ctx, context.WithoutCancel(ctx)
	db := s.st.In(d.WorkspaceID)
	var h core.Webhook
	err := db.Get(ctx, &h, store.Eq("id", d.WebhookID), store.Live)
	if errors.Is(err, store.ErrNotFound) {
		return s.giveUpDelivery(ctx, db, d, "the webhook was deleted")
	}
	if err != nil {
		s.log.Error("webhook delivery: reading its webhook", "delivery", d.ID, "err", err)
		return false
	}
	evs, err := db.Events(ctx, store.EventFilter{After: d.Seq - 1, Limit: 1})
	if err != nil {
		s.log.Error("webhook delivery: reading its event", "delivery", d.ID, "err", err)
		return false
	}
	if len(evs) == 0 || evs[0].Seq != d.Seq {
		return s.giveUpDelivery(ctx, db, d, "the event is gone")
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", h.WorkspaceID)); err != nil {
		s.log.Error("webhook delivery: reading its workspace", "delivery", d.ID, "err", err)
		return false
	}
	status, errText, took := s.sendDelivery(sendCtx, ws, h, d.ID, evs[0])
	now := time.Now().UnixMilli()
	if status == 0 && sendCtx.Err() != nil {
		s.recordOutcome(ctx, "webhook delivery", func(ctx context.Context) error {
			_, err := db.Update(ctx, "webhook_deliveries", map[string]any{"attempts": d.Attempts - 1, "next_at": now,
				"error": "the server stopped before the receiver answered; it is sent again"}, store.Eq("id", d.ID))
			return err
		}, "delivery", d.ID)
		return false
	}
	set := map[string]any{"status_code": status, "error": errText, "duration_ms": int(took.Milliseconds())}
	hookSet := map[string]any{"last_at": now}
	switch {
	case status >= 200 && status < 300:
		set["state"], set["done_at"] = "ok", now
		hookSet["failures"], hookSet["last_status"] = 0, fmt.Sprint(status)
	case d.Attempts >= maxAttempts:
		set["state"], set["done_at"] = "dead", now
		hookSet["failures"], hookSet["last_status"] = h.Failures+1, firstNonEmpty(errText, fmt.Sprint(status))
	default:
		set["next_at"] = now + backoff(d.Attempts).Milliseconds()
		hookSet["failures"], hookSet["last_status"] = h.Failures+1, firstNonEmpty(errText, fmt.Sprint(status))
	}
	// Not recorded, the delivery is sent again when its claim runs out; the
	// ones behind it wait so they do not overtake it.
	if !s.recordOutcome(ctx, "webhook delivery", func(ctx context.Context) error {
		_, err := db.Update(ctx, "webhook_deliveries", set, store.Eq("id", d.ID))
		return err
	}, "delivery", d.ID) {
		return false
	}
	if _, err := db.Update(ctx, "webhooks", hookSet, store.Eq("id", h.ID)); err != nil {
		s.log.Error("webhook delivery: the webhook's last result", "webhook", h.ID, "err", err)
	}
	return set["state"] == "ok" || set["state"] == "dead"
}

// giveUpDelivery records a delivery as dead for the reason given, and
// reports that the next one may go. Not recorded, it is given up again on
// its next try.
func (s *Server) giveUpDelivery(ctx context.Context, db store.DB, d core.WebhookDelivery, reason string) bool {
	s.recordOutcome(ctx, "webhook delivery", func(ctx context.Context) error {
		_, err := db.Update(ctx, "webhook_deliveries", map[string]any{"state": core.DeliveryDead, "error": reason, "done_at": time.Now().UnixMilli()}, store.Eq("id", d.ID))
		return err
	}, "delivery", d.ID)
	return true
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// sendDelivery sends the request. The body carries the event as stored plus one
// line saying what happened, so a receiver can act without calling back.
func (s *Server) sendDelivery(ctx context.Context, ws core.Workspace, h core.Webhook, deliveryID string, ev core.Event) (status int, errText string, took time.Duration) {
	// The line is written by the same code that answers requests, which
	// reads through a request: this one is made up, and carries ctx.
	x := &c{s: s, r: (&http.Request{}).WithContext(ctx), ws: ws, db: s.st.In(ws.ID)}
	line := ""
	if names, err := x.names(); err == nil { //nolint:contextcheck // x carries ctx in its made-up request
		line = x.eventLine(ev, names) //nolint:contextcheck // as above
	}
	payload := map[string]any{"delivery": deliveryID, "workspace": ws.Slug, "seq": ev.Seq, "type": ev.Type, "text": line, "event": ev,
		"url": s.cfg.BaseURL}
	if !isNews(ev) {
		payload["quiet"] = true // history brought in, not done now: the receiver may want to hold back
	}
	body := plainjson.Marshal(payload)
	rctx, cancel := context.WithTimeout(ctx, deliveryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodPost, h.URL, bytes.NewReader(body))
	if err != nil {
		return 0, err.Error(), 0
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Quadit-Webhook/"+s.cfg.Version)
	req.Header.Set("X-Quadit-Event", ev.Type)
	req.Header.Set("X-Quadit-Delivery", deliveryID)
	if h.Secret != "" {
		mac := hmac.New(sha256.New, []byte(h.Secret))
		mac.Write(body)
		req.Header.Set("X-Quadit-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	took = time.Since(start)
	if err != nil {
		return 0, plainNetError(err), took
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10)) //nolint:errcheck // drained only so the connection is reused; the status is the answer
	if resp.StatusCode >= 300 {
		return resp.StatusCode, "answered " + resp.Status, took
	}
	return resp.StatusCode, "", took
}

// plainNetError says why a request did not get through, without the
// library's own framing ("Post \"url\": dial tcp …").
func plainNetError(err error) string {
	said := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(said, "Client.Timeout"):
		return "no answer in time"
	case strings.Contains(said, "connection refused"):
		return "could not connect: nothing is listening at that address"
	case strings.Contains(said, "no such host"):
		return "could not connect: the host name was not found"
	case strings.Contains(said, "HTTP response to HTTPS client"):
		return "could not connect: the address answers plain HTTP, not HTTPS; write it with http://"
	case strings.Contains(said, "certificate"):
		return "could not connect: the address's certificate was not accepted (" + oneLine(said[strings.LastIndex(said, ": ")+2:], 120) + ")"
	}
	if ue, ok := errors.AsType[*url.Error](err); ok {
		said = ue.Err.Error()
	}
	return "could not connect: " + oneLine(said, 200)
}

// handleResendDelivery sends a delivery again, whatever became of it.
func (s *Server) handleResendDelivery(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	tests, err := x.db.Count(x.ctx(), "webhook_deliveries", store.Eq("id", x.r.PathValue("id")), store.Lt("seq", int64(0)))
	if err != nil {
		return err
	}
	if tests > 0 {
		return errBad("this was a test; send a new test instead")
	}
	n, err := x.db.Update(x.ctx(), "webhook_deliveries", map[string]any{"state": core.DeliveryPending, "attempts": 0, "next_at": time.Now().UnixMilli(), "done_at": 0, "error": ""},
		store.Eq("id", x.r.PathValue("id")))
	if err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("delivery")
	}
	return x.ok(map[string]any{"ok": true})
}

// handleSendTestWebhook posts a sample event to a webhook right now and returns what
// the receiver answered.
func (s *Server) handleSendTestWebhook(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	var h core.Webhook
	err := x.db.Get(x.ctx(), &h, store.Eq("id", x.r.PathValue("id")), store.Live)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("webhook")
	}
	if err != nil {
		return err
	}
	sample := plainjson.Marshal(map[string]any{"test": true})
	ev := core.Event{WorkspaceID: x.ws.ID, At: time.Now().UnixMilli(), ActorID: x.member.UserID, Type: "webhook.test", EntityType: "webhook",
		EntityID: h.ID, ScopeType: "workspace", ScopeID: x.ws.ID, Data: sample}
	did := id.New()
	status, errText, took := s.sendDelivery(x.ctx(), x.ws, h, did, ev)
	// A test shows in the delivery log like any other delivery. It has no
	// place in the feed, so it gets a number of its own below zero.
	now := time.Now().UnixMilli()
	d := core.WebhookDelivery{ID: did, WorkspaceID: x.ws.ID, WebhookID: h.ID, Seq: -now, EventType: ev.Type, State: core.DeliveryOK, Attempts: 1,
		StatusCode: status, Error: errText, DurationMS: int(took.Milliseconds()), CreatedAt: now, DoneAt: now}
	if status < 200 || status >= 300 {
		d.State = core.DeliveryDead
	}
	if err := x.db.Insert(x.ctx(), d); err != nil {
		s.log.Error("webhook test: delivery log", "err", err)
	}
	// The webhook's own record says when it last answered and how. A test
	// does not count for or against it as a run of failures.
	last := fmt.Sprint(status)
	if d.State != core.DeliveryOK {
		last = firstNonEmpty(errText, last)
	}
	if _, err := x.db.Update(x.ctx(), "webhooks", map[string]any{"last_at": now, "last_status": last}, store.Eq("id", h.ID)); err != nil {
		s.log.Error("webhook test: last result", "err", err)
	}
	return x.ok(map[string]any{"status": status, "error": errText, "ms": took.Milliseconds(), "ok": status >= 200 && status < 300})
}
