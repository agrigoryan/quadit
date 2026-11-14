package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// feedParams are the feed's own URL parameters; any other parameter is a
// task filter, so the feed can be narrowed exactly like a task query.
var feedParams = []string{"after", "cursor", "ack", "wait", "limit", "types", "task", "doc", "mine", "others", "compact", "inbox"}

// events writes a list of events in the form asked for.
func (x *c) events(evs []core.Event, seq int64, more bool) error {
	if x.wantText() || truthyParam(x.r.URL.Query(), "compact") {
		nm, err := x.names()
		if err != nil {
			return err
		}
		ls := make([]string, len(evs))
		for i, ev := range evs {
			ls[i] = x.eventLine(ev, nm)
		}
		if x.wantText() {
			out := strings.Join(ls, "\n")
			if out != "" {
				out += "\n"
			}
			out += fmt.Sprintf("seq: %d", seq)
			if more {
				out += "  (more: ask again with after=" + strconv.FormatInt(seq, 10) + ")"
			}
			return x.text(out + "\n")
		}
		return x.ok(map[string]any{"events": ls, "seq": seq, "more": more})
	}
	if evs == nil {
		evs = []core.Event{}
	}
	return x.ok(map[string]any{"events": evs, "seq": seq, "more": more})
}

// hEvents reads the feed after a position. With wait=N the request is held
// for up to N seconds until something matching arrives, so an agent waits
// with one call instead of polling. With cursor=NAME the position is the one
// the server keeps for the caller; ack=SEQ moves it first.
func (s *Server) hEvents(x *c) error {
	ctx := x.ctx()
	v := x.r.URL.Query()
	f := store.EventFilter{Viewer: x.member.UserID, ProjectIDs: nil, Limit: min(x.intParam("limit", 200), 2000), Types: splitList(v.Get("types"))}
	cursor := v.Get("cursor")
	if cursor != "" {
		if ack := x.intParam("ack", 0); ack > 0 {
			if err := s.setCursor(x, cursor, int64(ack)); err != nil {
				return err
			}
		}
		var cu core.Cursor
		if err := x.db.Get(ctx, &cu, store.Eq("user_id", x.member.UserID), store.Eq("name", cursor)); err == nil {
			f.After = cu.Seq
		}
	}
	if v.Has("after") {
		f.After = int64(x.intParam("after", 0))
	}
	if truthyParam(v, "others") {
		f.NotActorID = x.member.UserID
	}
	if truthyParam(v, "inbox") {
		f.OnlyAudience = x.member.UserID
	}
	if ref := v.Get("task"); ref != "" {
		t, err := x.taskByRef(ref)
		if err != nil {
			return err
		}
		f.ScopeType, f.ScopeID = "task", t.ID
	}
	if ref := v.Get("doc"); ref != "" {
		d, err := x.docByID(ref)
		if err != nil {
			return err
		}
		f.ScopeType, f.ScopeID = "doc", d.ID
	}
	q, err := x.queryFromRequest(feedParams...)
	if err != nil {
		return err
	}
	if truthyParam(v, "mine") {
		q.Watching = true // tasks assigned to or mentioning the caller are watched
	}
	if q.Watching || len(v) > 0 && hasTaskFilter(q) {
		q.Archived = true
		tf, err := x.filter(q)
		if err != nil {
			return err
		}
		tf.Limit, tf.Sort = 0, ""
		f.Tasks = &tf
	} else if x.projects != nil {
		f.ProjectIDs = x.projects
	}
	wait := min(x.intParam("wait", 0), 55)
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	if wait > 0 {
		s.listening(x, wait+5)
	}
	opened, _ := s.access(x)
	for round := 0; ; round++ {
		if round > 0 {
			// The request has been held: before answering, check that the
			// caller may still see what it was opened to see.
			if now, ok := s.access(x); !ok {
				return errUnauthorized("your access ended while this request was waiting")
			} else if now != opened {
				return &httpError{Status: 409, Code: "access_changed", Message: "what you may see changed while this request was waiting; ask again"}
			}
		}
		var ws core.Workspace
		if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
			return err
		}
		evs, err := x.db.Events(ctx, f)
		if err != nil {
			return err
		}
		if len(evs) > 0 || wait == 0 || !time.Now().Before(deadline) {
			seq, more := max(ws.Seq, f.After), len(evs) == f.Limit
			if more {
				seq = evs[len(evs)-1].Seq
			} else if n := len(evs); n > 0 && evs[n-1].Seq > seq {
				seq = evs[n-1].Seq
			}
			return x.events(evs, seq, more)
		}
		// Nothing yet. Events up to ws.Seq did not match, so skip past them
		// and sleep until the feed moves.
		f.After = max(f.After, ws.Seq)
		wctx, cancel := context.WithDeadline(ctx, deadline)
		s.hub.Wait(wctx, x.ws.ID, ws.Seq)
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

// hasTaskFilter reports whether a query narrows tasks at all.
func hasTaskFilter(q TaskQuery) bool {
	raw, _ := json.Marshal(q)
	return string(raw) != "{}"
}

// listening marks a member as having something waiting on the feed, which
// is what "is this agent running?" shows.
func (s *Server) listening(x *c, seconds int) {
	until := time.Now().Add(time.Duration(seconds) * time.Second).UnixMilli()
	x.db.Update(context.WithoutCancel(x.ctx()), "members", map[string]any{"listening_until": until, "last_seen_at": time.Now().UnixMilli()},
		store.Eq("user_id", x.member.UserID))
}

// setCursor moves a cursor forward; a cursor never moves back.
func (s *Server) setCursor(x *c, name string, seq int64) error {
	if len(name) == 0 || len(name) > 64 {
		return errBad("a cursor name is 1 to 64 characters")
	}
	// Nothing can be handled that has not happened: a position past the end
	// of the feed would hide everything until the feed caught up with it.
	var ws core.Workspace
	if err := s.st.Get(x.ctx(), &ws, store.Eq("id", x.ws.ID)); err != nil {
		return err
	}
	if seq > ws.Seq {
		return &engine.Error{Code: engine.CodeInvalid, Field: "seq", Message: fmt.Sprintf("the feed is at %d; %d has not happened yet", ws.Seq, seq)}
	}
	var cur core.Cursor
	err := x.db.Get(x.ctx(), &cur, store.Eq("user_id", x.member.UserID), store.Eq("name", name))
	if err == nil && cur.Seq >= seq {
		return nil
	}
	return x.db.Upsert(x.ctx(), core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: name, Seq: seq, UpdatedAt: time.Now().UnixMilli()},
		"workspace_id", "user_id", "name")
}

func (s *Server) hCursorGet(x *c) error {
	var cu core.Cursor
	x.db.Get(x.ctx(), &cu, store.Eq("user_id", x.member.UserID), store.Eq("name", x.r.PathValue("name")))
	return x.ok(map[string]any{"name": x.r.PathValue("name"), "seq": cu.Seq})
}

// hCursorPut marks everything up to seq as handled.
func (s *Server) hCursorPut(x *c) error {
	var b struct {
		Seq int64 `json:"seq"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	if err := s.setCursor(x, x.r.PathValue("name"), b.Seq); err != nil {
		return err
	}
	return s.hCursorGet(x)
}

// hStream is the live stream: server-sent events, one per feed event, from
// a position. The web app keeps one open; an agent can too.
func (s *Server) hStream(x *c) error {
	flusher, ok := x.w.(http.Flusher)
	if !ok {
		return errBad("this connection cannot stream")
	}
	if x.sess != nil && x.sess.Stage == "render" {
		// The browser taking a picture must see the page settle; an open
		// stream would keep it waiting. "No content" tells it not to retry.
		x.w.WriteHeader(http.StatusNoContent)
		return nil
	}
	ctx := x.ctx()
	after := int64(x.intParam("after", 0))
	if last := x.r.Header.Get("Last-Event-ID"); last != "" {
		if n, err := strconv.ParseInt(last, 10, 64); err == nil {
			after = n
		}
	}
	h := x.w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // tell proxies not to hold the stream back
	x.w.WriteHeader(200)
	fmt.Fprintf(x.w, "retry: 2000\n\n")
	flusher.Flush()
	f := store.EventFilter{Viewer: x.member.UserID, ProjectIDs: x.projects, AllowNoProject: true, Limit: 500}
	beat := time.NewTicker(25 * time.Second)
	defer beat.Stop()
	opened, _ := s.access(x)
	for {
		// Before anything more goes out: may they still have it? Someone
		// removed, suspended or signed out is told to go; someone whose role
		// or projects changed is told to start over with what they may see now.
		switch now, ok := s.access(x); {
		case !ok:
			fmt.Fprintf(x.w, "event: gone\ndata: {}\n\n")
			flusher.Flush()
			return nil
		case now != opened:
			fmt.Fprintf(x.w, "event: reset\ndata: {}\n\n")
			flusher.Flush()
			return nil
		}
		// Note where the feed stands before reading it: whatever commits
		// after this moment has a higher number, and wakes the wait below.
		mark := s.hub.Seq(x.ws.ID)
		f.After = after
		evs, err := x.db.Events(ctx, f)
		if err != nil {
			return nil
		}
		if len(evs) == f.Limit && evs[len(evs)-1].Seq-after > 5000 {
			// Too far behind to replay: tell the client to start over.
			fmt.Fprintf(x.w, "event: reset\ndata: {}\n\n")
			flusher.Flush()
			return nil
		}
		for _, ev := range evs {
			raw, _ := json.Marshal(ev)
			fmt.Fprintf(x.w, "id: %d\ndata: %s\n\n", ev.Seq, raw)
			after = ev.Seq
		}
		if len(evs) > 0 {
			flusher.Flush()
			if len(evs) == f.Limit {
				continue
			}
		}
		if x.member.Kind == core.KindAgent {
			s.listening(x, 40)
		}
		woke := make(chan bool, 1)
		wctx, cancel := context.WithCancel(ctx)
		go func() { woke <- s.hub.Wait(wctx, x.ws.ID, max(after, mark)) }()
		select {
		case <-woke:
		case <-beat.C:
			fmt.Fprintf(x.w, ": beat\n\n")
			flusher.Flush()
		case <-ctx.Done():
			cancel()
			return nil
		}
		cancel()
	}
}

// access says whether the caller of a held connection may still be here,
// and a fingerprint of what they may see. A connection that stays open for
// minutes must not outlive the access it was opened with: it is asked again
// before anything more is sent on it.
func (s *Server) access(x *c) (fingerprint string, ok bool) {
	ctx := context.WithoutCancel(x.ctx())
	now := time.Now().UnixMilli()
	if x.token != nil {
		var t core.APIToken
		if err := s.st.Get(ctx, &t, store.Eq("id", x.token.ID), store.Null("revoked_at")); err != nil || (t.ExpiresAt != 0 && t.ExpiresAt < now) {
			return "", false
		}
	}
	if x.sess != nil {
		var se core.Session
		if err := s.st.Get(ctx, &se, store.Eq("id", x.sess.ID), store.Null("revoked_at")); err != nil || se.ExpiresAt < now {
			return "", false
		}
	}
	var u core.User
	if err := s.st.Get(ctx, &u, store.Eq("id", x.user.ID), store.Live); err != nil || u.DisabledAt != 0 {
		return "", false
	}
	if n, _ := s.st.Count(ctx, "workspaces", store.Eq("id", x.ws.ID), store.Live); n == 0 {
		return "", false // the workspace itself is gone
	}
	var m core.Member
	if err := x.db.Get(ctx, &m, store.Eq("user_id", x.user.ID), store.Null("removed_at")); err != nil || m.SuspendedAt != 0 {
		return "", false
	}
	scope, _ := json.Marshal(m.Scope)
	return string(m.Role) + " " + string(scope), true
}
