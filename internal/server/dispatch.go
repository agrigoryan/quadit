package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
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
		m.HandleFunc("POST /api/v1/w/{ws}/deliveries/{id}/redeliver", s.workspaceMember(s.handleResendDelivery))
		m.HandleFunc("POST /api/v1/w/{ws}/webhooks/{id}/test", s.workspaceMember(s.handleSendTestWebhook))
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
		// Webhooks mirror the feed, history too: its payload says quiet.
		for _, h := range hooks {
			if hookWants(h, ev) {
				if err := s.queueDelivery(ctx, db, h, ev); err != nil {
					return 0, err
				}
			}
		}
		if isNews(ev) {
			s.reactToNews(ctx, ws, db, ev, hooks, rules, viewWatchers)
		}
	}
	last := evs[len(evs)-1].Seq
	_, err = s.st.Update(ctx, "workspaces", map[string]any{"dispatched_seq": last}, store.Eq("id", ws.ID), store.Lt("dispatched_seq", last))
	return last, err
}

// isNews says whether an event is something happening now, which rules,
// watched views and wake-ups react to. History brought in quietly (an
// import) is not: it goes only to the feed, the search, local copies and
// webhooks. This is the one place that tells the two apart.
func isNews(ev core.Event) bool {
	var d struct {
		Quiet bool `json:"quiet"`
	}
	json.Unmarshal(ev.Data, &d)
	return !d.Quiet
}

// reactToNews does what one event of news sets off: alerts for the saved
// views it brings a task into, the rules it matches, and a wake-up (push or
// mail) for an inbox item.
func (s *Server) reactToNews(ctx context.Context, ws core.Workspace, db store.DB, ev core.Event, hooks []core.Webhook, rules []core.Rule, viewWatchers []core.Watcher) {
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
