// The feed: reading it after a position (GET /events, which can wait for
// what comes next), the live stream, and the cursors that remember where a
// reader stands.

package server

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// feedParams are the feed's own URL parameters; any other parameter is a
// task filter, so the feed can be narrowed exactly like a task query.
var feedParams = []string{"after", "cursor", "ack", "wait", "limit", "types", "task", "doc", "mine", "others", "compact", "inbox"}

// eventPage is one answer of the feed: the events, the position to read on
// from, and whether more are already there.
type eventPage struct {
	events []core.Event
	seq    int64
	more   bool
}

// events writes a page of events in the form asked for: rows, or one line
// each (compact=1), or text.
func (x *c) events(page eventPage) error {
	if !x.wantText() && !truthyParam(x.r.URL.Query(), "compact") {
		evs := page.events
		if evs == nil {
			evs = []core.Event{}
		}
		return x.ok(map[string]any{"events": evs, "seq": page.seq, "more": page.more})
	}
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	eventLines := make([]string, len(page.events))
	for i, ev := range page.events {
		eventLines[i] = x.eventLine(x.ctx(), ev, names)
	}
	if !x.wantText() {
		return x.ok(map[string]any{"events": eventLines, "seq": page.seq, "more": page.more})
	}
	out := strings.Join(eventLines, "\n")
	if out != "" {
		out += "\n"
	}
	out += fmt.Sprintf("seq: %d", page.seq)
	if page.more {
		out += "  (more: ask again with after=" + strconv.FormatInt(page.seq, 10) + ")"
	}
	return x.text(out + "\n")
}

// handleReadFeed reads the feed after a position. With wait=N the request is held
// for up to N seconds until something matching arrives, so an agent waits
// with one call instead of polling. With cursor=NAME the position is the one
// the server keeps for the caller; ack=SEQ moves it first.
//
// It first sets the filter from the request (the position; others=, inbox=,
// task=, doc=; any task filter, or mine=), then reads in rounds: each round
// checks the caller's access is unchanged, reads, and answers when there is
// something, when it was not asked to wait, or when the wait is over;
// otherwise it sleeps until the feed moves.
func (s *Server) handleReadFeed(x *c) error {
	ctx := x.ctx()
	v := x.r.URL.Query()
	f := x.feed()
	f.Limit, f.Types = min(x.intParam("limit", defaultFeedPage), maxFeedPage), splitList(v.Get("types"))
	cursor := v.Get("cursor")
	if cursor != "" {
		if ack := x.intParam("ack", 0); ack > 0 {
			if err := s.setCursor(x, cursor, int64(ack)); err != nil {
				return err
			}
		}
		// A cursor not moved yet stands at the start.
		var saved core.Cursor
		if _, err := store.Find(ctx, x.db, &saved, store.Eq("user_id", x.member.UserID), store.Eq("name", cursor)); err != nil {
			return err
		}
		f.After = saved.Seq
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
		t, err := x.taskByRef(x.ctx(), ref)
		if err != nil {
			return err
		}
		f.ScopeType, f.ScopeID = "task", t.ID
	}
	if ref := v.Get("doc"); ref != "" {
		d, err := x.docByID(x.ctx(), ref)
		if err != nil {
			return err
		}
		f.ScopeType, f.ScopeID = "doc", d.ID
	}
	// Any task filter narrows the feed to the events of those tasks.
	query, err := x.queryFromRequest(feedParams...)
	if err != nil {
		return err
	}
	if truthyParam(v, "mine") {
		query.Watching = true // tasks assigned to or mentioning the caller are watched
	}
	if query.Watching || len(v) > 0 && hasTaskFilter(query) {
		query.Archived = true
		tf, _, err := x.taskFilter(x.ctx(), query)
		if err != nil {
			return err
		}
		tf.Limit, tf.Sort = 0, ""
		// The tasks are kept to the caller's projects by their own filter,
		// and the events are those of the tasks, whatever project each
		// was written in.
		f.Tasks, f.ProjectIDs = &tf, nil
	}
	// The rounds.
	wait := min(x.intParam("wait", 0), maxFeedWait)
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	if wait > 0 {
		s.listening(x, wait+5)
	}
	opened, _ := s.recheckAccess(x)
	for round := 0; ; round++ {
		if round > 0 {
			// The request has been held: before answering, check that the
			// caller may still see what it was opened to see.
			if now, ok := s.recheckAccess(x); !ok {
				return errUnauthorized("your access ended while this request was waiting")
			} else if now != opened {
				return &httpError{Status: http.StatusConflict, Code: "access_changed", Message: "what you may see changed while this request was waiting; ask again"}
			}
		}
		var ws core.Workspace
		if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
			return err
		}
		if round == 0 && v.Has("after") && f.After > ws.Seq {
			return &engine.Error{Code: engine.CodeInvalid, Field: "after", Message: fmt.Sprintf("after=%d is past the end of the feed, which stands at %d; read from there, or from 0 for everything", f.After, ws.Seq)}
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
			return x.events(eventPage{events: evs, seq: seq, more: more})
		}
		// Nothing yet. Events up to ws.Seq did not match, so skip past them
		// and sleep until the feed moves.
		f.After = max(f.After, ws.Seq)
		wctx, cancel := context.WithDeadline(ctx, deadline)
		hctx, release := s.keptOpenContext(wctx)
		s.hub.Wait(hctx, x.ws.ID, ws.Seq)
		release()
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case <-s.quit:
			deadline = time.Now() // the server is stopping: answer with what there is
		default:
		}
	}
}

// The feed gives defaultFeedPage events unless limit= says otherwise, and
// never more than maxFeedPage; a request waits maxFeedWait seconds at most.
const (
	defaultFeedPage = 200
	maxFeedPage     = 2000
	maxFeedWait     = 55
)

// hasTaskFilter reports whether a query narrows tasks at all.
func hasTaskFilter(q core.TaskQuery) bool {
	raw := plainjson.Marshal(q)
	return string(raw) != "{}"
}

// listening marks a member as having something waiting on the feed, which
// is what "is this agent running?" shows. It is best effort: a sign of life
// that is written again on the next wait, so a failed write is only logged.
func (s *Server) listening(x *c, seconds int) {
	until := time.Now().Add(time.Duration(seconds) * time.Second).UnixMilli()
	set := map[string]any{"listening_until": until, "last_seen_at": time.Now().UnixMilli()}
	if _, err := x.db.Update(context.WithoutCancel(x.ctx()), "members", set, store.Eq("user_id", x.member.UserID)); err != nil {
		s.log.Warn("listening not noted", "member", x.member.UserID, "err", err)
	}
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
	if seq < 0 {
		return &engine.Error{Code: engine.CodeInvalid, Field: "seq", Message: "a feed position is zero or more"}
	}
	if seq > ws.Seq {
		return &engine.Error{Code: engine.CodeInvalid, Field: "seq", Message: fmt.Sprintf("the feed is at %d; %d has not happened yet", ws.Seq, seq)}
	}
	var cur core.Cursor
	there, err := store.Find(x.ctx(), x.db, &cur, store.Eq("user_id", x.member.UserID), store.Eq("name", name))
	if err != nil {
		return err
	}
	if there && cur.Seq >= seq {
		return nil
	}
	return x.db.Upsert(x.ctx(), core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: name, Seq: seq, UpdatedAt: time.Now().UnixMilli()},
		"workspace_id", "user_id", "name")
}

// handleShowFeedCursor says where one of the caller's cursors stands; one
// never moved stands at 0.
func (s *Server) handleShowFeedCursor(x *c) error {
	var cursor core.Cursor
	if _, err := store.Find(x.ctx(), x.db, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", x.r.PathValue("name"))); err != nil {
		return err
	}
	return x.ok(map[string]any{"name": x.r.PathValue("name"), "seq": cursor.Seq})
}

// handleMoveFeedCursor marks everything up to seq as handled.
func (s *Server) handleMoveFeedCursor(x *c) error {
	var body struct {
		Seq int64 `json:"seq"`
	}
	if err := x.body(&body); err != nil {
		return err
	}
	if err := s.setCursor(x, x.r.PathValue("name"), body.Seq); err != nil {
		return err
	}
	return s.handleShowFeedCursor(x)
}

// handleStreamFeed is the live stream: server-sent events, one per feed event, from
// a position. The web app keeps one open; an agent can too.
//
// After the headers it loops: check the caller may still be here (and end
// the stream with "gone" or "reset" if not), read what is new, send it, and
// wait for the feed to move or for the heartbeat.
func (s *Server) handleStreamFeed(x *c) error {
	flusher, ok := x.w.(http.Flusher)
	if !ok {
		return errBad("this connection cannot stream")
	}
	if x.sess != nil && x.sess.Stage == core.SessionRender {
		// The browser taking a picture must see the page settle; an open
		// stream would keep it waiting. "No content" tells it not to retry.
		x.w.WriteHeader(http.StatusNoContent)
		return nil
	}
	ctx, release := s.keptOpenContext(x.ctx())
	defer release()
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
	x.w.WriteHeader(http.StatusOK)
	fmt.Fprintf(x.w, "retry: 2000\n\n")
	flusher.Flush()
	f := x.feed()
	f.Limit = streamBatch
	beat := time.NewTicker(streamBeat)
	defer beat.Stop()
	opened, _ := s.recheckAccess(x)
	for {
		// Counted before the check: a change of access that lands right
		// after it is then seen by the read and the wait below, not missed.
		pokes := s.hub.Pokes(x.ws.ID)
		// Before anything more goes out: may they still have it? Someone
		// removed, suspended or signed out is told to go; someone whose role
		// or projects changed is told to start over with what they may see now.
		switch now, ok := s.recheckAccess(x); {
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
			// The headers are sent: the error cannot be the answer. The
			// client reconnects and reads on from its last event.
			if ctx.Err() == nil {
				s.log.Warn("live stream ended on a failed read", "err", err)
			}
			return nil
		}
		if len(evs) > 0 {
			// What was read may have been written after the check above,
			// and after the caller lost the right to it: check once more
			// before any of it is sent.
			if now, ok := s.recheckAccess(x); !ok || now != opened {
				continue // the top of the loop says how it ends
			}
		}
		if len(evs) == f.Limit && evs[len(evs)-1].Seq-after > streamReplay {
			// Too far behind to replay: tell the client to start over.
			fmt.Fprintf(x.w, "event: reset\ndata: {}\n\n")
			flusher.Flush()
			return nil
		}
		for _, ev := range evs {
			raw := plainjson.Marshal(ev)
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
			s.listening(x, streamListening)
		}
		woke := make(chan bool, 1)
		wctx, cancel := context.WithCancel(ctx)
		go func() { woke <- s.hub.WaitSince(wctx, x.ws.ID, max(after, mark), pokes) }()
		select {
		case <-woke:
		case <-beat.C:
			// Both a comment and a named event: the second is what a browser's
			// own EventSource lets a page see, to tell a live stream from a dead one.
			fmt.Fprintf(x.w, ": beat\n\nevent: beat\ndata: {}\n\n")
			flusher.Flush()
		case <-ctx.Done():
			cancel()
			return nil
		}
		cancel()
	}
}

// The live stream sends streamBatch events at a time, a heartbeat every
// streamBeat, and tells a client more than streamReplay events behind to
// start over. An agent with a stream open counts as listening for
// streamListening seconds at a time.
const (
	streamBatch     = 500
	streamBeat      = 25 * time.Second
	streamReplay    = 5000
	streamListening = 40
)

// recheckAccess says whether the caller of a held connection may still be here,
// and a fingerprint of what they may see. A connection that stays open for
// minutes must not outlive the access it was opened with: it is asked again
// before anything more is sent on it. Access fails closed: a read that fails
// counts as access ended.
func (s *Server) recheckAccess(x *c) (fingerprint string, ok bool) {
	ctx := context.WithoutCancel(x.ctx())
	now := time.Now().UnixMilli()
	if x.token != nil {
		var t core.APIToken
		if err := s.st.Get(ctx, &t, store.Eq("id", x.token.ID), store.Null("revoked_at")); err != nil || (t.ExpiresAt != 0 && t.ExpiresAt < now) {
			return "", false
		}
	}
	if x.sess != nil {
		var session core.Session
		if err := s.st.Get(ctx, &session, store.Eq("id", x.sess.ID), store.Null("revoked_at")); err != nil || session.ExpiresAt < now {
			return "", false
		}
	}
	var user core.User
	if err := s.st.Get(ctx, &user, store.Eq("id", x.user.ID), store.Live); err != nil || user.DisabledAt != 0 {
		return "", false
	}
	if n, err := s.st.Count(ctx, "workspaces", store.Eq("id", x.ws.ID), store.Live); err != nil || n == 0 {
		return "", false // the workspace itself is gone
	}
	var member core.Member
	if err := x.db.Get(ctx, &member, store.Eq("user_id", x.user.ID), store.Null("removed_at")); err != nil || member.SuspendedAt != 0 {
		return "", false
	}
	scope := plainjson.Marshal(member.Scope)
	return string(member.Role) + " " + string(scope), true
}

// accessChanged wakes every held connection, on this server and the others,
// to ask again whether its caller may still be here: a session was ended, a
// token revoked, an account disabled.
func (s *Server) accessChanged() {
	s.hub.PokeAll()
	if poker, ok := s.st.(interface{ Poke(context.Context) error }); ok {
		// Detached: the change that ended the access is done, and no request
		// waits on this. Best effort: a held connection on another server
		// still asks again before it sends anything.
		if err := poker.Poke(context.Background()); err != nil {
			s.log.Warn("other servers not woken", "err", err)
		}
	}
}
