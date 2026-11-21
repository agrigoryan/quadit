// The listener: the one session at a time that delivers an agent's inbox,
// by holding the agent's lease. `quadit wait` and `quadit listen` read the
// next item through GET /listen, which alone takes the lease; the cursor it
// delivers from ("listen", core.ListenCursor, unless another is named) is
// moved only by an acknowledgment made with the lease. While the lease
// lives the agent counts as listening.

package server

import (
	"context"
	"fmt"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// A lease lives leaseLife past the end of its holder's last wait, so the
// agent does not stop counting as listening while it handles an item. Its
// id is leaseLength characters of codeAlphabet, short enough to copy into a
// command.
const (
	leaseLife   = 5 * time.Minute
	leaseLength = 8
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
// so the two sessions never both deliver it.
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
	lease, err := s.holdLease(x, v.Get("lease"), truthyParam(v, "take"), time.Duration(wait)*time.Second)
	if err != nil {
		return err
	}
	defer s.endWait(x, lease)
	var cursor core.Cursor
	if _, err := store.Find(x.ctx(), x.db, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", name)); err != nil {
		return err
	}
	f := x.feed()
	f.After, f.OnlyAudience, f.Types, f.Limit = cursor.Seq, x.member.UserID, []string{"notification.created"}, 1
	page, err := s.waitForEvents(x, f, wait, false)
	if err != nil {
		return err
	}
	if len(page.events) == 0 {
		return x.ok(map[string]any{"lease": lease})
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
	return x.ok(map[string]any{"lease": lease, "seq": ev.Seq, "item": x.inboxItem(x.ctx(), note, names), "line": x.eventLine(x.ctx(), ev, names)})
}

// holdLease gives the caller's listener the lease for a wait of the length
// given, and returns its id: the lease given is renewed while it lives, and
// a new one is taken when none lives or, with take, from the session that
// holds it. Another session's live lease refuses the wait. Taking a lease
// proves an agent reached Quadit.
func (s *Server) holdLease(x *c, given string, take bool, wait time.Duration) (string, error) {
	now := time.Now()
	lease := given
	err := s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
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
			lease = randomCode(leaseLength)
		}
		_, err := tx.Update(x.ctx(), "members", map[string]any{"listen_lease": lease, "listening_until": now.Add(wait + leaseLife).UnixMilli(), "listen_heard_at": now.UnixMilli()},
			store.Eq("user_id", m.UserID))
		return err
	})
	if err != nil {
		return "", err
	}
	if x.member.ConnectedAt == 0 {
		if err := s.eng.System(x.ctx(), x.ws.ID, x.member.UserID, func(sys *engine.Sys) error { return sys.Connected() }); err != nil {
			return "", err
		}
	}
	return lease, nil
}

// endWait starts the lease's last leaseLife when its holder's wait ends,
// however it ends. It is best effort: the lease then ends when the wait was
// to end, plus leaseLife, a little later than it should.
func (s *Server) endWait(x *c, lease string) {
	until := time.Now().Add(leaseLife).UnixMilli()
	if _, err := x.db.Update(context.WithoutCancel(x.ctx()), "members", map[string]any{"listening_until": until},
		store.Eq("user_id", x.member.UserID), store.Eq("listen_lease", lease)); err != nil {
		s.log.Warn("the end of a wait was not noted on the listener's lease", "member", x.member.UserID, "err", err)
	}
}

// leaseLives reports whether m's listener lease lives at now.
func leaseLives(m core.Member, now time.Time) bool {
	return m.ListenLease != "" && m.ListeningUntil > now.UnixMilli()
}

// leaseLets refuses a move of a cursor the listener delivers from by a
// session that does not hold m's live lease: one that gives a lease taken
// over since, or one that ran out, or none while another session's lives.
// With no live lease and none given, the cursor is anyone's to move, as any
// other cursor.
func leaseLets(m core.Member, given string, now time.Time) error {
	switch {
	case given != "" && given != m.ListenLease:
		return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonLeaseStale,
			Message: fmt.Sprintf("lease %s is no longer @%s's listener's: another session took over, and what this one has not acknowledged will come to that one", given, m.Handle)}
	case given != "" && !leaseLives(m, now):
		return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonLeaseEnded,
			Message: fmt.Sprintf("lease %s ended: nothing waited for five minutes. Wait again to take a new one; what was not acknowledged comes again", given)}
	case given == "" && leaseLives(m, now):
		return listeningElsewhere(m)
	}
	return nil
}

// listeningElsewhere refuses a session the listener of m, whose lease
// another session holds.
func listeningElsewhere(m core.Member) error {
	return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonListeningElsewhere,
		Message: fmt.Sprintf("@%s is already listening from another session (last heard %s UTC)", m.Handle, time.UnixMilli(m.ListenHeardAt).UTC().Format("15:04"))}
}
