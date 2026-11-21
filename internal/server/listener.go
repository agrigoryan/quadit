// The listener: the one session at a time that delivers an agent's inbox,
// by holding the agent's lease. `quadit wait` and `quadit listen` read the
// next item through GET /listen, which alone takes the lease; the cursor it
// delivers from ("listen", core.ListenCursor, unless another is named) is
// moved by an acknowledgment, held to the lease when it gives one. While
// the lease lives the agent counts as listening.
//
// A `quadit listen` from before the lease reads GET /events?cursor=listen
// and acknowledges with no lease: it takes none, is refused nothing, and
// counts as listening while its wait is held (markOldListener).

package server

import (
	"context"
	"fmt"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// A lease lives leaseLife past the end of its holder's last wait that
// answered, so the agent does not stop counting as listening while it
// handles an item; a wait its client gave up on (the agent was stopped)
// leaves it abandonedLife, for a tool that runs the command again. Its id
// is leaseLength characters of codeAlphabet, short enough to copy into a
// command. A cursor never moved starts at the oldest unread item of the
// last firstLook, else at the present.
const (
	leaseLife     = 5 * time.Minute
	abandonedLife = 30 * time.Second
	leaseLength   = 8
	firstLook     = 24 * time.Hour
)

// Why a session was refused (engine.Error.Reason).
const (
	// reasonListeningElsewhere: another session holds the live lease.
	reasonListeningElsewhere = "listening_elsewhere"
	// reasonLeaseStale: the lease given was taken over since.
	reasonLeaseStale = "lease_stale"
	// reasonLeaseEnded: the lease given ran out with nobody waiting; a wait
	// takes a new one, and what was not acknowledged comes again.
	reasonLeaseEnded = "lease_ended"
)

// listenerRoutes are the routes of the listener.
func (s *Server) listenerRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/listen", s.workspaceMember(s.handleNextInboxItem), "The listener's read: the next item of the caller's inbox after its cursor (listen, or the one named), waiting for one up to wait seconds (at most 55). It holds the agent's listener lease: the first call takes it, and each call after gives its id as lease=; while it lives (five minutes past the end of the last wait) another session is refused (reason listening_elsewhere) unless it asks with take=1, and the agent counts as listening. Answers {lease} when the wait ended with nothing, or {lease, seq, item, line} (line: the item as the feed writes it). Nothing moves the cursor but an acknowledgment with the lease: PUT cursors/{name} {seq, lease}. An agent's login only.", "wait: seconds, up to 55; lease: the id the last call answered with; take: true to take the lease from the session that holds it; cursor: the cursor to deliver from (listen)", "follow"},
	}
}

// handleNextInboxItem answers the listener's next inbox item, holding the
// lease while it waits. An item is handed over only if the lease is still
// this session's when it comes: one taken over meanwhile is refused here,
// so the two sessions never both deliver it. However the wait ends, the
// lease's life is set by how (endWait).
func (s *Server) handleNextInboxItem(x *c) error {
	// An agent listening with a person's login (the computer's own, when its
	// tool did not get the agent's) would answer as that person.
	if x.member.Kind != core.KindAgent {
		return errForbidden("this login is @%s's, a person's, not an agent's: an agent listens with its own login", x.member.Handle)
	}
	v := x.r.URL.Query()
	name := v.Get("cursor")
	if name == "" {
		name = core.ListenCursor
	}
	if len(name) > 64 {
		return errBad("a cursor name is 1 to 64 characters")
	}
	wait := min(x.intParam("wait", 0), maxFeedWait)
	lease, taken, err := s.holdLease(x, v.Get("lease"), truthyParam(v, "take"), time.Duration(wait)*time.Second)
	if err != nil {
		return err
	}
	answered := false
	defer func() { s.endWait(x, lease, taken, answered) }()
	start, skipped, err := s.listenStart(x, name)
	if err != nil {
		return err
	}
	f := x.feed()
	f.After, f.OnlyAudience, f.Types, f.Limit = start, x.member.UserID, []string{"notification.created"}, 1
	page, err := s.waitForEvents(x, f, wait, false)
	if err != nil {
		return err
	}
	out := map[string]any{"lease": lease}
	if skipped > 0 {
		out["skipped"] = skipped
	}
	if len(page.events) == 0 {
		answered = true
		return x.ok(out)
	}
	// The wait may have slept through a takeover: the item is this
	// session's only if the lease still is, as the write that took it
	// over would have seen.
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		var m core.Member
		if err := tx.Get(x.ctx(), &m, store.Eq("user_id", x.member.UserID)); err != nil {
			return err
		}
		if m.ListenLease != lease {
			return listeningElsewhere(m)
		}
		return nil
	})
	if err != nil {
		return err
	}
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	var note core.Notification
	ev := page.events[0]
	if data, err := ev.Payload(); err == nil {
		data.ReadRow(&note)
	}
	note.Seq = ev.Seq
	out["seq"], out["item"], out["line"] = ev.Seq, x.inboxItem(x.ctx(), note, names), x.eventLine(x.ctx(), ev, names)
	answered = true
	return x.ok(out)
}

// listenStart is where the listener reads on from in cursor name, and how
// many unread items it leaves behind the first time. A cursor never moved
// is set, once, to just before the oldest unread inbox item of the last
// firstLook (the comment written a minute before the person said "listen"
// is handled), else to the present (weeks of history are not replayed);
// the unread items before it are counted, for the agent to say where they
// are.
func (s *Server) listenStart(x *c, name string) (start int64, skipped int, err error) {
	ctx := x.ctx()
	var cursor core.Cursor
	there, err := store.Find(ctx, x.db, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", name))
	if err != nil || there {
		return cursor.Seq, 0, err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return 0, 0, err
	}
	unread := []store.Cond{store.Null("read_at"), store.Null("archived_at")}
	recent, err := x.ownNotes(ctx, append(unread, store.Gte("created_at", time.Now().Add(-firstLook).UnixMilli())), 0)
	if err != nil {
		return 0, 0, err
	}
	start = ws.Seq
	if n := len(recent); n > 0 {
		start = recent[n-1].Seq - 1 // newest first: the last is the oldest
	}
	older, err := x.ownNotes(ctx, append(unread, store.Lte("seq", start)), 0)
	if err != nil {
		return 0, 0, err
	}
	err = x.db.Advance(ctx, core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: name, Seq: start, UpdatedAt: time.Now().UnixMilli()},
		"seq", "workspace_id", "user_id", "name")
	return start, len(older), err
}

// holdLease gives the caller's listener the lease for a wait of the length
// given, and returns its id and whether it is new (its holder does not know
// it yet): the lease given is renewed while it lives, and a new one is
// taken when none lives or, with take, from the session that holds it.
// Another session's live lease refuses the wait. Taking a lease proves an
// agent reached Quadit.
func (s *Server) holdLease(x *c, given string, take bool, wait time.Duration) (lease string, taken bool, err error) {
	now := time.Now()
	lease = given
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		var m core.Member
		if err := tx.Get(x.ctx(), &m, store.Eq("user_id", x.member.UserID)); err != nil {
			return err
		}
		live := leaseLives(m, now)
		switch {
		case live && given == m.ListenLease:
		case live && !take:
			return listeningElsewhere(m)
		case given == "" || given != m.ListenLease:
			lease, taken = randomCode(leaseLength), true
		}
		_, err := tx.Update(x.ctx(), "members", map[string]any{"listen_lease": lease, "listening_until": now.Add(wait + leaseLife).UnixMilli(), "listen_heard_at": now.UnixMilli()},
			store.Eq("user_id", m.UserID))
		return err
	})
	if err != nil {
		return "", false, err
	}
	if x.member.ConnectedAt == 0 {
		if err := s.eng.System(x.ctx(), x.ws.ID, x.member.UserID, func(sys *engine.Sys) error { return sys.Connected() }); err != nil {
			return "", false, err
		}
	}
	return lease, taken, nil
}

// endWait sets the lease's life when its holder's wait ends: leaseLife
// after a wait that answered; nothing left of a lease taken by a wait that
// did not answer, since its id never reached anyone; abandonedLife after a
// wait the client gave up on, or that failed. It is best effort: the lease
// then ends when the wait was to end, plus leaseLife, later than it should.
func (s *Server) endWait(x *c, lease string, taken, answered bool) {
	now := time.Now()
	set := map[string]any{"listening_until": now.Add(abandonedLife).UnixMilli()}
	switch {
	case answered:
		set["listening_until"] = now.Add(leaseLife).UnixMilli()
	case taken:
		set = map[string]any{"listening_until": nil, "listen_lease": nil}
	}
	if _, err := x.db.Update(context.WithoutCancel(x.ctx()), "members", set, store.Eq("user_id", x.member.UserID), store.Eq("listen_lease", lease)); err != nil {
		s.log.Warn("the end of a wait was not noted on the listener's lease", "member", x.member.UserID, "err", err)
	}
}

// markOldListener counts the caller as listening while a wait on the feed
// with the cursor "listen" is held, as a `quadit listen` from before the
// lease waits, unless a listener holds a live lease: then it already does.
// It takes no lease, and clears one that ran out, so that one cannot come
// back to life. Best effort, like the sign of life it is.
func (s *Server) markOldListener(x *c, wait time.Duration) {
	now := time.Now()
	if _, err := x.db.Update(context.WithoutCancel(x.ctx()), "members", map[string]any{"listening_until": now.Add(wait + oldListenerSlack).UnixMilli(), "listen_lease": nil},
		store.Eq("user_id", x.member.UserID), store.Either(store.Null("listen_lease"), store.Null("listening_until"), store.Lte("listening_until", now.UnixMilli()))); err != nil {
		s.log.Warn("listening not noted", "member", x.member.UserID, "err", err)
	}
}

// oldListenerSlack is how long past its wait a `quadit listen` from before
// the lease still counts as listening: the moment between two waits.
const oldListenerSlack = 5 * time.Second

// leaseLives reports whether m's listener lease lives at now.
func leaseLives(m core.Member, now time.Time) bool {
	return m.ListenLease != "" && m.ListeningUntil > now.UnixMilli()
}

// leaseLets refuses a move of a cursor, made with lease given, by a session
// that does not hold m's live lease: one that gives a lease taken over
// since, or one that ran out. A move that gives no lease is let through,
// as it always was: a `quadit listen` from before the lease acknowledges
// so, and so does a person giving up on an item by hand.
func leaseLets(m core.Member, given string, now time.Time) error {
	switch {
	case given == "":
		return nil
	case given != m.ListenLease:
		return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonLeaseStale,
			Message: fmt.Sprintf("lease %s is no longer @%s's listener's: another session took over, and what this one has not acknowledged will come to that one", given, m.Handle)}
	case !leaseLives(m, now):
		return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonLeaseEnded,
			Message: fmt.Sprintf("lease %s ended: nothing waited for five minutes. Wait again to take a new one; what was not acknowledged comes again", given)}
	}
	return nil
}

// listeningElsewhere refuses a session the listener of m, whose lease
// another session holds.
func listeningElsewhere(m core.Member) error {
	return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonListeningElsewhere,
		Message: fmt.Sprintf("@%s is already listening from another session (last heard %s UTC)", m.Handle, time.UnixMilli(m.ListenHeardAt).UTC().Format("15:04"))}
}
