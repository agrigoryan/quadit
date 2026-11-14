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
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// The dispatcher reads each workspace's feed after the position it has
// handled and turns events into wake-ups: webhook deliveries, rule actions,
// and push and mail for inbox items. It works from the feed in the
// database, not from the request that made the change, so nothing is lost
// if the server restarts between a change and its wake-up.

func init() {
	runners = append(runners, (*Server).runDispatcher, (*Server).runDeliveries, (*Server).runJobs)
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/w/{ws}/deliveries/{id}/redeliver", s.in(s.hRedeliver))
		m.HandleFunc("POST /api/v1/w/{ws}/webhooks/{id}/test", s.in(s.hWebhookTest))
	})
}

func (s *Server) runDispatcher(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		wake := s.hub.Any()
		if err := s.dispatchAll(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("dispatcher", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-tick.C:
		}
	}
}

func (s *Server) dispatchAll(ctx context.Context) error {
	var wss []core.Workspace
	if err := s.st.List(ctx, &wss, store.Where(store.Live)); err != nil {
		return err
	}
	for _, ws := range wss {
		for ws.DispatchedSeq < ws.Seq {
			next, err := s.dispatch(ctx, ws)
			if err != nil {
				return fmt.Errorf("workspace %s: %w", ws.Slug, err)
			}
			if next == ws.DispatchedSeq {
				break
			}
			ws.DispatchedSeq = next
		}
	}
	return nil
}

// dispatch handles one batch of a workspace's events and returns the new
// position.
func (s *Server) dispatch(ctx context.Context, ws core.Workspace) (int64, error) {
	db := s.st.In(ws.ID)
	evs, err := db.Events(ctx, store.EventFilter{After: ws.DispatchedSeq, Limit: 300})
	if err != nil || len(evs) == 0 {
		return ws.DispatchedSeq, err
	}
	var hooks []core.Webhook
	var rules []core.Rule
	if err := db.List(ctx, &hooks, store.Where(store.Live, store.Eq("active", true))); err != nil {
		return 0, err
	}
	if err := db.List(ctx, &rules, store.Where(store.Live, store.Eq("active", true))); err != nil {
		return 0, err
	}
	// Saved views someone watches: a task that comes into one is news for them.
	var viewWatchers []core.Watcher
	if err := db.List(ctx, &viewWatchers, store.Where(store.Eq("subject_type", "view"))); err != nil {
		return 0, err
	}
	for _, ev := range evs {
		for _, h := range hooks {
			if hookWants(h, ev) {
				if err := s.queueDelivery(ctx, db, h, ev); err != nil {
					return 0, err
				}
			}
		}
		if len(viewWatchers) > 0 && ev.AudienceID == "" && ev.ScopeType == "task" && (ev.Type == "task.created" || ev.Type == "task.updated") {
			for _, vw := range viewWatchers {
				if vw.UserID == ev.ActorID {
					continue
				}
				if err := s.viewNews(ctx, ws, vw, ev); err != nil {
					s.log.Error("watched view", "view", vw.SubjectID, "seq", ev.Seq, "err", err)
				}
			}
		}
		if len(rules) > 0 && ev.AudienceID == "" && !strings.Contains(string(ev.Data), `"rule":`) {
			for _, r := range rules {
				if err := s.runRule(ctx, ws, db, r, hooks, ev); err != nil {
					s.log.Error("rule", "rule", r.Name, "seq", ev.Seq, "err", err)
				}
			}
		}
		if ev.Type == "notification.created" {
			var d struct {
				Row core.Notification `json:"row"`
			}
			if json.Unmarshal(ev.Data, &d) == nil && d.Row.ID != "" {
				// Give the person a moment to see it in an open window first.
				s.enqueue(ctx, "notify", ws.ID, "notify:"+d.Row.ID, map[string]string{"id": d.Row.ID}, time.Now().Add(20*time.Second))
			}
		}
	}
	last := evs[len(evs)-1].Seq
	_, err = s.st.Update(ctx, "workspaces", map[string]any{"dispatched_seq": last}, store.Eq("id", ws.ID), store.Lt("dispatched_seq", last))
	return last, err
}

// viewNews tells the watcher of a saved view when a change leaves a task in
// that view. A task is announced once a day at most, however often it moves.
func (s *Server) viewNews(ctx context.Context, ws core.Workspace, vw core.Watcher, ev core.Event) error {
	db := s.st.In(ws.ID)
	var view core.View
	var m core.Member
	if db.Get(ctx, &view, store.Eq("id", vw.SubjectID), store.Live) != nil || db.Get(ctx, &m, store.Eq("user_id", vw.UserID), store.Null("removed_at")) != nil {
		return nil
	}
	// Run the view's query as the watcher, narrowed to this one task.
	x := &c{s: s, r: (&http.Request{URL: &url.URL{}}).WithContext(ctx), ws: ws, db: db, member: m}
	if m.Scope != nil {
		x.projects = m.Scope.Projects
	}
	var q TaskQuery
	if len(view.Query) > 0 {
		if err := json.Unmarshal(view.Query, &q); err != nil {
			return nil
		}
	}
	if view.ProjectID != "" && len(q.Project) == 0 {
		q.Project = []string{view.ProjectID}
	}
	f, err := x.filter(q)
	if err != nil {
		return nil // the view names something that is gone; nothing to watch
	}
	f.IDs, f.Limit, f.Offset, f.Sort = []string{ev.ScopeID}, 1, 0, ""
	if n, err := db.CountTasks(ctx, f); err != nil || n == 0 {
		return err
	}
	once := id.From("view-news", view.ID, vw.UserID, ev.ScopeID, time.UnixMilli(ev.At).UTC().Format("2006-01-02"))
	return s.eng.System(ctx, ws.ID, ev.ActorID, func(sys *engine.Sys) error {
		if done, err := sys.Once(once, "view-news"); err != nil || done {
			return err
		}
		return sys.Do("notify", map[string]any{"user": vw.UserID, "task": ev.ScopeID, "message": "in your view \"" + view.Name + "\""})
	})
}

// typeMatches checks an event type against a list where "task.*" covers a
// whole family. An empty list covers everything.
func typeMatches(patterns []string, typ string) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, p := range patterns {
		if p == typ || p == "*" || (strings.HasSuffix(p, ".*") && strings.HasPrefix(typ, strings.TrimSuffix(p, "*"))) {
			return true
		}
	}
	return false
}

// hookWants reports whether a webhook should get an event. A webhook "for"
// a member gets that member's inbox items and nothing else; any other
// webhook gets the public events it asked for.
func hookWants(h core.Webhook, ev core.Event) bool {
	if h.UserID != "" {
		return ev.Type == "notification.created" && ev.AudienceID == h.UserID
	}
	if ev.AudienceID != "" {
		return false
	}
	if h.ProjectID != "" && ev.ProjectID != h.ProjectID {
		return false
	}
	return typeMatches(h.EventTypes, ev.Type)
}

func (s *Server) queueDelivery(ctx context.Context, db store.DB, h core.Webhook, ev core.Event) error {
	now := time.Now().UnixMilli()
	return db.Upsert(ctx, core.WebhookDelivery{ID: id.New(), WorkspaceID: h.WorkspaceID, WebhookID: h.ID, Seq: ev.Seq, EventType: ev.Type,
		State: "pending", CreatedAt: now, NextAt: now}, "webhook_id", "seq")
}

// runRule applies one rule to one event if it matches.
func (s *Server) runRule(ctx context.Context, ws core.Workspace, db store.DB, r core.Rule, hooks []core.Webhook, ev core.Event) error {
	m, a := r.Match, r.Action
	if a == nil {
		return nil
	}
	if m == nil {
		m = &core.RuleMatch{}
	}
	if !typeMatches(m.EventTypes, ev.Type) || (m.ProjectID != "" && m.ProjectID != ev.ProjectID) || (m.ActorID != "" && m.ActorID != ev.ActorID) {
		return nil
	}
	var d struct {
		Key     string                      `json:"key"`
		Row     json.RawMessage             `json:"row"`
		Changes map[string]core.FieldChange `json:"changes"`
	}
	json.Unmarshal(ev.Data, &d)
	if m.ActorKind != "" {
		var actor core.Member
		if err := db.Get(ctx, &actor, store.Eq("user_id", ev.ActorID)); err != nil || actor.Kind != m.ActorKind {
			return nil
		}
	}
	if m.Outcome != "" {
		var dc core.Decision
		if json.Unmarshal(d.Row, &dc) != nil || dc.Outcome != m.Outcome {
			return nil
		}
	}
	if m.ToCategory != "" {
		to, _ := d.Changes["status_id"].To.(string)
		var st core.Status
		if to == "" || db.Get(ctx, &st, store.Eq("id", to)) != nil || st.Category != m.ToCategory {
			return nil
		}
	}
	taskID := ""
	if ev.ScopeType == "task" {
		taskID = ev.ScopeID
	}
	if m.LabelID != "" {
		var t core.Task
		if taskID == "" || db.Get(ctx, &t, store.Eq("id", taskID)) != nil || !has(t.LabelIDs, m.LabelID) {
			return nil
		}
	}
	if a.Kind == "webhook" {
		for _, h := range hooks {
			if h.ID == a.WebhookID {
				return s.queueDelivery(ctx, db, h, ev)
			}
		}
		return nil
	}
	// The id is made from the rule and the event, so running the same
	// event through twice acts once.
	once := id.From("rule", r.ID, fmt.Sprint(ev.Seq))
	return s.eng.System(ctx, ws.ID, r.CreatedBy, func(sys *engine.Sys) error {
		if done, err := sys.Once(once, "rule"); err != nil || done {
			return err
		}
		sys.From(r.ID)
		msg := a.Message
		if msg == "" {
			msg = r.Name
		}
		switch a.Kind {
		case "notify":
			args := map[string]any{"user": a.UserID, "message": msg}
			if taskID != "" {
				args["task"] = taskID
			}
			return sys.Do("notify", args)
		case "assign":
			if taskID == "" {
				return nil
			}
			return sys.Do("task.update", map[string]any{"id": taskID, "assignee": a.UserID})
		case "wait_on":
			if taskID == "" {
				return nil
			}
			return sys.Do("task.update", map[string]any{"id": taskID, "waiting_on": a.UserID, "waiting_on_note": msg})
		}
		return nil
	})
}

// ---- webhook deliveries ----

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
		var pending []core.WebhookDelivery
		if err := s.st.List(ctx, &pending, store.Q{Where: []store.Cond{store.Eq("state", "pending")}, Order: "seq", Limit: 2000}); err != nil {
			continue
		}
		// A webhook gets its events in order: one at a time, and nothing
		// overtakes a delivery that is waiting to be retried.
		byHook := map[string][]core.WebhookDelivery{}
		for _, d := range pending {
			byHook[d.WebhookID] = append(byHook[d.WebhookID], d)
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
	status, errText, took := s.post(ctx, h, d.ID, evs[0])
	now := time.Now().UnixMilli()
	set := map[string]any{"status_code": status, "error": errText, "duration_ms": int(took.Milliseconds())}
	hookSet := map[string]any{"last_at": now}
	switch {
	case status >= 200 && status < 300:
		set["state"], set["done_at"] = "ok", now
		hookSet["failures"], hookSet["last_status"] = 0, fmt.Sprint(status)
	case d.Attempts >= maxAttempts:
		set["state"], set["done_at"] = "dead", now
		hookSet["failures"], hookSet["last_status"] = h.Failures+1, orText(errText, fmt.Sprint(status))
	default:
		set["next_at"] = now + backoff(d.Attempts).Milliseconds()
		hookSet["failures"], hookSet["last_status"] = h.Failures+1, orText(errText, fmt.Sprint(status))
	}
	db.Update(ctx, "webhook_deliveries", set, store.Eq("id", d.ID))
	db.Update(ctx, "webhooks", hookSet, store.Eq("id", h.ID))
	return set["state"] == "ok" || set["state"] == "dead"
}

func orText(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// post sends the request. The body carries the event as stored plus one
// line saying what happened, so a receiver can act without calling back.
func (s *Server) post(ctx context.Context, h core.Webhook, deliveryID string, ev core.Event) (status int, errText string, took time.Duration) {
	var ws core.Workspace
	s.st.Get(ctx, &ws, store.Eq("id", h.WorkspaceID))
	x := &c{s: s, r: (&http.Request{}).WithContext(ctx), ws: ws, db: s.st.In(ws.ID)}
	line := ""
	if nm, err := x.names(); err == nil {
		line = x.eventLine(ev, nm)
	}
	body, _ := json.Marshal(map[string]any{"delivery": deliveryID, "workspace": ws.Slug, "seq": ev.Seq, "type": ev.Type, "text": line, "event": ev,
		"url": s.cfg.BaseURL})
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
		return 0, oneLine(err.Error(), 300), took
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 300 {
		return resp.StatusCode, "answered " + resp.Status, took
	}
	return resp.StatusCode, "", took
}

// hRedeliver sends a delivery again, whatever became of it.
func (s *Server) hRedeliver(x *c) error {
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

// hWebhookTest posts a sample event to a webhook right now and returns what
// the receiver answered.
func (s *Server) hWebhookTest(x *c) error {
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
	status, errText, took := s.post(x.ctx(), h, did, ev)
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
	return x.ok(map[string]any{"status": status, "error": errText, "ms": took.Milliseconds(), "ok": status >= 200 && status < 300})
}

// ---- background jobs ----

// jobKinds maps a job kind to what runs it.
var jobKinds = map[string]func(s *Server, ctx context.Context, j core.Job) error{
	"notify": (*Server).jobNotify,
}

// enqueue adds a job. With a dedupe name, a second job of the same name is
// not added while the first still waits.
func (s *Server) enqueue(ctx context.Context, kind, workspaceID, dedupe string, payload any, runAt time.Time) {
	raw, _ := json.Marshal(payload)
	j := core.Job{ID: id.New(), Kind: kind, WorkspaceID: workspaceID, Dedupe: dedupe, Payload: raw, RunAt: runAt.UnixMilli(), CreatedAt: time.Now().UnixMilli()}
	if err := s.st.Insert(ctx, j); err != nil && !errors.Is(err, store.ErrConflict) {
		s.log.Error("enqueue", "kind", kind, "err", err)
	}
}

func (s *Server) runJobs(ctx context.Context) {
	worker := id.New()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		now := time.Now().UnixMilli()
		var due []core.Job
		if err := s.st.List(ctx, &due, store.Q{Where: []store.Cond{store.Null("done_at"), store.Lte("run_at", now)}, Order: "run_at", Limit: 20}); err != nil {
			continue
		}
		for _, j := range due {
			if j.ClaimedUntil > now {
				continue // another worker has it
			}
			// Claim it for five minutes; if this server dies, another takes over.
			n, err := s.st.Update(ctx, "jobs", map[string]any{"claimed_by": worker, "claimed_until": now + 300_000, "attempts": j.Attempts + 1},
				store.Eq("id", j.ID), store.Eq("attempts", j.Attempts), store.Null("done_at"))
			if err != nil || n != 1 {
				continue
			}
			run, ok := jobKinds[j.Kind]
			var jerr error
			if !ok {
				jerr = fmt.Errorf("unknown job kind %q", j.Kind)
			} else {
				jerr = run(s, ctx, j)
			}
			set := map[string]any{"claimed_until": 0}
			switch {
			case jerr == nil:
				set["done_at"], set["error"] = time.Now().UnixMilli(), ""
			case j.Attempts+1 >= 5 || !ok:
				set["done_at"], set["error"] = time.Now().UnixMilli(), oneLine(jerr.Error(), 500)
				s.log.Error("job gave up", "kind", j.Kind, "err", jerr)
			default:
				set["run_at"], set["error"] = time.Now().Add(backoff(j.Attempts+1)).UnixMilli(), oneLine(jerr.Error(), 500)
			}
			s.st.Update(ctx, "jobs", set, store.Eq("id", j.ID))
		}
		// Finished jobs are kept a week for the health panel, then dropped.
		s.st.Delete(ctx, "jobs", store.NotNull("done_at"), store.Lt("done_at", now-7*24*3600_000))
	}
}

// notifyPrefs are a person's choices about being told outside the app.
type notifyPrefs struct {
	Push  *bool  `json:"push"`  // default on, for browsers that subscribed
	Email string `json:"email"` // all, important (default), none
}

var importantNotes = map[string]bool{core.NoteAsked: true, core.NoteMentioned: true, core.NoteAssigned: true, core.NotePicked: true,
	core.NoteUnclear: true, core.NoteWaitingOn: true, core.NoteResult: true, core.NoteBudget: true}

var noteVerbs = map[string]string{core.NoteAssigned: "assigned you", core.NoteMentioned: "mentioned you in", core.NoteWaitingOn: "is waiting on you in",
	core.NoteAsked: "asked you a question in", core.NotePicked: "answered your question in", core.NoteUnclear: "found your answer unclear in",
	core.NoteReplied: "replied to you in", core.NoteComment: "commented on", core.NoteResult: "posted a result in", core.NoteStatus: "changed the status of",
	core.NoteBudget: "budget warning:"}

// jobNotify tells a person about an inbox item by push and mail, unless
// they have already read it.
func (s *Server) jobNotify(ctx context.Context, j core.Job) error {
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(j.Payload, &p)
	db := s.st.In(j.WorkspaceID)
	var n core.Notification
	if err := db.Get(ctx, &n, store.Eq("id", p.ID)); err != nil || n.ReadAt != 0 {
		return nil
	}
	var u core.User
	if err := s.st.Get(ctx, &u, store.Eq("id", n.UserID), store.Live); err != nil || u.Kind != core.KindPerson || u.DisabledAt != 0 {
		return nil // agents are woken through the feed and webhooks
	}
	var prefs notifyPrefs
	if len(u.Notify) > 0 {
		json.Unmarshal(u.Notify, &prefs)
	}
	var ws core.Workspace
	var actor core.Member
	s.st.Get(ctx, &ws, store.Eq("id", j.WorkspaceID))
	db.Get(ctx, &actor, store.Eq("user_id", n.ActorID))
	link := s.cfg.BaseURL + "/" + ws.Slug + "/inbox"
	if n.TaskID != "" {
		link = s.cfg.BaseURL + "/" + ws.Slug + "/task/" + strings.SplitN(n.Title, " ", 2)[0]
	} else if n.DocID != "" {
		link = s.cfg.BaseURL + "/" + ws.Slug + "/docs/" + n.DocID
	}
	title := strings.TrimSpace(actor.Name + " " + noteVerbs[n.Type] + " " + n.Title)
	if prefs.Push == nil || *prefs.Push {
		if _, err := s.pushTo(ctx, u.ID, pushMessage{Title: title, Body: n.Snippet, URL: strings.TrimPrefix(link, s.cfg.BaseURL), Tag: n.TaskID + n.DocID}); err != nil {
			s.log.Warn("push", "err", err)
		}
	}
	wantMail := prefs.Email == "all" || ((prefs.Email == "" || prefs.Email == "important") && importantNotes[n.Type])
	if wantMail && u.Email != "" && s.mailReady(ctx) {
		body := title
		if n.Snippet != "" {
			body += "\n\n" + n.Snippet
		}
		body += "\n\n" + link
		return s.sendMail(ctx, u.Email, title, body)
	}
	return nil
}
