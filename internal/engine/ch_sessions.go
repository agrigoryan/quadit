// session.start, session.update and session.stop: the record of an agent's
// runs of work. A session is recorded either by the agent itself, by hand,
// which may say what it likes of it; or by Quadit's runner on the agent's
// computer, which starts the agent's program for a task (a run: the row has
// a machine_id), and whose row follows the run's states (waiting, running,
// and how it ended) with the reason each one takes.

package engine

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("session.start", core.RoleMember, sessionStart)
	register("session.update", core.RoleMember, sessionUpdate)
	register("session.stop", core.RoleMember, sessionStop)
}

// The reasons a run's state takes: a waiting run may say why it waits, a
// run that did not start or failed must say why, and the others say
// nothing.
var runReasons = map[string][]string{
	core.AgentSessionWaiting:    {"", core.RunFolderBusy, core.RunSessionOpen},
	core.AgentSessionRunning:    {""},
	core.AgentSessionDone:       {""},
	core.AgentSessionStopped:    {""},
	core.AgentSessionNotStarted: {core.RunNotResponsible, core.RunNoResponsible, core.RunCapped, core.RunNoProgress, core.RunOpenElsewhere},
	core.AgentSessionFailed: {core.RunStartFailed, core.RunProgramError, core.RunIdle, core.RunTimeLimit, core.RunInterrupted,
		core.RunUsageLimit, core.RunNotSignedIn},
}

// runMoves are the states an open run may move to. Every other state ends
// it, and an ended run never changes state again.
var runMoves = map[string][]string{
	core.AgentSessionWaiting: {core.AgentSessionRunning, core.AgentSessionFailed, core.AgentSessionStopped},
	core.AgentSessionRunning: {core.AgentSessionDone, core.AgentSessionFailed, core.AgentSessionStopped},
}

// What a runner's record keeps of the steps of a run: the newest
// runStepsKept, each text cut to runStepText characters, at most
// runStepsPerUpdate sent at once.
const (
	runStepsKept      = 200
	runStepsPerUpdate = 50
	runStepText       = 200
)

// openRun reports whether a run's state is open: it waits or runs.
func openRun(state string) bool {
	return state == core.AgentSessionWaiting || state == core.AgentSessionRunning
}

type sessionStartArgs struct {
	ID           string `json:"id"`
	Task         string `json:"task"`
	Title        string `json:"title"`
	Instructions string `json:"instructions"` // what the run was asked to do
	// A run Quadit's runner starts on the agent's computer gives program,
	// machine_id, machine_name, folder and lease together, with state
	// (waiting, or not_started with its reason), the head item's feed
	// position, and the program's session id when it is chosen already.
	State          string `json:"state"`
	Reason         string `json:"reason"`
	Program        string `json:"program"`
	ProgramSession string `json:"program_session"`
	MachineID      string `json:"machine_id"`
	MachineName    string `json:"machine_name"`
	Folder         string `json:"folder"`
	Lease          string `json:"lease"` // the lease of the agent's listener of the task's project: checked, not kept
	ItemSeq        int64  `json:"item_seq"`
}

// sessionStart records that an agent started a run of work, on a task or
// not; or, from Quadit's runner, that it received an item and will start
// the agent's program for it (waiting) or will not (not_started).
func sessionStart(c *cx, a sessionStartArgs) error {
	sid, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	s := core.AgentSession{ID: sid, WorkspaceID: c.ws, AgentID: c.actor.UserID, Title: a.Title, Instructions: a.Instructions,
		State: core.AgentSessionRunning, StartedAt: c.at, UpdatedSeq: seq}
	where, key := inWorkspace(c.ws), ""
	if a.Task != "" {
		t, err := c.task("task", a.Task)
		if err != nil {
			return err
		}
		s.TaskID, where, key = t.ID, inTask(t), t.Key
		if s.Title == "" {
			s.Title = t.Title
		}
		if err := c.startRun(&s, a, t); err != nil {
			return err
		}
	} else if err := startByHand(a); err != nil {
		return err
	}
	if err := c.tx.Insert(c.ctx, s); err != nil {
		return alreadyInUse(err, "id", sid)
	}
	c.ref = s.ID
	return c.emit(event{seq: seq, typ: "session.created", entity: "session", entityID: s.ID, place: where, data: core.EventData{Row: s, Key: &key}})
}

// startByHand refuses what only a runner's run has on a session an agent
// records itself, and a runner's run with no task.
func startByHand(a sessionStartArgs) error {
	if a.Program != "" || a.MachineID != "" || a.MachineName != "" || a.Folder != "" || a.Lease != "" {
		return invalid("task", "a run Quadit's runner starts is on a task: give task")
	}
	if field := firstGiven([]given{{"state", a.State != ""}, {"reason", a.Reason != ""}, {"program_session", a.ProgramSession != ""}, {"item_seq", a.ItemSeq != 0}}); field != "" {
		return invalid(field, "%s is said only of a run Quadit's runner starts", field)
	}
	return nil
}

// given is whether an argument was given, by its name.
type given struct {
	field string
	is    bool
}

// firstGiven is the name of the first argument given, or "".
func firstGiven(args []given) string {
	for _, a := range args {
		if a.is {
			return a.field
		}
	}
	return ""
}

// startRun fills in a run that Quadit's runner starts on task t, when the
// arguments say it is one. The runner must hold the agent's listener of
// the task's project with the lease it gives, and a run that will start
// (waiting) must be the agent's only open run on the task: both are read
// in this change's transaction, so two runners, or a runner and a chat that
// took the project over, never both start the agent on it.
func (c *cx) startRun(s *core.AgentSession, a sessionStartArgs, t core.Task) error {
	if a.Program == "" && a.MachineID == "" && a.MachineName == "" && a.Folder == "" && a.Lease == "" {
		return startByHand(a)
	}
	if a.Program == "" || a.MachineID == "" || a.MachineName == "" || a.Folder == "" || a.Lease == "" {
		return invalid("machine_id", "program, machine_id, machine_name, folder and lease come together: they say which runner started the run")
	}
	if c.actor.Kind != core.KindAgent {
		return forbidden("a run is recorded by the agent's own login")
	}
	r := Runner{MachineID: a.MachineID, MachineName: a.MachineName, Folder: a.Folder, Program: a.Program}
	if err := r.Check(); err != nil {
		return err
	}
	if a.State != core.AgentSessionWaiting && a.State != core.AgentSessionNotStarted {
		return oneOf("state", "state of a run as it starts", a.State, []string{core.AgentSessionWaiting, core.AgentSessionNotStarted})
	}
	if err := reasonFits(a.State, a.Reason); err != nil {
		return err
	}
	if a.ProgramSession != "" && !id.Valid(a.ProgramSession) {
		return invalid("program_session", "program_session is the program's own session id: a lower-case UUID")
	}
	var l core.Listener
	held, err := store.Find(c.ctx, c.tx, &l, store.Eq("agent_id", c.actor.UserID), store.Eq("project_id", t.ProjectID), store.Eq("lease", a.Lease))
	if err != nil {
		return err
	}
	if !held {
		return &Error{Code: CodeConflict, Field: "lease", Reason: ReasonLeaseStale,
			Message: fmt.Sprintf("lease %s is no longer @%s's listener of %s's project: another session took the project over, and the item is that one's now", a.Lease, c.actor.Handle, t.Key)}
	}
	if a.State == core.AgentSessionWaiting {
		var open []core.AgentSession
		if err := c.tx.List(c.ctx, &open, store.Q{Where: []store.Cond{store.Eq("agent_id", c.actor.UserID), store.Eq("task_id", t.ID),
			store.In("state", []string{core.AgentSessionWaiting, core.AgentSessionRunning}), store.Ne("machine_id", "")}, Limit: 1}); err != nil {
			return err
		}
		if len(open) > 0 {
			return &Error{Code: CodeConflict, Field: "task", Reason: ReasonRunOpen,
				Message: fmt.Sprintf("@%s already has a run open on %s, on %s (run %s)", c.actor.Handle, t.Key, open[0].MachineName, open[0].ID)}
		}
	}
	s.State, s.Reason, s.Program, s.ProgramSession, s.ItemSeq = a.State, a.Reason, r.Program, a.ProgramSession, a.ItemSeq
	s.MachineID, s.MachineName, s.Folder = r.MachineID, r.MachineName, r.Folder
	if s.State == core.AgentSessionNotStarted {
		s.EndedAt = s.StartedAt
	}
	return nil
}

// reasonFits refuses a reason that is not one the state takes.
func reasonFits(state, reason string) error {
	allowed := runReasons[state]
	if slices.Contains(allowed, reason) {
		return nil
	}
	if reason == "" {
		return &Error{Code: CodeInvalid, Field: "reason", Message: fmt.Sprintf("a run that is %s says why", state), Allowed: allowed}
	}
	return &Error{Code: CodeInvalid, Field: "reason", Message: fmt.Sprintf("%q is not a reason a run that is %s gives", reason, state), Allowed: slices.DeleteFunc(slices.Clone(allowed), func(r string) bool { return r == "" })}
}

type sessionUpdateArgs struct {
	ID      string      `json:"id" quadit:"required"`
	Title   Opt[string] `json:"title"`
	Summary Opt[string] `json:"summary"`
	// State: running, done, failed or stopped; a runner's run also waiting.
	// Anything but waiting and running ends the session.
	State Opt[string] `json:"state"`
	// AddSteps appends to what the run did, in order: on a runner's run,
	// objects {tool, text, at}, at most 50 at once, the newest 200 kept.
	AddSteps []json.RawMessage `json:"add_steps"`
	// AddLinks appends commits, files or URLs the run produced.
	AddLinks []json.RawMessage `json:"add_links"`
	// What only a runner's run says: why it waits, did not start or failed;
	// the program's session id (a new one only with fresh, after the old one
	// was lost); the last item its program took, with the move to running;
	// and when a usage limit resets (ms).
	Reason         Opt[string] `json:"reason"`
	ProgramSession Opt[string] `json:"program_session"`
	Fresh          bool        `json:"fresh"`
	ItemsThrough   Opt[int64]  `json:"items_through"`
	ResetsAt       Opt[int64]  `json:"resets_at"`
}

// sessionUpdate records how an agent's run goes: its state, steps and
// links. New steps and links are appended: the event carries them alone.
func sessionUpdate(c *cx, a sessionUpdateArgs) error {
	s, err := loadLive[core.AgentSession](c, "session", "id", a.ID)
	if err != nil {
		return err
	}
	if s.AgentID != c.actor.UserID && !c.system {
		return forbidden("a session is updated by the agent that started it")
	}
	p := newPatch()
	if s.MachineID != "" {
		err = c.updateRun(p, s, a)
	} else {
		err = c.updateByHand(p, s, a)
	}
	if err != nil {
		return err
	}
	p.setText("title", a.Title, &s.Title)
	p.setText("summary", a.Summary, &s.Summary)
	links, _, err := appendJSON(s.Links, a.AddLinks, 0)
	if err != nil {
		return err
	}
	p.appendTo("links", links, a.AddLinks)
	where := inWorkspace(c.ws)
	if s.TaskID != "" {
		var t core.Task
		ok, err := store.Find(c.ctx, c.tx, &t, store.Eq("id", s.TaskID))
		if err != nil {
			return err
		}
		if ok {
			where = inTask(t)
		}
	}
	return c.save(p, target{table: "agent_sessions", entity: "session", id: s.ID, place: where})
}

// updateByHand is the part of an update of a session an agent recorded
// itself: any of four states, and steps in any form, all kept.
func (c *cx) updateByHand(p *patch, s core.AgentSession, a sessionUpdateArgs) error {
	if field := firstGiven([]given{{"reason", a.Reason.Set}, {"program_session", a.ProgramSession.Set}, {"fresh", a.Fresh},
		{"items_through", a.ItemsThrough.Set}, {"resets_at", a.ResetsAt.Set}}); field != "" {
		return invalid(field, "%s is said only of a run Quadit's runner started", field)
	}
	if a.State.Set {
		states := []string{core.AgentSessionRunning, core.AgentSessionDone, core.AgentSessionFailed, core.AgentSessionStopped}
		if !slices.Contains(states, a.State.V) {
			return oneOf("state", "session state", a.State.V, states)
		}
		p.setText("state", a.State, &s.State)
		if s.State != core.AgentSessionRunning && s.EndedAt == 0 {
			p.put("ended_at", int64(0), c.at)
		}
	}
	steps, _, err := appendJSON(s.Steps, a.AddSteps, 0)
	if err != nil {
		return err
	}
	p.appendTo("steps", steps, a.AddSteps)
	return nil
}

// updateRun is the part of an update of a run Quadit's runner started: it
// moves through its states as a run does (runMoves), each with a reason it
// takes (runReasons); the server stamps when the program took the prompt;
// an ended run takes nothing more but links and a summary.
func (c *cx) updateRun(p *patch, s core.AgentSession, a sessionUpdateArgs) error {
	to := s.State
	if a.State.Set {
		if a.State.Null {
			return invalid("state", "a run always has a state")
		}
		to = a.State.V
	}
	if !openRun(s.State) {
		if to != s.State {
			return invalid("state", "this run ended: it cannot become %s", to)
		}
		if field := firstGiven([]given{{"title", a.Title.Set}, {"reason", a.Reason.Set}, {"program_session", a.ProgramSession.Set}, {"fresh", a.Fresh},
			{"items_through", a.ItemsThrough.Set}, {"resets_at", a.ResetsAt.Set}, {"add_steps", len(a.AddSteps) > 0}}); field != "" {
			return invalid(field, "this run ended: an update of it may only add links or a summary")
		}
		return nil
	}
	if to != s.State {
		if _, known := runReasons[to]; !known {
			return oneOf("state", "state of a run", to, []string{core.AgentSessionRunning, core.AgentSessionDone, core.AgentSessionFailed, core.AgentSessionStopped})
		}
		if !slices.Contains(runMoves[s.State], to) {
			return invalid("state", "a run that is %s cannot become %s: it runs only after it waited, and is done only after it ran", s.State, to)
		}
	}

	// A new state starts with no reason unless one is given with it.
	reason := s.Reason
	if to != s.State {
		reason = ""
	}
	if a.Reason.Set {
		reason = a.Reason.V
	}
	if err := reasonFits(to, reason); err != nil {
		return err
	}
	p.put("state", s.State, to)
	p.put("reason", s.Reason, reason)
	accepted := s.State == core.AgentSessionWaiting && to == core.AgentSessionRunning
	if accepted {
		p.put("accepted_at", int64(0), c.at)
	}
	if !openRun(to) {
		p.put("ended_at", int64(0), c.at)
	}

	// Coverage is known only once the program took the prompt.
	if a.ItemsThrough.Set {
		if !accepted || a.ItemsThrough.Null {
			return invalid("items_through", "items_through is written with the move to running, when the program took the prompt")
		}
		if a.ItemsThrough.V < s.ItemSeq {
			return invalid("items_through", "items_through is at least the run's own item, %d", s.ItemSeq)
		}
		p.put("items_through", s.ItemsThrough, a.ItemsThrough.V)
	}
	if a.ResetsAt.Set {
		if reason != core.RunUsageLimit || a.ResetsAt.Null {
			return invalid("resets_at", "resets_at goes with the reason usage_limit")
		}
		p.put("resets_at", s.ResetsAt, a.ResetsAt.V)
	}

	// The program's own session: chosen once (Codex says it only as it
	// starts), and replaced only for a fresh one after it was lost.
	switch {
	case a.ProgramSession.Set:
		v := a.ProgramSession.V
		if a.ProgramSession.Null || !id.Valid(v) {
			return invalid("program_session", "program_session is the program's own session id: a lower-case UUID")
		}
		if s.ProgramSession != "" && s.ProgramSession != v && !a.Fresh {
			return invalid("program_session", "this run's program session is %s: another is given only with fresh, after it was lost", s.ProgramSession)
		}
		p.put("program_session", s.ProgramSession, v)
	case a.Fresh:
		return invalid("fresh", "fresh goes with the new program_session")
	}

	if len(a.AddSteps) > runStepsPerUpdate {
		return invalid("add_steps", "at most %d steps at once", runStepsPerUpdate)
	}
	added := make([]json.RawMessage, len(a.AddSteps))
	for i, raw := range a.AddSteps {
		step, err := runStep(raw)
		if err != nil {
			return withIndex(i, err)
		}
		added[i] = step
	}
	steps, dropped, err := appendJSON(s.Steps, added, runStepsKept)
	if err != nil {
		return err
	}
	p.appendTo("steps", steps, added)
	if dropped > 0 {
		p.put("steps_dropped", s.StepsDropped, s.StepsDropped+dropped)
	}
	return nil
}

// runStep is one step of a runner's run as it is kept: the tool, what the
// program said the call does, cut to runStepText characters, and when.
func runStep(raw json.RawMessage) (json.RawMessage, *Error) {
	var step struct {
		Tool string `json:"tool"`
		Text string `json:"text,omitempty"`
		At   int64  `json:"at,omitempty"`
	}
	if err := json.Unmarshal(raw, &step); err != nil || strings.TrimSpace(step.Tool) == "" {
		return nil, invalid("add_steps", "a step of a run is an object {tool, text, at}, with the tool's name")
	}
	if utf8.RuneCountInString(step.Text) > runStepText {
		step.Text = string([]rune(step.Text)[:runStepText-1]) + "…"
	}
	out, err := json.Marshal(step)
	if err != nil {
		return nil, invalid("add_steps", "%v", err)
	}
	return out, nil
}

// appendJSON adds items to the end of a JSON list kept in a row and, with
// keep above 0, drops its oldest past keep, saying how many it dropped.
func appendJSON(cur json.RawMessage, add []json.RawMessage, keep int) (json.RawMessage, int, error) {
	var list []json.RawMessage
	if len(cur) > 0 {
		if err := json.Unmarshal(cur, &list); err != nil {
			return nil, 0, err
		}
	}
	list = append(list, add...)
	dropped := 0
	if keep > 0 && len(list) > keep {
		dropped = len(list) - keep
		list = list[dropped:]
	}
	all, err := json.Marshal(list)
	return all, dropped, err
}

type sessionStopArgs struct {
	ID string `json:"id" quadit:"required"`
}

// sessionStop asks a run Quadit's runner started to stop. Any member who
// may change the run's task may: the role and the credential are checked
// for every change, and the task's project here, before anything else, so
// that a stop that changes nothing is refused all the same. A run whose
// runner holds the project is asked, and the runner ends it; one whose
// runner does not (away, let go, or a chat took the project) is ended at
// once, since nothing would ever act on the request. A run that ended, or
// was asked already, is left as it is.
func sessionStop(c *cx, a sessionStopArgs) error {
	s, err := loadLive[core.AgentSession](c, "session", "id", a.ID)
	if err != nil {
		return err
	}
	if s.MachineID == "" || s.TaskID == "" {
		return invalid("id", "this session was not started by Quadit, so Quadit cannot stop it")
	}
	t, err := c.task("id", s.TaskID)
	if err != nil {
		return err
	}
	if !c.system && len(c.scope.Projects) > 0 && !slices.Contains(c.scope.Projects, t.ProjectID) {
		return forbidden("your access does not include this project")
	}
	c.ref = s.ID
	if !openRun(s.State) || s.StopRequestedAt != 0 {
		return nil
	}
	p := newPatch()
	p.put("stop_requested_at", int64(0), c.at)
	p.put("stop_requested_by", "", c.actor.UserID)
	var l core.Listener
	there, err := store.Find(c.ctx, c.tx, &l, store.Eq("agent_id", s.AgentID), store.Eq("project_id", t.ProjectID))
	if err != nil {
		return err
	}
	if !there || l.MachineID != s.MachineID || !l.HeldByRunner(c.at) {
		p.put("state", s.State, core.AgentSessionStopped)
		p.put("reason", s.Reason, "")
		p.put("ended_at", int64(0), c.at)
	}
	return c.save(p, target{table: "agent_sessions", entity: "session", id: s.ID, place: inTask(t)})
}
