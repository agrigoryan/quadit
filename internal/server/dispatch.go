package server

import (
	"context"
	"errors"
	"fmt"
	"slices"
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

// webhookRoutes are the routes that send a webhook delivery by hand.
func (s *Server) webhookRoutes() []route {
	return []route{
		{"POST /api/v1/w/{ws}/deliveries/{id}/redeliver", s.workspaceMember(s.handleResendDelivery), "Send a webhook delivery again. Admins.", "", "admin"},
		{"POST /api/v1/w/{ws}/webhooks/{id}/test", s.workspaceMember(s.handleSendTestWebhook), "Send a sample event to a webhook now and answer with what it said. Admins.", "", "admin"},
	}
}

// Timing and size of the dispatcher's passes.
const (
	dispatchTick  = 5 * time.Second // a pass at least this often, and on every write
	dispatchBatch = 300             // events handled per batch
	notifyDelay   = 20 * time.Second
)

// runDispatcher turns new events into wake-ups until ctx ends.
func (s *Server) runDispatcher(ctx context.Context) {
	tick := time.NewTicker(dispatchTick)
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

// dispatchAll brings every workspace's dispatched position up to its last event.
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
	evs, err := db.Events(ctx, store.EventFilter{After: ws.DispatchedSeq, Limit: dispatchBatch})
	if err != nil || len(evs) == 0 {
		return ws.DispatchedSeq, err
	}
	l := listeners{ws: ws, db: db}
	if err := db.List(ctx, &l.hooks, store.Where(store.Live, store.Eq("active", true))); err != nil {
		return 0, err
	}
	if err := db.List(ctx, &l.rules, store.Where(store.Live, store.Eq("active", true))); err != nil {
		return 0, err
	}
	if err := db.List(ctx, &l.viewWatchers, store.Where(store.Eq("subject_type", "view"))); err != nil {
		return 0, err
	}
	// Webhooks mirror the feed, history too: its payload says quiet. The
	// batch's deliveries are queued in one write: one each would be a
	// commit for every event a webhook wants, which on a slow disk holds
	// every later event, and every other webhook, behind a busy one.
	if err := s.st.Atomic(ctx, func(tx store.DB) error {
		for _, ev := range evs {
			for _, h := range l.hooks {
				if hookWants(h, ev) {
					if err := s.queueDelivery(ctx, tx, h, ev); err != nil {
						return err
					}
				}
			}
		}
		return nil
	}); err != nil {
		return 0, err
	}
	for _, ev := range evs {
		if isNews(ev) {
			if err := s.reactToNews(ctx, l, ev); err != nil {
				return 0, err
			}
		}
	}
	last := evs[len(evs)-1].Seq
	_, err = s.st.Update(ctx, "workspaces", map[string]any{"dispatched_seq": last}, store.Eq("id", ws.ID), store.Lt("dispatched_seq", last))
	return last, err
}

// listeners is what in one workspace reacts to its events, read once for
// a batch of them.
type listeners struct {
	ws           core.Workspace
	db           store.DB
	hooks        []core.Webhook
	rules        []core.Rule
	viewWatchers []core.Watcher // saved views someone watches: a task that comes into one is news for them
}

// isNews says whether an event is something happening now, which rules,
// watched views and wake-ups react to. History brought in quietly (an
// import) is not: it goes only to the feed, the search, local copies and
// webhooks. This is the one place that tells the two apart.
func isNews(ev core.Event) bool {
	d, _ := ev.Payload() // data that does not read says nothing of being quiet
	return !d.Quiet
}

// reactToNews does what one event of news sets off: alerts for the saved
// views it brings a task into, the rules it matches, and a wake-up (push or
// mail) for an inbox item. A view or a rule that fails is logged and
// skipped; a wake-up that cannot be queued is the error, so the dispatcher
// stays where it is and tries the event again.
func (s *Server) reactToNews(ctx context.Context, l listeners, ev core.Event) error {
	ws := l.ws
	if len(l.viewWatchers) > 0 && ev.AudienceID == "" && ev.ScopeType == "task" && (ev.Type == "task.created" || ev.Type == "task.updated") {
		for _, vw := range l.viewWatchers {
			if vw.UserID == ev.ActorID {
				continue
			}
			if err := s.viewNews(ctx, ws, vw, ev); err != nil {
				s.log.Error("watched view", "view", vw.SubjectID, "seq", ev.Seq, "err", err)
			}
		}
	}
	d, _ := ev.Payload() // data that does not read names no rule and no inbox item
	if len(l.rules) > 0 && ev.AudienceID == "" && d.Rule == "" {
		for _, r := range l.rules {
			if err := s.runRule(ctx, l, r, ev); err != nil {
				s.log.Error("rule", "rule", r.Name, "seq", ev.Seq, "err", err)
			}
		}
	}
	var n core.Notification
	if ev.Type == "notification.created" && d.ReadRow(&n) && n.ID != "" {
		// Give the person a moment to see it in an open window first.
		return s.enqueue(ctx, "notify", ws.ID, "notify:"+n.ID, map[string]string{"id": n.ID}, time.Now().Add(notifyDelay))
	}
	return nil
}

// viewNews tells the watcher of a saved view when a change leaves a task in
// that view. A task is announced once a day at most, however often it moves.
// A view or a watcher that is gone, or a view whose query no longer reads,
// has nothing to tell.
func (s *Server) viewNews(ctx context.Context, ws core.Workspace, vw core.Watcher, ev core.Event) error {
	db := s.st.In(ws.ID)
	var view core.View
	var m core.Member
	if there, err := store.Find(ctx, db, &view, store.Eq("id", vw.SubjectID), store.Live); err != nil || !there {
		return err
	}
	if there, err := store.Find(ctx, db, &m, store.Eq("user_id", vw.UserID), store.Null("removed_at")); err != nil || !there {
		return err
	}
	// Read as it is opened: what it names that is gone is left out.
	q, err := view.TaskQuery()
	if err != nil {
		return nil //nolint:nilerr // a view whose query does not read has nothing to watch
	}
	// Run the view's query as the watcher, narrowed to this one task.
	f, _, err := s.viewerFor(ws, m).taskFilter(ctx, q)
	if _, refused := errors.AsType[*engine.Error](err); refused {
		return nil // the view cannot be run for the watcher (it names what they may not reach): nothing to watch
	}
	if err != nil {
		return err
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
// webhook gets the public events it asked for. Either way only those after
// the webhook was made: the dispatcher may reach earlier ones only once it
// is there.
func hookWants(h core.Webhook, ev core.Event) bool {
	if ev.Seq <= h.CreatedSeq {
		return false
	}
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

// runRule applies one rule to one event if it matches. A rule acts only on
// what happens after it was made, though the dispatcher may reach earlier
// events only once it is there.
func (s *Server) runRule(ctx context.Context, l listeners, r core.Rule, ev core.Event) error {
	if r.Action == nil || ev.Seq <= r.CreatedSeq {
		return nil
	}
	if ok, err := ruleMatches(ctx, l.db, r.Match, ev); err != nil || !ok {
		return err
	}
	taskID := ""
	if ev.ScopeType == "task" {
		taskID = ev.ScopeID
	}
	if r.Action.Kind == core.RuleWebhook {
		for _, h := range l.hooks {
			if h.ID == r.Action.WebhookID {
				return s.queueDelivery(ctx, l.db, h, ev)
			}
		}
		return nil
	}
	return s.ruleAct(ctx, l.ws, r, taskID, ev)
}

// ruleMatches reports whether an event is one a rule's match describes. A
// match with nothing set takes every event. A row a condition names that is
// gone does not match; a read that fails is an error.
func ruleMatches(ctx context.Context, db store.DB, m *core.RuleMatch, ev core.Event) (bool, error) {
	if m == nil {
		m = &core.RuleMatch{}
	}
	if !typeMatches(m.EventTypes, ev.Type) || (m.ProjectID != "" && m.ProjectID != ev.ProjectID) || (m.ActorID != "" && m.ActorID != ev.ActorID) {
		return false, nil
	}
	d, _ := ev.Payload() // data that does not read matches no condition on it
	if m.ActorKind != "" {
		var actor core.Member
		if there, err := store.Find(ctx, db, &actor, store.Eq("user_id", ev.ActorID)); err != nil || !there || actor.Kind != m.ActorKind {
			return false, err
		}
	}
	if m.Outcome != "" && decisionOutcome(d) != m.Outcome {
		return false, nil
	}
	if m.ToCategory != "" {
		to, _ := d.Changes["status_id"].To.(string)
		if to == "" {
			return false, nil
		}
		var status core.Status
		if there, err := store.Find(ctx, db, &status, store.Eq("id", to)); err != nil || !there || status.Category != m.ToCategory {
			return false, err
		}
	}
	if m.LabelID != "" {
		if ev.ScopeType != "task" {
			return false, nil
		}
		var t core.Task
		if there, err := store.Find(ctx, db, &t, store.Eq("id", ev.ScopeID)); err != nil || !there || !slices.Contains(t.LabelIDs, m.LabelID) {
			return false, err
		}
	}
	return true, nil
}

// decisionOutcome is the outcome of the decision in an event's row, or ""
// when the row is not one that reads.
func decisionOutcome(d core.EventData) string {
	var dc core.Decision
	if !d.ReadRow(&dc) {
		return ""
	}
	return dc.Outcome
}

// ruleAct does what a rule says, as the one who made it. The id is made
// from the rule and the event, so running the same event through twice
// acts once.
func (s *Server) ruleAct(ctx context.Context, ws core.Workspace, r core.Rule, taskID string, ev core.Event) error {
	a := r.Action
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
		case core.RuleNotify:
			args := map[string]any{"user": a.UserID, "message": msg}
			if taskID != "" {
				args["task"] = taskID
			}
			return sys.Do("notify", args)
		case core.RuleAssign:
			if taskID == "" {
				return nil
			}
			return sys.Do("task.update", map[string]any{"id": taskID, "assignee": a.UserID})
		case core.RuleWaitOn:
			if taskID == "" {
				return nil
			}
			return sys.Do("task.update", map[string]any{"id": taskID, "waiting_on": a.UserID, "waiting_on_note": msg})
		}
		return nil
	})
}
