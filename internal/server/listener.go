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

// A lease lives leaseLife past the end of its holder's last request,
// however that ended: a holder at work renews it by asking again (a wait by
// waiting, quadit listen every minute while its command runs). Its id is
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
		{"GET /api/v1/w/{ws}/listening", s.workspaceMember(s.handleShowListener), "Whether something listens as the caller, without taking the lease: {listening, by, since, last_heard, yours, webhook}. by is what holds the lease, as the holder said (\"a chat\", \"a companion\", \"the Quadit app\"); yours, whether it is the lease given as lease=; webhook, whether a webhook delivers the caller's inbox.", "lease: a lease id, to learn whether it is the one that lives", "follow"},
		{"GET /api/v1/w/{ws}/listen", s.workspaceMember(s.handleNextInboxItem), "The listener's read: the next item of the caller's inbox after its cursor (listen, or the one named), waiting for one up to wait seconds (at most 55). It holds the agent's listener lease: the first call takes it, and each call after gives its id as lease=; while it lives (90 seconds past the end of its holder's last request) another session is refused (reason listening_elsewhere) unless it asks with take=1, and the agent counts as listening. Answers {lease} when the wait ended with nothing, or {lease, seq, item, line} (line: the item as the feed writes it). Nothing moves the cursor but an acknowledgment with the lease: PUT cursors/{name} {seq, lease}. An agent's login only.", "wait: seconds, up to 55; lease: the id the last call answered with; take: true to take the lease from the session that holds it; cursor: the cursor to deliver from (listen); by: what listens, in a few plain words, said to whoever asks (\"a chat\", \"a companion\")", "follow"},
	}
}

// handleNextInboxItem answers the listener's next inbox item, holding the
// lease while it waits. An item is handed over only if the lease is still
// this session's when it comes: one taken over meanwhile is refused here,
// so the two sessions never both deliver it. However the wait ends, the
// lease lives leaseLife from then (endWait).
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
	by := v.Get("by")
	if by != "" && !core.ListenerLabel.MatchString(by) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "by", Message: "by= names what listens in a few plain words (\"a chat\", \"a companion\"): at most 40 letters, digits, spaces, - and '"}
	}
	lease, err := s.holdLease(x, leaseAsk{lease: v.Get("lease"), take: truthyParam(v, "take"), by: by}, time.Duration(wait)*time.Second)
	if err != nil {
		return err
	}
	defer s.endWait(x, lease)
	if x.member.ConnectedAt == 0 {
		if err := s.eng.System(x.ctx(), x.ws.ID, x.member.UserID, func(sys *engine.Sys) error { return sys.Connected() }); err != nil {
			return err
		}
	}
	start, err := s.listenStart(x, name)
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

// listenStart is where the listener reads on from in cursor name: a
// cursor never moved is set, once, to the present, so the agent's history
// is not replayed.
func (s *Server) listenStart(x *c, name string) (int64, error) {
	ctx := x.ctx()
	var cursor core.Cursor
	there, err := store.Find(ctx, x.db, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", name))
	if err != nil || there {
		return cursor.Seq, err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return 0, err
	}
	return ws.Seq, x.db.Advance(ctx, core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: name, Seq: ws.Seq, UpdatedAt: time.Now().UnixMilli()},
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
			set["listen_since"] = now.UnixMilli()
		default:
			set["listen_since"] = now.UnixMilli() // its own lease, which had run out: held again from now
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

// endWait makes the lease live leaseLife from the end of its holder's
// wait. It is best effort: the lease then ends leaseLife after the wait was
// to end.
func (s *Server) endWait(x *c, lease string) {
	set := map[string]any{"listening_until": time.Now().Add(leaseLife).UnixMilli()}
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

// handleShowListener says whether something listens as the caller, and
// what and since when, without taking the lease: so a chat can learn that
// a companion or the app already answers for it. With lease= it says
// whether that lease is the one that lives (yours).
func (s *Server) handleShowListener(x *c) error {
	var m core.Member
	if err := x.db.Get(x.ctx(), &m, store.Eq("user_id", x.member.UserID)); err != nil {
		return err
	}
	now := time.Now()
	// Listening as the agent's pages show it: a live lease, or the held wait
	// of a quadit listen from before the lease, which takes none.
	out := map[string]any{"listening": m.ListeningUntil > now.UnixMilli()}
	switch {
	case leaseLives(m, now):
		given := x.r.URL.Query().Get("lease")
		out["by"], out["since"], out["last_heard"], out["yours"] = m.ListenBy, formatTime(m.ListenSince), formatTime(m.ListenHeardAt), given != "" && given == m.ListenLease
	case m.ListeningUntil > now.UnixMilli():
		out["by"], out["yours"] = "a quadit listen from before the lease", false
	}
	reach, err := x.agentReach(x.ctx())
	if err != nil {
		return err
	}
	out["webhook"] = reach.pushed[m.UserID]
	return x.ok(out)
}
