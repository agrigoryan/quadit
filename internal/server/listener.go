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
	"errors"
	"fmt"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strconv"
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
	reasonLeaseStale = engine.ReasonLeaseStale
)

// A runner's hold (GET /listen with machine_id=) is answered, besides its
// head item, with at most batchLength other items of the head's task.
const batchLength = 20

// listenerRoutes are the routes of the listener.
func (s *Server) listenerRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/listening", s.workspaceMember(s.handleShowListeners), "What listens as the caller, without taking a lease: {listening, by, last_heard} of the listener of everything (by is what holds the lease, as the holder said: \"a chat\", \"a companion\", \"the Quadit app\"), and listeners, every listener of the caller's: [{project_id, project, by, last_heard, live, runner}], the listener of everything with no project; runner, on a listener Quadit's runner marked: {machine, folder, program, program_version, holding (the runner holds the lease now), since (its last hold), paused, paused_until, task (the task of this project its open run is on)}. A project's listener stays when its session stops (live false): its items wait for its next listener, and the listener of everything leaves them out.", "", "follow"},
		{"GET /api/v1/w/{ws}/listen", s.workspaceMember(s.handleNextInboxItem), "The listener's read: the next item of the caller's inbox after the listener's cursor, waiting for one up to wait seconds (at most 55). With project=, the listener of that project: its items only, from the cursor listen:<project id>. Without, the listener of everything: the items of no project and of every project that never had a listener of its own, from the cursor listen. It holds that listener's lease: the first call takes it, and each call after gives its id as lease=; while it lives (90 seconds past the end of the hold its holder last asked for) another session is refused (reason listening_elsewhere) unless it asks with take=1, and the agent counts as listening. Answers {lease} when the wait ended with nothing, or {lease, seq, item, line, wake} (line: the item as the feed writes it; wake: what Quadit's runner does with it, {do: run, ack or refuse, why}), with project: the project's key, for a project's listener. A runner's hold (machine_id=) marks the listener as its own; with batch=1 and a head item of a task, batch is the other items of that task after it that this listener would be handed, oldest first, at most 20, each {seq, item, line, wake}, not handed by being told. Nothing moves the cursor but an acknowledgment with the lease: PUT cursors/listen {seq, lease}. An agent's login only.", "wait: seconds, up to 55; project: a project's key or id, to listen to that project only; lease: the id the last call answered with; take: true to take the lease from the session that holds it; by: what listens, in a few plain words, said to whoever asks (\"a chat\", \"a companion\"); machine_id: Quadit's runner's machine (16 lower-case hex), which makes the hold a runner's, of a project's listener only; machine_name, folder (its label, from / or ~), program (claude, codex), program_version: what the runner says of itself; paused: why it holds every item back (usage_limit, not_signed_in, program_missing, folder_missing, login_mismatch, server_old), empty for nothing; paused_until: with paused=usage_limit, when it tries again (Unix ms); batch: true to be answered also the other items of the head's task", "follow"},
		{"DELETE /api/v1/w/{ws}/listening/{key}/runner", s.workspaceMember(s.handleReleaseRunner), "Let Quadit's runner on a machine go from the caller's listener of a project (its key, or its id): when machine_id is the machine that marked it, the mark goes, and the lease ends if the runner holds it, so a chat can listen at once; the listener and its cursor stay. Answers {project, released}: released false when there was no mark, or another machine's. dry_run=1 checks without doing. An agent's login only.", "machine_id: the runner's machine; dry_run: true to check only", "follow"},
		{"DELETE /api/v1/w/{ws}/listening/{key}", s.workspaceMember(s.handleForgetListener), "Forget the caller's listener of a project (its key, or its id), and its cursor, so that from now on the project's items go to the listener of everything, whose cursor moves to the present: nothing acknowledged comes again, and what was pending for either stays unread in the inbox. Refused (conflict, reason listening_elsewhere) while its lease lives. Answers {project, forgotten}: forgotten false when the project had no listener of its own. dry_run=1 checks without forgetting.", "", "follow"},
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
	return slices.ContainsFunc(ls, func(l core.Listener) bool { return l.LeaseLives(now.UnixMilli()) && covers(l.ProjectID, project, own) })
}

// listenerOf picks out the agent's listener of scope in a write.
func listenerOf(agentID, scope string) []store.Cond {
	if scope == "" {
		return []store.Cond{store.Eq("agent_id", agentID), store.Null("project_id")}
	}
	return []store.Cond{store.Eq("agent_id", agentID), store.Eq("project_id", scope)}
}

// listenProject is the project a listener is asked for by key or id, or
// none for "": the listener of everything. A project the viewer may not
// read is refused as one that does not exist, naming only the projects it
// may read.
func (who *viewer) listenProject(ctx context.Context, ref string) (core.Project, error) {
	if ref == "" {
		return core.Project{}, nil
	}
	project, err := who.resolver(ctx).Project(ref)
	var refused *engine.Error
	switch {
	case err == nil && who.canProject(project.ID):
		return project, nil
	case err != nil && (!errors.As(err, &refused) || refused.Code != engine.CodeNotFound):
		return core.Project{}, err
	}
	keys, err := who.readableProjectKeys(ctx)
	if err != nil {
		return core.Project{}, err
	}
	return core.Project{}, &engine.Error{Code: engine.CodeNotFound, Field: "project", Message: fmt.Sprintf("project %q does not exist in this workspace", ref),
		Allowed: slices.Sorted(maps.Values(keys))}
}

// mayCursor reports whether the viewer may see and move its member's cursor
// of that name: a listener's cursor of a project only when it may read the
// project.
func (who *viewer) mayCursor(name string) bool {
	project, ok := core.ListenCursorProject(name)
	return !ok || who.canProject(project)
}

// handleNextInboxItem answers the next inbox item of the listener asked
// for, holding its lease while it waits. An item is handed over only if,
// when it comes, the lease is still this session's and the listener still
// covers it: one taken over meanwhile is refused here, and an item whose
// project got a listener of its own meanwhile is that one's, so two
// sessions never both deliver an item. Every item comes with what Quadit's
// runner would do with it (wake); a runner's hold marks the listener as
// its own, and may ask for the other items of the head's task (batch).
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
	runner, batch, err := runnerHoldOf(v)
	if err != nil {
		return err
	}
	project, err := x.listenProject(x.ctx(), v.Get("project"))
	if err != nil {
		return err
	}
	if runner != nil && project.ID == "" {
		return &engine.Error{Code: engine.CodeInvalid, Field: "project", Message: "a runner listens to one project: give project="}
	}
	lease, own, err := s.holdLease(x, project, leaseAsk{lease: v.Get("lease"), take: truthyParam(v, "take"), by: by, runner: runner}, time.Duration(wait)*time.Second)
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
	// What a runner does with the item, and with the items of its task
	// after it, is decided before anything is handed: a read that fails
	// hands nothing out.
	ev := page.events[0]
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	head, err := x.handed(x.ctx(), ev, names)
	if err != nil {
		return err
	}
	batch = batch && ev.ScopeType == "task"
	var more []handedItem
	if batch {
		if more, err = x.taskBatch(x.ctx(), ev, project.ID, own, names); err != nil {
			return err
		}
	}
	// The wait may have slept through a takeover, through the item's
	// project getting a listener of its own, or through a forget moving the
	// cursor past it, as the writes that did would have seen. An item
	// handed over is recorded on its listener (Listener.HandedSeq).
	covered := false
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		listeners, err := listenersOf(x.ctx(), tx, x.member.UserID)
		if err != nil {
			return err
		}
		if held, _ := listeners.of(project.ID); held.Lease != lease {
			return listeningElsewhere(x.member, held, project.Key)
		}
		var cursor core.Cursor
		if _, err := store.Find(x.ctx(), tx, &cursor, store.Eq("user_id", x.member.UserID), store.Eq("name", core.ListenCursorOf(project.ID))); err != nil {
			return err
		}
		covered = ev.Seq > cursor.Seq && covers(project.ID, ev.ProjectID, listeners.own())
		if !covered {
			return nil
		}
		_, err = tx.Update(x.ctx(), "listeners", map[string]any{"handed_seq": ev.Seq}, listenerOf(x.member.UserID, project.ID)...)
		return err
	})
	if err != nil {
		return err
	}
	if !covered {
		return x.ok(out)
	}
	out["seq"], out["item"], out["line"], out["wake"] = head.Seq, head.Item, head.Line, head.Wake
	if batch {
		out["batch"] = more
	}
	return x.ok(out)
}

// handedItem is an inbox item as a listener is handed it: the item, its
// line as the feed writes it, and what Quadit's runner does with it.
type handedItem struct {
	Seq  int64     `json:"seq"`
	Item inboxItem `json:"item"`
	Line string    `json:"line"`
	Wake wake      `json:"wake"`
}

// handed is the viewer's item of the notification.created event ev, as a
// listener is handed it.
func (who *viewer) handed(ctx context.Context, ev core.Event, names *nameLookup) (handedItem, error) {
	w, err := who.wakeOf(ctx, who.member, ev)
	if err != nil {
		return handedItem{}, err
	}
	var note core.Notification
	if data, err := ev.Payload(); err == nil {
		data.ReadRow(&note)
	}
	note.Seq = ev.Seq
	return handedItem{Seq: ev.Seq, Item: who.inboxItem(ctx, note, names), Line: who.eventLine(ctx, ev, names), Wake: w}, nil
}

// taskBatch is what a runner's hold answers with its head ev beside it: the
// viewer's items after it, of the same task, that the listener of scope
// would be handed (listenFilter), up to the present, oldest first, at most
// batchLength. They are not recorded as handed: each comes again as a head.
func (who *viewer) taskBatch(ctx context.Context, ev core.Event, scope string, own map[string]bool, names *nameLookup) ([]handedItem, error) {
	f := listenFilter(who.feed(), scope, own)
	f.After, f.OnlyAudience, f.Types, f.ScopeType, f.ScopeID, f.Limit = ev.Seq, who.member.UserID, []string{"notification.created"}, ev.ScopeType, ev.ScopeID, batchLength
	evs, err := who.readFeed(ctx, f)
	if err != nil {
		return nil, err
	}
	out := []handedItem{}
	for _, later := range evs {
		item, err := who.handed(ctx, later, names)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

// runnerHold is what Quadit's runner says of itself with a hold of its
// listener: its machine, folder and program, the program's version, and
// why it holds every item back for now (core.Pause*, "" for nothing) and,
// for a usage limit, until when (Unix ms).
type runnerHold struct {
	engine.Runner
	version     string
	paused      string
	pausedUntil int64
}

var programVersionForm = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,32}$`)

// pauses are the reasons a runner holds its items back.
var pauses = []string{core.PauseUsageLimit, core.PauseNotSignedIn, core.PauseProgramMissing, core.PauseFolderMissing, core.PauseLoginMismatch, core.PauseServerOld}

// runnerHoldOf reads a runner's parameters of GET /listen: none for a hold
// that is not a runner's, and whether the hold asks for a batch, which only
// a runner does.
func runnerHoldOf(v url.Values) (*runnerHold, bool, error) {
	batch := truthyParam(v, "batch")
	if v.Get("machine_id") == "" {
		for _, name := range []string{"machine_name", "folder", "program", "program_version", "paused", "paused_until", "batch"} {
			if v.Has(name) {
				return nil, false, &engine.Error{Code: engine.CodeInvalid, Field: "machine_id", Message: name + "= is said by Quadit's runner, which names its machine with machine_id="}
			}
		}
		return nil, false, nil
	}
	r := &runnerHold{Runner: engine.Runner{MachineID: v.Get("machine_id"), MachineName: v.Get("machine_name"), Folder: v.Get("folder"), Program: v.Get("program")},
		version: v.Get("program_version"), paused: v.Get("paused")}
	if err := r.Check(); err != nil {
		return nil, false, err
	}
	if r.version != "" && !programVersionForm.MatchString(r.version) {
		return nil, false, &engine.Error{Code: engine.CodeInvalid, Field: "program_version", Message: "program_version is the program's version: 1 to 32 letters, digits, dots, + and -"}
	}
	if r.paused != "" && !slices.Contains(pauses, r.paused) {
		return nil, false, &engine.Error{Code: engine.CodeInvalid, Field: "paused", Message: fmt.Sprintf("unknown pause %q", r.paused), Allowed: pauses}
	}
	if until := v.Get("paused_until"); until != "" {
		n, err := strconv.ParseInt(until, 10, 64)
		if err != nil || n <= 0 || r.paused != core.PauseUsageLimit {
			return nil, false, &engine.Error{Code: engine.CodeInvalid, Field: "paused_until", Message: "paused_until is when a usage limit resets, in Unix milliseconds, with paused=usage_limit"}
		}
		r.pausedUntil = n
	}
	return r, batch, nil
}

// mark is the columns of a listener a hold writes of what holds it: a
// runner's hold sets the runner's mark and that the lease is the runner's;
// any other leaves the mark and says the lease is not.
func (r *runnerHold) mark(now int64) map[string]any {
	if r == nil {
		return map[string]any{"runner_holds": false}
	}
	return map[string]any{"machine_id": r.MachineID, "machine_name": r.MachineName, "runner_folder": r.Folder, "runner_program": r.Program,
		"runner_version": r.version, "runner_paused": r.paused, "runner_paused_until": r.pausedUntil, "runner_seen_at": now, "runner_holds": true}
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
// listener takes over the queue's items of its project, from that cursor,
// or past the item that listener holds in hand (handed out, past its
// cursor) when that item is of the project. With no live listener of
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
	if there && everything.LeaseLives(now.UnixMilli()) {
		start = queue.Seq
		if everything.HandedSeq > queue.Seq {
			var inHand core.Event
			if err := tx.Get(ctx, &inHand, store.Eq("seq", everything.HandedSeq)); err != nil {
				return err
			}
			if inHand.ProjectID == projectID {
				start = inHand.Seq
			}
		}
	}
	return tx.Advance(ctx, core.Cursor{WorkspaceID: who.ws.ID, UserID: who.member.UserID, Name: core.ListenCursorOf(projectID), Seq: start, UpdatedAt: now.UnixMilli()},
		"seq", "workspace_id", "user_id", "name")
}

// leaseAsk is what a wait asks of the lease: the id it holds (or none),
// whether to take it from another session, and what it is, in words a
// person reads, for whoever asks what listens; and for Quadit's runner,
// what it says of itself.
type leaseAsk struct {
	lease  string
	take   bool
	by     string
	runner *runnerHold
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
		live := held.LeaseLives(now.UnixMilli())
		switch {
		case live && ask.lease == held.Lease:
		case live && !ask.take:
			return listeningElsewhere(x.member, held, project.Key)
		case ask.lease == "" || ask.lease != held.Lease:
			lease = randomCode(leaseLength)
		}
		row := core.Listener{WorkspaceID: x.ws.ID, AgentID: agentID, ProjectID: project.ID, Lease: lease,
			LeaseUntil: now.Add(wait + leaseLife).UnixMilli(), HeardAt: now.UnixMilli(), HeldBy: ask.by}
		set := ask.runner.mark(now.UnixMilli())
		set["lease"], set["lease_until"], set["heard_at"], set["held_by"] = row.Lease, row.LeaseUntil, row.HeardAt, row.HeldBy
		if !found {
			// A new listener is made, then written as every hold writes it.
			if err := tx.Insert(ctx, row); err != nil {
				return err
			}
			if project.ID != "" {
				if err := x.startProjectListener(ctx, tx, listeners, project.ID, now); err != nil {
					return err
				}
			}
			listeners = append(listeners, row)
		}
		if _, err := tx.Update(ctx, "listeners", set, listenerOf(agentID, project.ID)...); err != nil {
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
// said, when it was last heard, whether its lease lives, and what Quadit's
// runner said of itself, when one marked it.
type listenerShown struct {
	ProjectID string       `json:"project_id,omitempty"`
	Project   string       `json:"project,omitempty"`
	By        string       `json:"by,omitempty"`
	LastHeard string       `json:"last_heard,omitempty"`
	Live      bool         `json:"live"`
	Runner    *runnerShown `json:"runner,omitempty"`
}

// runnerShown is a runner listener's mark as it is told: the machine, the
// folder's label and the program; whether the runner holds the lease now
// (a chat may, or the runner may be away since it was last heard); why it
// holds every item back, and until when; and the task it works on, of the
// listener's project.
type runnerShown struct {
	Machine        string `json:"machine"`
	Folder         string `json:"folder"`
	Program        string `json:"program"`
	ProgramVersion string `json:"program_version"`
	Holding        bool   `json:"holding"`
	Since          string `json:"since"`
	Paused         string `json:"paused,omitempty"`
	PausedUntil    string `json:"paused_until,omitempty"`
	Task           string `json:"task,omitempty"`
}

// listenerReads is what telling listeners reads besides them: the keys of
// the projects the viewer may read, by id (readableProjectKeys), and the
// task each runner works on there now.
type listenerReads struct {
	keys    map[string]string
	working map[runnerAt]string // the key of the task of the newest open run
}

// runnerAt is one agent's runner on one machine, for one project.
type runnerAt struct {
	agent, machine, project string
}

// listenerReads reads them.
func (who *viewer) listenerReads(ctx context.Context) (listenerReads, error) {
	keys, err := who.readableProjectKeys(ctx)
	if err != nil {
		return listenerReads{}, err
	}
	reads := listenerReads{keys: keys, working: map[runnerAt]string{}}
	runs, tasks, err := who.openRuns(ctx, nil)
	if err != nil {
		return reads, err
	}
	for _, run := range runs {
		t := tasks[run.TaskID]
		at := runnerAt{agent: run.AgentID, machine: run.MachineID, project: t.ProjectID}
		if _, seen := reads.working[at]; !seen {
			reads.working[at] = t.Key
		}
	}
	return reads, nil
}

// openRuns are the runs Quadit's runners have open (waiting or running),
// newest first, on tasks the viewer may read, of the projects given (nil:
// of every project), with those tasks by id.
func (who *viewer) openRuns(ctx context.Context, projects []string) ([]core.AgentSession, map[string]core.Task, error) {
	var runs []core.AgentSession
	if err := who.db.List(ctx, &runs, store.Q{Where: []store.Cond{store.In("state", []string{core.AgentSessionWaiting, core.AgentSessionRunning}),
		store.Ne("machine_id", "")}, Order: "-started_at,id"}); err != nil {
		return nil, nil, err
	}
	var ids []string
	for _, run := range runs {
		ids = append(ids, run.TaskID)
	}
	byID := map[string]core.Task{}
	if len(ids) == 0 {
		return nil, byID, nil
	}
	f := who.readable(store.TaskFilter{IDs: ids, Archived: true, Limit: maxTasksByID})
	if projects != nil {
		f.ProjectIDs = projects // and each is held to canProject below
	}
	tasks, err := who.db.Tasks(ctx, f)
	if err != nil {
		return nil, nil, err
	}
	for _, t := range tasks {
		if who.canProject(t.ProjectID) {
			byID[t.ID] = t
		}
	}
	return keep(runs, func(run core.AgentSession) bool { _, ok := byID[run.TaskID]; return ok }), byID, nil
}

// shown is the listeners as they are told, the listener of everything
// first, then by project key. A listener of a project the viewer may not
// read is left out. Never nil.
func shown(ls agentListeners, reads listenerReads, now time.Time) []listenerShown {
	out := []listenerShown{}
	for _, l := range ls {
		key, readable := reads.keys[l.ProjectID]
		if !readable && l.ProjectID != "" {
			continue
		}
		one := listenerShown{ProjectID: l.ProjectID, Project: key, By: l.HeldBy, LastHeard: formatTime(l.HeardAt), Live: l.LeaseLives(now.UnixMilli())}
		if l.MachineID != "" {
			one.Runner = &runnerShown{Machine: l.MachineName, Folder: l.RunnerFolder, Program: l.RunnerProgram, ProgramVersion: l.RunnerVersion,
				Holding: l.HeldByRunner(now.UnixMilli()), Since: formatTime(l.RunnerSeenAt), Paused: l.RunnerPaused, PausedUntil: formatTime(l.RunnerPausedUntil),
				Task: reads.working[runnerAt{agent: l.AgentID, machine: l.MachineID, project: l.ProjectID}]}
		}
		out = append(out, one)
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
// webhook is heard for it, among the projects the viewer may read.
func reachOf(ls agentListeners, pushed bool, reads listenerReads, now time.Time) listenersReach {
	r := listenersReach{Listeners: shown(ls, reads, now), ListeningProjects: []string{}, ListeningOutsideProjects: pushed || ls.hears("", now)}
	for _, project := range slices.Sorted(maps.Keys(reads.keys)) {
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
	reads, err := x.listenerReads(x.ctx())
	if err != nil {
		return err
	}
	now := time.Now()
	everything, _ := listeners.of("")
	out := map[string]any{"listening": everything.LeaseLives(now.UnixMilli()), "listeners": shown(listeners, reads, now)}
	if out["listening"] == true {
		out["by"], out["last_heard"] = everything.HeldBy, formatTime(everything.HeardAt)
	}
	return x.ok(out)
}

// handleReleaseRunner lets a machine's runner go from the caller's
// listener of a project: what a runner does when the person removes the
// project from it. Only the machine that marked the listener can clear its
// mark, and the lease is ended only when that runner holds it: a chat that
// holds it keeps it.
func (s *Server) handleReleaseRunner(x *c) error {
	if x.member.Kind != core.KindAgent {
		return errForbidden("this login is @%s's, a person's, not an agent's: a runner listens with the agent's own login", x.member.Handle)
	}
	machine := x.r.URL.Query().Get("machine_id")
	if err := engine.CheckMachineID(machine); err != nil {
		return err
	}
	project, err := x.listenProject(x.ctx(), x.r.PathValue("key"))
	if err != nil {
		return err
	}
	if project.ID == "" {
		return &engine.Error{Code: engine.CodeInvalid, Field: "key", Message: "a runner listens to one project: name it"}
	}
	dry := truthyParam(x.r.URL.Query(), "dry_run")
	released := false
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		listeners, err := listenersOf(x.ctx(), tx, x.member.UserID)
		if err != nil {
			return err
		}
		held, there := listeners.of(project.ID)
		if !there || held.MachineID != machine {
			return nil
		}
		released = true
		if dry {
			return nil
		}
		now := time.Now().UnixMilli()
		set := map[string]any{"machine_id": "", "machine_name": "", "runner_folder": "", "runner_program": "", "runner_version": "", "runner_paused": "",
			"runner_paused_until": int64(0), "runner_seen_at": int64(0), "runner_holds": false}
		ends := held.HeldByRunner(now)
		if ends {
			set["lease_until"] = now
		}
		if _, err := tx.Update(x.ctx(), "listeners", set, listenerOf(x.member.UserID, project.ID)...); err != nil || !ends {
			return err
		}
		// The member listens on until the last of its other leases ends.
		until := now
		for _, l := range listeners {
			if l.ProjectID != project.ID {
				until = max(until, l.LeaseUntil)
			}
		}
		_, err = tx.Update(x.ctx(), "members", map[string]any{"listening_until": until}, store.Eq("user_id", x.member.UserID))
		return err
	})
	if err != nil {
		return err
	}
	out := map[string]any{"project": project.Key, "released": released}
	if dry {
		out["dry_run"] = true
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
		if held.LeaseLives(time.Now().UnixMilli()) {
			return listeningElsewhere(x.member, held, project.Key)
		}
		forgotten = true
		if dry {
			return nil
		}
		if _, err := tx.Delete(x.ctx(), "listeners", listenerOf(x.member.UserID, project.ID)...); err != nil {
			return err
		}
		if _, err := tx.Delete(x.ctx(), "cursors", store.Eq("user_id", x.member.UserID), store.Eq("name", core.ListenCursorOf(project.ID))); err != nil {
			return err
		}
		// From now on: the listener of everything takes the project's items
		// from the present, so nothing either acknowledged comes again, and
		// what was pending for either stays unread in the inbox.
		return tx.Advance(x.ctx(), core.Cursor{WorkspaceID: x.ws.ID, UserID: x.member.UserID, Name: core.ListenCursor, Seq: tx.Seq(), UpdatedAt: time.Now().UnixMilli()},
			"seq", "workspace_id", "user_id", "name")
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
