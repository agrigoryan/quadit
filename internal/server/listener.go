// The listener: the one session at a time that delivers an agent's inbox,
// by holding the agent's lease. `quadit wait` and `quadit listen` read the
// next item through GET /listen, which alone takes the lease; the cursor it
// delivers from ("listen", core.ListenCursor) is moved by an
// acknowledgment, held to the lease when it gives one. While the lease
// lives the agent counts as listening.
//
// A `quadit listen` from before the lease reads GET /events?cursor=listen
// and acknowledges with no lease: it takes none and is refused nothing, but
// does not count as listening.

package server

import (
	"context"
	"fmt"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// A lease lives leaseLife past the end of the hold its holder last asked
// for: a holder at work renews it by asking again (a wait by waiting, quadit
// listen every minute while its command runs). Its id is
// leaseLength characters of codeAlphabet, short enough to copy into a
// command.
const (
	leaseLife   = 90 * time.Second
	leaseLength = 8
)

// Why a session was refused (engine.Error.Reason).
const (
	// reasonListeningElsewhere: another session holds the live lease.
	reasonListeningElsewhere = "listening_elsewhere"
	// reasonLeaseStale: the lease given was taken over since.
	reasonLeaseStale = "lease_stale"
)

// listenerRoutes are the routes of the listener.
func (s *Server) listenerRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/listening", s.workspaceMember(s.handleShowListener), "Whether something listens as the caller, without taking the lease: {listening, by, last_heard}. by is what holds the lease, as the holder said (\"a chat\", \"a companion\", \"the Quadit app\").", "", "follow"},
		{"GET /api/v1/w/{ws}/listen", s.workspaceMember(s.handleNextInboxItem), "The listener's read: the next item of the caller's inbox after the cursor listen, waiting for one up to wait seconds (at most 55). It holds the agent's listener lease: the first call takes it, and each call after gives its id as lease=; while it lives (90 seconds past the end of the hold its holder last asked for) another session is refused (reason listening_elsewhere) unless it asks with take=1, and the agent counts as listening. Answers {lease} when the wait ended with nothing, or {lease, seq, item, line} (line: the item as the feed writes it). Nothing moves the cursor but an acknowledgment with the lease: PUT cursors/listen {seq, lease}. An agent's login only.", "wait: seconds, up to 55; lease: the id the last call answered with; take: true to take the lease from the session that holds it; by: what listens, in a few plain words, said to whoever asks (\"a chat\", \"a companion\")", "follow"},
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
	wait := min(x.intParam("wait", 0), maxFeedWait)
	by := v.Get("by")
	if by != "" && !core.ListenerLabel.MatchString(by) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "by", Message: "by= names what listens in a few plain words (\"a chat\", \"a companion\"): at most 40 letters, digits, spaces, - and '"}
	}
	lease, err := s.holdLease(x, leaseAsk{lease: v.Get("lease"), take: truthyParam(v, "take"), by: by}, time.Duration(wait)*time.Second)
	if err != nil {
		return err
	}
	if x.member.ConnectedAt == 0 {
		if err := s.eng.System(x.ctx(), x.ws.ID, x.member.UserID, func(sys *engine.Sys) error { return sys.Connected() }); err != nil {
			return err
		}
	}
	start, err := s.listenStart(x)
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
	if len(page.events) == 0 {
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
	return x.ok(out)
}

// listenStart is where the listener reads on from: a cursor never moved is
// set, once, to the present, so the agent's history is not replayed.
func (s *Server) listenStart(x *c) (int64, error) {
	ctx := x.ctx()
	var cursor core.Cursor
	there, err := store.Find(ctx, x.db, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", core.ListenCursor))
	if err != nil || there {
		return cursor.Seq, err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return 0, err
	}
	return ws.Seq, x.db.Advance(ctx, core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: core.ListenCursor, Seq: ws.Seq, UpdatedAt: time.Now().UnixMilli()},
		"seq", "workspace_id", "user_id", "name")
}

// leaseAsk is what a wait asks of the lease: the id it holds (or none),
// whether to take it from another session, and what it is, in words a
// person reads, for whoever asks what listens.
type leaseAsk struct {
	lease string
	take  bool
	by    string
}

// holdLease gives the caller's listener the lease for a wait of the length
// given, and returns its id: the lease asked for is renewed (taken again
// when it ran out and nobody took it), and a new one is taken when none
// lives or, with take, from the session that holds it.
// Another session's live lease refuses the wait. The write is not cut off
// by the caller going away, so that when it answers, what it did is known.
func (s *Server) holdLease(x *c, ask leaseAsk, wait time.Duration) (lease string, err error) {
	now := time.Now()
	given, lease := ask.lease, ask.lease
	ctx := context.WithoutCancel(x.ctx())
	err = s.st.Write(ctx, x.ws.ID, func(tx store.Tx) error {
		var m core.Member
		if err := tx.Get(ctx, &m, store.Eq("user_id", x.member.UserID)); err != nil {
			return err
		}
		live := leaseLives(m, now)
		set := map[string]any{"listening_until": now.Add(wait + leaseLife).UnixMilli(), "listen_heard_at": now.UnixMilli(), "listen_by": ask.by}
		switch {
		case live && given == m.ListenLease:
		case live && !ask.take:
			return listeningElsewhere(m)
		case given == "" || given != m.ListenLease:
			lease = randomCode(leaseLength)
		}
		set["listen_lease"] = lease
		_, err := tx.Update(ctx, "members", set, store.Eq("user_id", m.UserID))
		return err
	})
	if err != nil {
		return "", err
	}
	return lease, nil
}

// leaseLives reports whether m's listener lease lives at now.
func leaseLives(m core.Member, now time.Time) bool {
	return m.ListenLease != "" && m.ListeningUntil > now.UnixMilli()
}

// leaseLets refuses a move of a cursor, made with lease given, by a session
// whose lease another session took since. A lease that only ran out, which
// nobody took, still acknowledges: no other session delivers the item. A
// move that gives no lease is let through, as it always was: a `quadit
// listen` from before the lease acknowledges so, and so does a person
// giving up on an item by hand.
func leaseLets(m core.Member, given string) error {
	if given != "" && given != m.ListenLease {
		return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonLeaseStale,
			Message: fmt.Sprintf("lease %s is no longer @%s's listener's: another session took over, and what this one has not acknowledged will come to that one", given, m.Handle)}
	}
	return nil
}

// listeningElsewhere refuses a session the listener of m, whose lease
// another session holds, saying what holds it when the holder said.
func listeningElsewhere(m core.Member) error {
	what := ""
	if m.ListenBy != "" {
		what = m.ListenBy + ", "
	}
	return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonListeningElsewhere,
		Message: fmt.Sprintf("@%s is already listening from another session (%slast heard %s UTC)", m.Handle, what, time.UnixMilli(m.ListenHeardAt).UTC().Format("15:04"))}
}

// handleShowListener says whether something listens as the caller, what,
// and when it was last heard, without taking the lease: so a chat can learn
// that a companion or the app already answers for it.
func (s *Server) handleShowListener(x *c) error {
	var m core.Member
	if err := x.db.Get(x.ctx(), &m, store.Eq("user_id", x.member.UserID)); err != nil {
		return err
	}
	out := map[string]any{"listening": leaseLives(m, time.Now())}
	if out["listening"] == true {
		out["by"], out["last_heard"] = m.ListenBy, formatTime(m.ListenHeardAt)
	}
	return x.ok(out)
}
