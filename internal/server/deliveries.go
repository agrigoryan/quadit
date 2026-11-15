package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	"github.com/agrigoryan/quadit/internal/store"
)

// Webhook deliveries wait in the database, a queue for each webhook. A
// webhook gets its events in order, one at a time; a delivery that fails is
// tried again later and holds up only its own queue.

func (s *Server) queueDelivery(ctx context.Context, db store.DB, h core.Webhook, ev core.Event) error {
	now := time.Now().UnixMilli()
	return db.Upsert(ctx, core.WebhookDelivery{ID: id.New(), WorkspaceID: h.WorkspaceID, WebhookID: h.ID, Seq: ev.Seq, EventType: ev.Type,
		State: "pending", CreatedAt: now, NextAt: now}, "webhook_id", "seq")
}

func (s *Server) runDeliveries(ctx context.Context) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	var mu sync.Mutex
	busy := map[string]bool{} // webhooks being delivered to right now
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		// Each webhook's own queue is read by itself: one that keeps
		// failing, however long its backlog, takes nothing from the others.
		var hooks []core.Webhook
		if err := s.st.List(ctx, &hooks, store.Where(store.Live)); err != nil {
			continue
		}
		// A webhook gets its events in order: one at a time, and nothing
		// overtakes a delivery that is waiting to be retried.
		byHook := map[string][]core.WebhookDelivery{}
		for _, h := range hooks {
			mu.Lock()
			at := busy[h.ID]
			mu.Unlock()
			if at {
				continue
			}
			var list []core.WebhookDelivery
			if err := s.st.List(ctx, &list, store.Q{Where: []store.Cond{store.Eq("webhook_id", h.ID), store.Eq("state", "pending")}, Order: "seq", Limit: 200}); err == nil && len(list) > 0 {
				byHook[h.ID] = list
			}
		}
		now := time.Now().UnixMilli()
		for hookID, list := range byHook {
			mu.Lock()
			skip := busy[hookID] || list[0].NextAt > now
			if !skip {
				busy[hookID] = true
			}
			mu.Unlock()
			if skip {
				continue
			}
			go func() {
				defer func() { mu.Lock(); delete(busy, hookID); mu.Unlock() }()
				for _, d := range list {
					// Claim it by moving its time on; only one server wins.
					n, err := s.st.Update(ctx, "webhook_deliveries", map[string]any{"next_at": time.Now().UnixMilli() + 60_000, "attempts": d.Attempts + 1},
						store.Eq("id", d.ID), store.Eq("state", "pending"), store.Eq("attempts", d.Attempts))
					if err != nil || n != 1 {
						return
					}
					d.Attempts++
					if !s.deliver(context.WithoutCancel(ctx), d) {
						return // the rest wait behind this one
					}
				}
			}()
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

const maxAttempts = 8

// deliver sends one event to one webhook and records what happened. It
// reports whether the receiver took it.
func (s *Server) deliver(ctx context.Context, d core.WebhookDelivery) bool {
	db := s.st.In(d.WorkspaceID)
	var h core.Webhook
	var evs []core.Event
	if err := db.Get(ctx, &h, store.Eq("id", d.WebhookID), store.Live); err != nil {
		db.Update(ctx, "webhook_deliveries", map[string]any{"state": "dead", "error": "the webhook was deleted", "done_at": time.Now().UnixMilli()}, store.Eq("id", d.ID))
		return true
	}
	evs, _ = db.Events(ctx, store.EventFilter{After: d.Seq - 1, Limit: 1})
	if len(evs) == 0 || evs[0].Seq != d.Seq {
		db.Update(ctx, "webhook_deliveries", map[string]any{"state": "dead", "error": "the event is gone", "done_at": time.Now().UnixMilli()}, store.Eq("id", d.ID))
		return true
	}
	status, errText, took := s.sendDelivery(ctx, h, d.ID, evs[0])
	now := time.Now().UnixMilli()
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
	db.Update(ctx, "webhook_deliveries", set, store.Eq("id", d.ID))
	db.Update(ctx, "webhooks", hookSet, store.Eq("id", h.ID))
	return set["state"] == "ok" || set["state"] == "dead"
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// sendDelivery sends the request. The body carries the event as stored plus one
// line saying what happened, so a receiver can act without calling back.
func (s *Server) sendDelivery(ctx context.Context, h core.Webhook, deliveryID string, ev core.Event) (status int, errText string, took time.Duration) {
	var ws core.Workspace
	s.st.Get(ctx, &ws, store.Eq("id", h.WorkspaceID))
	x := &c{s: s, r: (&http.Request{}).WithContext(ctx), ws: ws, db: s.st.In(ws.ID)}
	line := ""
	if names, err := x.names(); err == nil {
		line = x.eventLine(ev, names)
	}
	payload := map[string]any{"delivery": deliveryID, "workspace": ws.Slug, "seq": ev.Seq, "type": ev.Type, "text": line, "event": ev,
		"url": s.cfg.BaseURL}
	if !isNews(ev) {
		payload["quiet"] = true // history brought in, not done now: the receiver may want to hold back
	}
	body, _ := json.Marshal(payload)
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, "POST", h.URL, bytes.NewReader(body))
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
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
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
	var ue *url.Error
	if errors.As(err, &ue) {
		said = ue.Err.Error()
	}
	return "could not connect: " + oneLine(said, 200)
}

// handleResendDelivery sends a delivery again, whatever became of it.
func (s *Server) handleResendDelivery(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	if n, _ := x.db.Count(x.ctx(), "webhook_deliveries", store.Eq("id", x.r.PathValue("id")), store.Lt("seq", int64(0))); n > 0 {
		return errBad("this was a test; send a new test instead")
	}
	n, err := x.db.Update(x.ctx(), "webhook_deliveries", map[string]any{"state": "pending", "attempts": 0, "next_at": time.Now().UnixMilli(), "done_at": 0, "error": ""},
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
	if err := x.db.Get(x.ctx(), &h, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("webhook")
	}
	sample, _ := json.Marshal(map[string]any{"test": true})
	ev := core.Event{WorkspaceID: x.ws.ID, At: time.Now().UnixMilli(), ActorID: x.member.UserID, Type: "webhook.test", EntityType: "webhook",
		EntityID: h.ID, ScopeType: "workspace", ScopeID: x.ws.ID, Data: sample}
	did := id.New()
	status, errText, took := s.sendDelivery(x.ctx(), h, did, ev)
	// A test shows in the delivery log like any other delivery. It has no
	// place in the feed, so it gets a number of its own below zero.
	now := time.Now().UnixMilli()
	d := core.WebhookDelivery{ID: did, WorkspaceID: x.ws.ID, WebhookID: h.ID, Seq: -now, EventType: ev.Type, State: "ok", Attempts: 1,
		StatusCode: status, Error: errText, DurationMS: int(took.Milliseconds()), CreatedAt: now, DoneAt: now}
	if status < 200 || status >= 300 {
		d.State = "dead"
	}
	if err := x.db.Insert(x.ctx(), d); err != nil {
		s.log.Error("webhook test: delivery log", "err", err)
	}
	// The webhook's own record says when it last answered and how. A test
	// does not count for or against it as a run of failures.
	last := fmt.Sprint(status)
	if d.State != "ok" {
		last = firstNonEmpty(errText, last)
	}
	if _, err := x.db.Update(x.ctx(), "webhooks", map[string]any{"last_at": now, "last_status": last}, store.Eq("id", h.ID)); err != nil {
		s.log.Error("webhook test: last result", "err", err)
	}
	return x.ok(map[string]any{"status": status, "error": errText, "ms": took.Milliseconds(), "ok": status >= 200 && status < 300})
}
