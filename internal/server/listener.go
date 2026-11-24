// The listeners: the sessions that deliver an agent's inbox, one at a time
// in each scope by holding that scope's lease. A scope is one project, or
// everything (no project). `quadit wait` and `quadit listen` read the next
// item through GET /listen (project= for a project's), which alone takes a
// lease; the cursor each listener delivers from (core.ListenCursorOf) is
// moved by an acknowledgment, held to the lease when it gives one. While a
// lease lives the agent listens in that scope.
//
// Which items each listener is handed is said once, by covers, and held to
// it both when an item is handed over and when pages are told what listens
// (hears): a project's listener gets the items of its project; the listener
// of everything gets the items of no project and of every project that
// never had a listener of its own. So a project once listened to by itself
// stays its own: when its session stops, its items wait for the next one
// instead of falling to a session that sits in another folder, until the
// agent forgets that project's listener.
//
// A `quadit listen` from before the lease reads GET /events?cursor=listen
// and acknowledges with no lease: it takes none and is refused nothing, but
// does not count as listening.

package server

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"slices"
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
		{"GET /api/v1/w/{ws}/listening", s.workspaceMember(s.handleShowListeners), "What listens as the caller, without taking a lease: {listening, by, last_heard} of the listener of everything (by is what holds the lease, as the holder said: \"a chat\", \"a companion\", \"the Quadit app\"), and listeners, every listener of the caller's: [{project_id, project, by, last_heard, live}], the listener of everything with no project. A project's listener stays when its session stops (live false): its items wait for its next listener, and the listener of everything leaves them out.", "", "follow"},
		{"GET /api/v1/w/{ws}/listen", s.workspaceMember(s.handleNextInboxItem), "The listener's read: the next item of the caller's inbox after the listener's cursor, waiting for one up to wait seconds (at most 55). With project=, the listener of that project: its items only, from the cursor listen:<project id>. Without, the listener of everything: the items of no project and of every project that never had a listener of its own, from the cursor listen. It holds that listener's lease: the first call takes it, and each call after gives its id as lease=; while it lives (90 seconds past the end of the hold its holder last asked for) another session is refused (reason listening_elsewhere) unless it asks with take=1, and the agent counts as listening. Answers {lease} when the wait ended with nothing, or {lease, seq, item, line} (line: the item as the feed writes it), with project: the project's key, for a project's listener. Nothing moves the cursor but an acknowledgment with the lease: PUT cursors/listen {seq, lease}. An agent's login only.", "wait: seconds, up to 55; project: a project's key or id, to listen to that project only; lease: the id the last call answered with; take: true to take the lease from the session that holds it; by: what listens, in a few plain words, said to whoever asks (\"a chat\", \"a companion\")", "follow"},
		{"DELETE /api/v1/w/{ws}/listening/{key}", s.workspaceMember(s.handleForgetListener), "Forget the caller's listener of a project (its key, or its id), and its cursor, so that the project's items go to the listener of everything again. Refused (conflict, reason listening_elsewhere) while its lease lives. Answers {project, forgotten}: forgotten false when the project had no listener of its own. dry_run=1 checks without forgetting.", "", "follow"},
	}
}

// covers reports whether the listener of scope (a project's id, or "" for
// everything) is handed the items of project ("" for an item of no
// project), given own: the agent's projects that have a listener of their
// own, live or not (agentListeners.own). It is the one rule of who is
// handed what: delivery reads the feed through listenFilter, its form as a
// filter, and holds each item to it before handing it over; hears tells
// pages from it.
func covers(scope, project string, own map[string]bool) bool {
	if scope != "" {
		return project == scope
	}
	return !own[project]
}

// listenFilter narrows the feed f to what covers hands the listener of
// scope.
func listenFilter(f store.EventFilter, scope string, own map[string]bool) store.EventFilter {
	if scope != "" {
		f.ProjectIDs, f.AllowNoProject = []string{scope}, false
		return f
	}
	f.NotProjectIDs = slices.Collect(maps.Keys(own))
	return f
}

// agentListeners are the listeners of one agent, of every scope.
type agentListeners []core.Listener

// listenersOf reads them.
func listenersOf(ctx context.Context, db store.DB, agentID string) (agentListeners, error) {
	var listeners []core.Listener
	err := db.List(ctx, &listeners, store.Where(store.Eq("agent_id", agentID)))
	return listeners, err
}

// of is the listener of scope, when there is one.
func (ls agentListeners) of(scope string) (core.Listener, bool) {
	i := slices.IndexFunc(ls, func(l core.Listener) bool { return l.ProjectID == scope })
	if i < 0 {
		return core.Listener{}, false
	}
	return ls[i], true
}

// own are the projects that have a listener of their own.
func (ls agentListeners) own() map[string]bool {
	own := map[string]bool{}
	for _, l := range ls {
		if l.ProjectID != "" {
			own[l.ProjectID] = true
		}
	}
	return own
}

// hears reports whether a listener whose lease lives at now is handed the
// items of project ("" for those of no project).
func (ls agentListeners) hears(project string, now time.Time) bool {
	own := ls.own()
	return slices.ContainsFunc(ls, func(l core.Listener) bool { return leaseLives(l, now) && covers(l.ProjectID, project, own) })
}

// listenerOf picks out the agent's listener of scope in a write.
func listenerOf(agentID, scope string) []store.Cond {
	if scope == "" {
		return []store.Cond{store.Eq("agent_id", agentID), store.Null("project_id")}
	}
	return []store.Cond{store.Eq("agent_id", agentID), store.Eq("project_id", scope)}
}

// leaseLives reports whether l's lease lives at now.
func leaseLives(l core.Listener, now time.Time) bool {
	return l.Lease != "" && l.LeaseUntil > now.UnixMilli()
}

// listenProject is the project a listener is asked for by key or id, or
// none for "": the listener of everything.
func (who *viewer) listenProject(ctx context.Context, ref string) (core.Project, error) {
	if ref == "" {
		return core.Project{}, nil
	}
	project, err := who.resolver(ctx).Project(ref)
	if err != nil {
		return core.Project{}, err
	}
	if !who.canProject(project.ID) {
		return core.Project{}, errNotFound("project " + ref)
	}
	return project, nil
}

// handleNextInboxItem answers the next inbox item of the listener asked
// for, holding its lease while it waits. An item is handed over only if,
// when it comes, the lease is still this session's and the listener still
// covers it: one taken over meanwhile is refused here, and an item whose
// project got a listener of its own meanwhile is that one's, so two
// sessions never both deliver an item.
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
	project, err := x.listenProject(x.ctx(), v.Get("project"))
	if err != nil {
		return err
	}
	lease, own, err := s.holdLease(x, project, leaseAsk{lease: v.Get("lease"), take: truthyParam(v, "take"), by: by}, time.Duration(wait)*time.Second)
	if err != nil {
		return err
	}
	if x.member.ConnectedAt == 0 {
		if err := s.eng.System(x.ctx(), x.ws.ID, x.member.UserID, func(sys *engine.Sys) error { return sys.Connected() }); err != nil {
			return err
		}
	}
	start, err := s.listenStart(x, core.ListenCursorOf(project.ID))
	if err != nil {
		return err
	}
	f := listenFilter(x.feed(), project.ID, own)
	f.After, f.OnlyAudience, f.Types, f.Limit = start, x.member.UserID, []string{"notification.created"}, 1
	page, err := s.waitForEvents(x, f, wait, false)
	if err != nil {
		return err
	}
	out := map[string]any{"lease": lease}
	if project.ID != "" {
		out["project"] = project.Key
	}
	if len(page.events) == 0 {
		return x.ok(out)
	}
	// The wait may have slept through a takeover, or through the item's
	// project getting a listener of its own, as the writes that did would
	// have seen.
	ev := page.events[0]
	covered := false
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		listeners, err := listenersOf(x.ctx(), tx, x.member.UserID)
		if err != nil {
			return err
		}
		if held, _ := listeners.of(project.ID); held.Lease != lease {
			return listeningElsewhere(x.member, held, project.Key)
		}
		covered = covers(project.ID, ev.ProjectID, listeners.own())
		return nil
	})
	if err != nil {
		return err
	}
	if !covered {
		return x.ok(out)
	}
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	var note core.Notification
	if data, err := ev.Payload(); err == nil {
		data.ReadRow(&note)
	}
	note.Seq = ev.Seq
	out["seq"], out["item"], out["line"] = ev.Seq, x.inboxItem(x.ctx(), note, names), x.eventLine(x.ctx(), ev, names)
	return x.ok(out)
}

// listenStart is where a listener reads on from, its cursor: one never
// moved is set, once, to the present, so the agent's history is not
// replayed. A project's first listener has its cursor already
// (startProjectListener).
func (s *Server) listenStart(x *c, cursorName string) (int64, error) {
	ctx := x.ctx()
	var cursor core.Cursor
	there, err := store.Find(ctx, x.db, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", cursorName))
	if err != nil || there {
		return cursor.Seq, err
	}
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.ws.ID)); err != nil {
		return 0, err
	}
	return ws.Seq, x.db.Advance(ctx, core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: cursorName, Seq: ws.Seq, UpdatedAt: time.Now().UnixMilli()},
		"seq", "workspace_id", "user_id", "name")
}

// startProjectListener sets the cursor of the agent's first listener of a
// project, in the write that makes it, from listeners as they were before
// it. While the listener of everything's lease lives, what lies between
// its cursor and the present is its queue, not history: the project's
// listener takes over the queue's items of its project, after the item the
// listener of everything may hold in hand, delivered and not acknowledged.
// That is the first item after its cursor it covers, since it is handed
// that one until it acknowledges it; it is taken to be in hand even when it
// may not have been handed yet, because an item missed stays in the inbox,
// and one handed to two sessions is done twice. With no live listener of
// everything, the project's listener starts at the present, so history is
// never replayed.
func (who *viewer) startProjectListener(ctx context.Context, tx store.Tx, listeners agentListeners, projectID string, now time.Time) error {
	start := tx.Seq()
	var queue core.Cursor
	everything, _ := listeners.of("")
	there, err := store.Find(ctx, tx, &queue, store.Eq("user_id", who.member.UserID), store.Eq("name", core.ListenCursor))
	if err != nil {
		return err
	}
	if there && leaseLives(everything, now) {
		f := listenFilter(who.feed(), "", listeners.own())
		f.After, f.OnlyAudience, f.Types, f.Limit = queue.Seq, who.member.UserID, []string{"notification.created"}, 1
		inHand, err := tx.Events(ctx, f)
		if err != nil {
			return err
		}
		start = queue.Seq
		if len(inHand) > 0 {
			start = inHand[0].Seq
		}
	}
	return tx.Advance(ctx, core.Cursor{WorkspaceID: who.ws.ID, UserID: who.member.UserID, Name: core.ListenCursorOf(projectID), Seq: start, UpdatedAt: now.UnixMilli()},
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

// holdLease gives the caller's listener of project (none: of everything)
// the lease for a wait of the length given, and returns its id and the
// projects that have a listener of their own, this one among them: the
// lease asked for is renewed (taken again when it ran out and nobody took
// it), and a new one is taken when none lives or, with take, from the
// session that holds it. Another session's live lease refuses the wait.
// The member's row says when the last of its leases ends. The write is not
// cut off by the caller going away, so that when it answers, what it did is
// known.
func (s *Server) holdLease(x *c, project core.Project, ask leaseAsk, wait time.Duration) (lease string, own map[string]bool, err error) {
	now := time.Now()
	lease = ask.lease
	ctx := context.WithoutCancel(x.ctx())
	agentID := x.member.UserID
	err = s.st.Write(ctx, x.ws.ID, func(tx store.Tx) error {
		listeners, err := listenersOf(ctx, tx, agentID)
		if err != nil {
			return err
		}
		held, found := listeners.of(project.ID)
		live := leaseLives(held, now)
		switch {
		case live && ask.lease == held.Lease:
		case live && !ask.take:
			return listeningElsewhere(x.member, held, project.Key)
		case ask.lease == "" || ask.lease != held.Lease:
			lease = randomCode(leaseLength)
		}
		row := core.Listener{WorkspaceID: x.ws.ID, AgentID: agentID, ProjectID: project.ID, Lease: lease,
			LeaseUntil: now.Add(wait + leaseLife).UnixMilli(), HeardAt: now.UnixMilli(), HeldBy: ask.by}
		if found {
			_, err = tx.Update(ctx, "listeners", map[string]any{"lease": row.Lease, "lease_until": row.LeaseUntil, "heard_at": row.HeardAt, "held_by": row.HeldBy},
				listenerOf(agentID, project.ID)...)
		} else {
			err = tx.Insert(ctx, row)
			if err == nil && project.ID != "" {
				err = x.startProjectListener(ctx, tx, listeners, project.ID, now)
			}
			listeners = append(listeners, row)
		}
		if err != nil {
			return err
		}
		until := row.LeaseUntil
		for _, l := range listeners {
			if l.ProjectID != project.ID {
				until = max(until, l.LeaseUntil)
			}
		}
		own = listeners.own()
		_, err = tx.Update(ctx, "members", map[string]any{"listening_until": until}, store.Eq("user_id", agentID))
		return err
	})
	if err != nil {
		return "", nil, err
	}
	return lease, own, nil
}

// listenerHolding is the caller's listener whose lease is the one given:
// what an acknowledgment made with it moves the cursor of. It refuses a
// lease that another session took over since. A lease that only ran out,
// which nobody took, is still its listener's: no other session delivers
// its items.
func listenerHolding(ctx context.Context, db store.DB, m core.Member, lease string) (core.Listener, error) {
	var l core.Listener
	there, err := store.Find(ctx, db, &l, store.Eq("agent_id", m.UserID), store.Eq("lease", lease))
	if err == nil && !there {
		err = &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonLeaseStale,
			Message: fmt.Sprintf("lease %s is no longer one of @%s's listeners': another session took over, and what this one has not acknowledged will come to that one", lease, m.Handle)}
	}
	return l, err
}

// listeningElsewhere refuses a session the listener of m held (of the
// project of key projectKey, or "" for everything), whose lease another
// session holds, saying what holds it when the holder said.
func listeningElsewhere(m core.Member, held core.Listener, projectKey string) error {
	to, what := "", ""
	if projectKey != "" {
		to = " to " + projectKey
	}
	if held.HeldBy != "" {
		what = held.HeldBy + ", "
	}
	return &engine.Error{Code: engine.CodeConflict, Field: "lease", Reason: reasonListeningElsewhere,
		Message: fmt.Sprintf("@%s is already listening%s from another session (%slast heard %s UTC)", m.Handle, to, what, time.UnixMilli(held.HeardAt).UTC().Format("15:04"))}
}

// listenerShown is a listener as it is told: its project (its id and key;
// none for the listener of everything), what holds its lease, as the holder
// said, when it was last heard, and whether its lease lives.
type listenerShown struct {
	ProjectID string `json:"project_id,omitempty"`
	Project   string `json:"project,omitempty"`
	By        string `json:"by,omitempty"`
	LastHeard string `json:"last_heard,omitempty"`
	Live      bool   `json:"live"`
}

// shown is the listeners as they are told, the listener of everything
// first, then by project key. keys are the projects the viewer may read,
// key by id (readableProjectKeys); a listener of another project is left
// out. Never nil.
func shown(ls agentListeners, keys map[string]string, now time.Time) []listenerShown {
	out := []listenerShown{}
	for _, l := range ls {
		if key, readable := keys[l.ProjectID]; readable || l.ProjectID == "" {
			out = append(out, listenerShown{ProjectID: l.ProjectID, Project: key, By: l.HeldBy, LastHeard: formatTime(l.HeardAt), Live: leaseLives(l, now)})
		}
	}
	slices.SortFunc(out, func(a, b listenerShown) int {
		return cmp.Or(cmp.Compare(len(a.ProjectID), len(b.ProjectID)), cmp.Compare(a.Project, b.Project))
	})
	return out
}

// readableProjectKeys are the keys of the projects the viewer may read, by
// id.
func (who *viewer) readableProjectKeys(ctx context.Context) (map[string]string, error) {
	var projects []core.Project
	if err := who.db.List(ctx, &projects, store.Where(store.Live)); err != nil {
		return nil, err
	}
	keys := map[string]string{}
	for _, p := range projects {
		if who.canProject(p.ID) {
			keys[p.ID] = p.Key
		}
	}
	return keys, nil
}

// listenersReach is what pages are told of what listens as an agent, so
// that they can tell, for any project, whether something does: its
// listeners (Listeners), and, from covers, the projects whose items a
// live listener is handed now (ListeningProjects, ids) and whether one is
// handed the items of no project (ListeningOutsideProjects). A webhook
// that is heard hears every item.
type listenersReach struct {
	Listeners                []listenerShown `json:"listeners"`
	ListeningProjects        []string        `json:"listening_projects"`
	ListeningOutsideProjects bool            `json:"listening_outside_projects"`
}

// reachOf is it, for an agent with these listeners, and pushed when a
// webhook is heard for it, among the projects of keys (readableProjectKeys).
func reachOf(ls agentListeners, pushed bool, keys map[string]string, now time.Time) listenersReach {
	r := listenersReach{Listeners: shown(ls, keys, now), ListeningProjects: []string{}, ListeningOutsideProjects: pushed || ls.hears("", now)}
	for _, project := range slices.Sorted(maps.Keys(keys)) {
		if pushed || ls.hears(project, now) {
			r.ListeningProjects = append(r.ListeningProjects, project)
		}
	}
	return r
}

// handleShowListeners says what listens as the caller, without taking a
// lease: so a chat can learn that a companion or the app already answers
// for it. Its first fields are the listener of everything's, as they were
// when it was the only one.
func (s *Server) handleShowListeners(x *c) error {
	listeners, err := listenersOf(x.ctx(), x.db, x.member.UserID)
	if err != nil {
		return err
	}
	keys, err := x.readableProjectKeys(x.ctx())
	if err != nil {
		return err
	}
	now := time.Now()
	everything, _ := listeners.of("")
	out := map[string]any{"listening": leaseLives(everything, now), "listeners": shown(listeners, keys, now)}
	if out["listening"] == true {
		out["by"], out["last_heard"] = everything.HeldBy, formatTime(everything.HeardAt)
	}
	return x.ok(out)
}

// handleForgetListener forgets the caller's listener of a project, and its
// cursor, while no session holds its lease: the way back for a project
// that should go to the listener of everything again. Forgetting a project
// that has no listener of its own is done already.
func (s *Server) handleForgetListener(x *c) error {
	project, err := x.listenProject(x.ctx(), x.r.PathValue("key"))
	if err != nil {
		return err
	}
	dry := truthyParam(x.r.URL.Query(), "dry_run")
	forgotten := false
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		var held core.Listener
		there, err := store.Find(x.ctx(), tx, &held, listenerOf(x.member.UserID, project.ID)...)
		if err != nil || !there {
			return err
		}
		if leaseLives(held, time.Now()) {
			return listeningElsewhere(x.member, held, project.Key)
		}
		forgotten = true
		if dry {
			return nil
		}
		if _, err := tx.Delete(x.ctx(), "listeners", listenerOf(x.member.UserID, project.ID)...); err != nil {
			return err
		}
		_, err = tx.Delete(x.ctx(), "cursors", store.Eq("user_id", x.member.UserID), store.Eq("name", core.ListenCursorOf(project.ID)))
		return err
	})
	if err != nil {
		return err
	}
	out := map[string]any{"project": project.Key, "forgotten": forgotten}
	if dry {
		out["dry_run"] = true
	}
	return x.ok(out)
}
