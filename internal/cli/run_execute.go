// One run, step by step: received and recorded on the server before
// anything starts; the folder and the program's session free; the program
// started, again only before any work; watched beside it for a stop, a
// lease lost, silence; and ended with a terminal record in the outbox that
// says what happens to its head.

package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
)

// agentRun is one run: one start of the program for one head item and
// the items its prompt carried, from its session.start to its terminal
// record.
type agentRun struct {
	e          *liveEntry
	id         string
	key        string       // the task's key
	items      []listenItem // the head, then the other items its prompt carries
	lease      string
	continuing bool // the head was kept to be continued
	received   time.Time

	stopAsked, leaseGone chan struct{}
	stopOnce, leaseOnce  sync.Once
	accessLost           atomic.Bool // the lease went because the login was refused (401, 403)

	mu           sync.Mutex
	j            journal
	accepted     bool
	toolActivity bool
	session      string // the program session: Claude Code's chosen one, Codex's said one
	sentSession  string // the program_session the server was told
	fresh        bool   // the next program_session told is a fresh one after a lost one
	steps        []step // steps not queued yet
}

// runEnding is how a run ends: its row's state and reason, what its program
// said last, whether its head is acknowledged, and the line printed.
type runEnding struct {
	state, reason string
	resetsAt      time.Time
	final         string
	summary       string
	ack           bool
	line          string
}

// attemptEnd is what ended an attempt besides its program ending itself.
type attemptEnd int

const (
	endedItself attemptEnd = iota
	endedByStop
	endedIdle
	endedTimeLimit
	endedInfra      // the runner stopping, or the entry removed
	endedLeaseLost  // a chat or another machine took the project, or the login lost its access
	endedNotStarted // the program was not started: its launch could not be written down
	endedUnrecorded // the program started, but what recognizes it could not be written down: it was stopped at once
	endedMoved      // not started: the folder or the program is no longer the one checked (Detail: the pause)
)

// errStartBlocked is a run's start the server refused for good.
var errStartBlocked = errors.New("the server refused to record a run")

// run runs the program for the head (items[0]) and the items after it,
// then acknowledges or keeps the head as the end says. It returns an
// error only when the server refused for good to record the run: the
// entry then waits before it tries again.
func (e *liveEntry) run(ctx context.Context, items []listenItem, continuing bool) error {
	head := items[0]
	r := &agentRun{e: e, id: newRunID(), key: head.Task, items: items, lease: e.lease, continuing: continuing,
		received: e.srv.host.clock.Now(), stopAsked: make(chan struct{}), leaseGone: make(chan struct{})}
	prompted := make([]int64, len(items))
	for i, item := range items {
		prompted[i] = item.Seq
	}
	r.j = journal{Run: r.id, Task: r.key, Head: journalHead{Seq: head.Seq, Item: head.ID}, Prompted: prompted, Lease: r.lease,
		Phase: phaseReceived, Automatic: head.ByAgent, Ordinals: map[string]int{}}
	if err := writeJournal(e.dir, r.j); err != nil {
		return err
	}
	from := "from " + head.By
	if !handleForm.MatchString(head.By) {
		from = "from someone"
	}
	e.sayRun(r.key, "received #%d (%s %s)", head.Seq, head.Type, from)
	e.setStatus(entryStatus{State: statusWorking, Task: r.key, Since: r.received})

	task := e.state.task(r.key)
	resume := ""
	if id.Valid(task.Session) {
		resume = task.Session
	}
	r.session = resume
	if e.prog.Name() == core.ProgramClaude && resume == "" {
		r.session = id.New()
	}

	startSeq, err := r.start(ctx)
	if err != nil || startSeq == 0 {
		return err
	}
	r.mu.Lock()
	r.j.StartSeq = startSeq
	_ = r.saveJournal() // not written: recovery finds the start in the server's row, not here; the launch's own write decides
	r.mu.Unlock()
	if head.ByAgent {
		_ = e.state.countStart(r.key, r.id, r.received) // not counted: the guards see one run fewer
	} else {
		_ = e.state.changeTask(r.key, func(t *taskState) { t.Quiet = nil }) // a person's item clears G4's count; not written, the next run's end counts again
	}

	helpers, stopHelpers := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Go(func() { r.watchStop(helpers, startSeq) })
	wg.Go(func() { r.renewLease(helpers) })
	wg.Go(func() { r.sendSteps(helpers) })
	end, folder := r.work(ctx, resume)
	stopHelpers()
	wg.Wait()
	return r.finish(ctx, end, folder)
}

// start records the run on the server (waiting) and waits until the
// server confirms it: nothing is started before. It gives the seq the
// server answered, 0 when the run is not to go on (its head then handled),
// or an error when the server refused it for good.
func (r *agentRun) start(ctx context.Context) (int64, error) {
	e, head := r.e, r.items[0]
	args := e.startArgs(r.id, head, core.AgentSessionWaiting)
	if n := len(r.items) - 1; n > 0 {
		args["instructions"] = fmt.Sprintf("%s and %d more items", head.line(), n)
	}
	if r.session != "" {
		args["program_session"] = r.session
		r.sentSession = r.session
	}
	startW := r.write(writeStart, &pendingChange{Type: "session.start", Args: args})
	if _, err := e.out.add(startW); err != nil {
		_ = clearJournal(e.dir) // nothing was sent: the head comes again
		e.sayRun(r.key, "not started: the run could not be kept on this computer (%v)", err)
		return 0, nil
	}
	away, retried := e.srv.host.times.awayFirst, false
	// given up drops the start (no row was made) and the journal; a start
	// that cannot be dropped stays to be sent, so the entry waits.
	givenUp := func(file string) error {
		if err := e.out.drop(file); err != nil {
			return fmt.Errorf("a run's start could not be taken back from the outbox: %w", err)
		}
		_ = clearJournal(e.dir) // the head comes again, and is decided again
		return nil
	}
	for {
		res, err := e.out.flush(ctx, e.api, startW.ChangeID)
		var refused *startRefused
		switch {
		case err == nil:
			return res.Seq, nil
		case errors.As(err, &refused) && refused.reason == "lease_stale":
			return 0, givenUp(refused.file) // the head goes to whoever holds the lease
		case errors.As(err, &refused) && refused.reason == "in_use":
			// The run exists already: go on from its row, never close it.
			if seq, ok := r.existing(ctx); ok {
				return seq, e.out.drop(refused.file)
			}
			return 0, givenUp(refused.file)
		case errors.As(err, &refused):
			// The start waits aside while the orphans are closed: it was
			// not applied, and is added again as it was (same id, same body).
			if err := e.out.drop(refused.file); err != nil {
				return 0, fmt.Errorf("a run's start could not be taken back from the outbox: %w", err)
			}
			closed, known := r.closeOrphans(ctx)
			if known && (!closed || retried) {
				_ = clearJournal(e.dir) // this run is not made: the item's not_started row stands for it
				e.notStarted(ctx, head, core.RunOpenElsewhere)
				return 0, nil
			}
			if !known {
				e.srv.wait(ctx, away) // who owns the open run is not known yet: ask again
				away = min(away*2, e.srv.host.times.awayMax)
			}
			retried = retried || closed
			if _, err := e.out.add(startW); err != nil {
				_ = clearJournal(e.dir) // nothing waits to be sent: the head comes again
				return 0, err
			}
		case errors.Is(err, errOutboxWaits):
			if ctx.Err() != nil {
				r.finish(ctx, runEnding{state: core.AgentSessionFailed, reason: core.RunInterrupted, summary: r.stoppedSummary(),
					line: "interrupted: Quadit stopped before this run started"}, nil)
				return 0, ctx.Err() // the entry ends: whoever ended it does not wait on this
			}
			e.srv.wait(ctx, away)
			away = min(away*2, e.srv.host.times.awayMax)
		default:
			_ = clearJournal(e.dir) // the write is kept in the outbox's failed folder and shown
			if ae, ok := refusalOf(err); ok && ae.Code == "forbidden" {
				return 0, errLoginRefused
			}
			return 0, fmt.Errorf("%w: %w", errStartBlocked, err)
		}
	}
}

// existing is where the feed stands now, for a run the server already
// holds that is still open: the run goes on from there (a stop asked
// earlier is found on its row before the program starts).
func (r *agentRun) existing(ctx context.Context) (int64, bool) {
	row, ok, err := r.e.api.runRowOf(ctx, r.key, r.id)
	if err != nil || !ok || ended(row.State) {
		return 0, false
	}
	seq, err := r.e.api.seqNow(ctx)
	return seq, err == nil && seq > 0
}

// closeOrphans ends the open runs of this agent on the task that this
// machine started and no journal holds (a run left by a crash, or whose
// end was refused): they would keep every later run from starting. It
// reports whether it closed any, and whether it knows: a failed read of
// the runs tells nothing (it is not "another machine's").
func (r *agentRun) closeOrphans(ctx context.Context) (closed, known bool) {
	e := r.e
	var orphans []string
	elsewhere := false
	err := e.api.eachRun(ctx, r.key, func(row runRow) bool {
		if row.AgentID != e.reg.AgentID || row.ID == r.id || (row.State != core.AgentSessionWaiting && row.State != core.AgentSessionRunning) {
			return false
		}
		if row.MachineID == e.srv.machineNow().ID {
			orphans = append(orphans, row.ID)
		} else {
			elsewhere = true
		}
		return false
	})
	if err != nil {
		return false, false
	}
	if elsewhere || len(orphans) == 0 {
		return false, true
	}
	for _, orphan := range orphans {
		// A close of an orphan is its own write, under its own id: never
		// the id of the run's own end, whose body could differ.
		args := map[string]any{"id": orphan, "state": core.AgentSessionFailed, "reason": core.RunInterrupted, "summary": r.stoppedSummary()}
		w := outboxWrite{Run: orphan, Task: r.key, Write: writeOrphanClose, ChangeID: changeID(orphan, writeOrphanClose, 0), Change: &pendingChange{Type: "session.update", Args: args}}
		if _, err := e.out.add(w); err != nil {
			return false, false
		}
	}
	return e.flush(ctx) == nil, true
}

// work is the run from the folder on: it takes the folder, waits for the
// session to be quiet, and starts the program, again while no work was
// done, until one of the ends of the contract's table applies. It gives
// that end, and the folder's lock for the caller to let go once the end
// is stored.
func (r *agentRun) work(ctx context.Context, resume string) (runEnding, *os.File) {
	folder, end := r.takeFolder(ctx)
	if folder == nil {
		return end, nil
	}
	if resume != "" {
		if end, ok := r.waitForQuietSession(ctx, resume); !ok {
			return end, folder
		}
	}
	return r.attempts(ctx, resume), folder
}

// attempts starts the program, again while no work was done, until one
// of the ends of the contract's table applies.
func (r *agentRun) attempts(ctx context.Context, resume string) runEnding {
	e := r.e
	t := e.srv.host.times
	lost := false
	for attempt := 1; ; attempt++ {
		if end, ok := r.endedYet(ctx); !ok {
			return end // the runner stopping, or the lease lost, between two attempts
		}
		if pause := e.checkFolderAndProgram(ctx); pause != "" {
			e.pauseEntry(pause)
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: " + pauseWords(pause, e.prog.Title(), time.Time{})}
		}
		if !e.loginUnchanged() {
			// The program would work as whatever login is at the path now:
			// it starts only with the login verified.
			e.halt(errLoginRefused)
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: the login file changed since it was verified"}
		}
		if p := e.state.pause(); p != nil {
			reason := core.RunStartFailed
			if p.Reason == core.PauseUsageLimit {
				reason = core.RunUsageLimit
			}
			return runEnding{state: core.AgentSessionFailed, reason: reason, resetsAt: time.UnixMilli(p.Until), line: "failed: " + pauseWords(p.Reason, e.prog.Title(), time.UnixMilli(p.Until))}
		}
		me, err := e.api.me(ctx)
		if err != nil || me.UserID != e.reg.AgentID {
			// Who the agent works for is read for each run: without it,
			// nothing starts (the run waits, or the login is checked again).
			if err == nil {
				e.halt(errLoginRefused)
				return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: the login is no longer the agent's"}
			}
			if end, ok := r.pauseWithin(ctx, e.srv.host.times.awayMax); !ok {
				return end
			}
			attempt--
			continue
		}
		prompt, err := buildPrompt(promptFacts{Agent: me.Handle, Owner: me.Responsible, Key: r.key, Run: r.id, Machine: e.srv.machineNow().Name,
			Folder: e.label, Program: e.prog.Title(), Items: r.items, Resuming: resume != "", Continue: r.continuing && resume != "", Lost: lost}, randomHex(6))
		if err != nil {
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, ack: true, line: "failed: " + err.Error()}
		}
		spec := runSpec{Resume: resume, Title: r.key, Folder: e.reg.Folder, Now: e.srv.host.clock.Now,
			LastMessageFile: filepath.Join(e.srv.files.runs(), fmt.Sprintf("%s-%d.last.txt", r.id, attempt))}
		if resume == "" && e.prog.Name() == core.ProgramClaude {
			spec.Session = r.session
		}
		// Right before the start, after every probe and wait: the run's row
		// read now (open, no stop asked), the lease still held.
		if end, ok := r.readyToStart(ctx); !ok {
			return end
		}
		if attempt == 1 || lost {
			e.sayRun(r.key, "running %s, %s, run %s", e.prog.Title(), r.sessionWords(resume), r.id)
		}
		out, how, err := r.attempt(ctx, spec, prompt, attempt)
		r.mu.Lock()
		accepted, tools := r.accepted, r.toolActivity
		r.mu.Unlock()
		switch {
		case how == endedNotStarted:
			e.halt(entryError("a run could not be written down on this computer: " + err.Error()))
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: " + err.Error()}
		case how == endedUnrecorded:
			// Never started again by itself: it may have done something.
			e.halt(entryError(err.Error()))
			return runEnding{state: core.AgentSessionFailed, reason: core.RunInterrupted, ack: true, line: "interrupted: " + err.Error(),
				summary: "Quadit stopped the program on " + e.srv.machineNow().Name + " at once: it could not keep what recognizes it."}
		case how == endedMoved:
			e.pauseEntry(out.Detail)
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: " + pauseWords(out.Detail, e.prog.Title(), time.Time{})}
		case how == endedByStop:
			return r.stoppedEnd(out.Final)
		case how == endedInfra:
			return runEnding{state: core.AgentSessionFailed, reason: core.RunInterrupted, summary: r.stoppedSummary(), ack: accepted,
				line: "interrupted: Quadit stopped while this run worked"}
		case how == endedLeaseLost:
			return r.leaseLostEnd("while this run worked")
		case out.Kind == outcomeUsageLimit:
			until := e.srv.pauseAgent(e.reg, out.ResetsAt)
			r.keepToContinue(accepted || tools)
			return runEnding{state: core.AgentSessionFailed, reason: core.RunUsageLimit, resetsAt: out.ResetsAt,
				line: fmt.Sprintf("failed: %s's usage limit; %s paused until %s", e.prog.Title(), e.me.Handle, until.Local().Format("15:04"))}
		case out.Kind == outcomeNotSignedIn:
			e.pauseEntry(core.PauseNotSignedIn)
			r.keepToContinue(accepted || tools)
			return runEnding{state: core.AgentSessionFailed, reason: core.RunNotSignedIn, line: "failed: " + pauseWords(core.PauseNotSignedIn, e.prog.Title(), time.Time{})}
		case how == endedIdle:
			return runEnding{state: core.AgentSessionFailed, reason: core.RunIdle, final: out.Final, ack: true,
				line: fmt.Sprintf("failed: %s printed nothing for %s, so Quadit stopped it", e.prog.Title(), t.idle)}
		case how == endedTimeLimit:
			return runEnding{state: core.AgentSessionFailed, reason: core.RunTimeLimit, final: out.Final, ack: true,
				line: fmt.Sprintf("failed: past its limit of %d minutes", e.reg.MaxMinutes)}
		case out.Kind == outcomeLostSession && !tools && !lost && attempt < 3:
			lost, resume = true, ""
			r.freshSession()
			continue
		case out.Kind == outcomeLostSession && !tools && lost:
			// The one fresh session was lost too: that is final.
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, ack: true,
				line: fmt.Sprintf("failed: %s lost its session twice on %s", e.prog.Title(), e.srv.machineNow().Name)}
		case out.Kind == outcomeOK:
			if !accepted {
				r.sawAccepted() // a turn that ended well was taken, whatever the output showed of it
			}
			return runEnding{state: core.AgentSessionDone, final: out.Final, ack: true, line: "done in " + duration(e.srv.host.clock.Now().Sub(r.received))}
		case tools:
			return runEnding{state: core.AgentSessionFailed, reason: core.RunProgramError, final: out.Final, ack: true,
				line: fmt.Sprintf("failed: %s failed after it began to work (%s)", e.prog.Title(), out.Detail)}
		case attempt < 3:
			wait := t.attemptWaits[min(attempt, len(t.attemptWaits))-1]
			if end, ok := r.pauseWithin(ctx, wait); !ok {
				return end
			}
		default:
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, ack: true,
				line: fmt.Sprintf("failed: %s did not start on %s (%s)", e.prog.Title(), e.srv.machineNow().Name, out.Detail)}
		}
	}
}

// readyToStart makes the last checks before the program is let go: the
// run's row read now, open and with no stop asked; the lease held (a short
// hold that answers with it); the run not ended meanwhile. A read that
// fails is tried again, the program never started without one.
func (r *agentRun) readyToStart(ctx context.Context) (runEnding, bool) {
	e := r.e
	away := e.srv.host.times.awayFirst
	for {
		if end, ok := r.endedYet(ctx); !ok {
			return end, false
		}
		row, found, err := e.api.runRowOf(ctx, r.key, r.id)
		if err == nil && found && (row.StopRequestedAt > 0 || ended(row.State)) {
			r.askStop()
			continue
		}
		if err == nil && !found {
			return runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: the server does not know this run"}, false
		}
		if err == nil {
			ask := e.holdAsk(time.Second, false)
			ask.lease = r.lease
			ans, holdErr := e.api.hold(ctx, ask)
			switch {
			case holdErr == nil && ans.Lease == r.lease:
				return r.endedYet(ctx)
			case holdErr == nil, leaseLost(holdErr), accessRefused(holdErr):
				r.loseLease()
				continue
			}
		}
		if end, ok := r.pauseWithin(ctx, away); !ok {
			return end, false
		}
		away = min(away*2, e.srv.host.times.awayMax)
	}
}

// endNow is what ends an attempt that is about to start, if anything has:
// a stop asked, the lease lost, the runner stopping.
func (r *agentRun) endNow(ctx context.Context) attemptEnd {
	switch {
	case r.stopped():
		return endedByStop
	case chanClosed(r.leaseGone):
		return endedLeaseLost
	case ctx.Err() != nil:
		return endedInfra
	}
	return endedItself
}

// leaseLostEnd is the end of a run whose lease went to another session,
// or whose login lost its access: interrupted, the head not acknowledged.
func (r *agentRun) leaseLostEnd(when string) runEnding {
	if r.accessLost.Load() {
		return runEnding{state: core.AgentSessionFailed, reason: core.RunInterrupted, summary: "The agent's login was refused " + when + ".",
			line: "interrupted: the agent's login was refused"}
	}
	return runEnding{state: core.AgentSessionFailed, reason: core.RunInterrupted, summary: "A chat or another computer took " + r.e.projectKey + " over " + when + ".",
		line: "interrupted: a chat took " + r.e.projectKey + " over"}
}

// ended reports whether a run's state is an ended one.
func ended(state string) bool {
	return state != "" && state != core.AgentSessionWaiting && state != core.AgentSessionRunning
}

// stoppedEnd is the end of a run a member asked to stop.
func (r *agentRun) stoppedEnd(final string) runEnding {
	return runEnding{state: core.AgentSessionStopped, final: final, ack: true, line: "stopped: a member asked it to stop"}
}

// stoppedSummary says the runner stopped while the run worked.
func (r *agentRun) stoppedSummary() string {
	return "Quadit stopped on " + r.e.srv.machineNow().Name + " while this run worked."
}

// sessionWords say which session an attempt uses, for the printed line.
func (r *agentRun) sessionWords(resume string) string {
	switch {
	case resume != "":
		return "session " + resume
	case r.session != "":
		return "new session " + r.session
	}
	return "a new session"
}

// takeFolder takes the folder's lock, waiting while another run works
// there (saying so on the run's row), unless the run ends meanwhile.
func (r *agentRun) takeFolder(ctx context.Context) (*os.File, runEnding) {
	e := r.e
	lock, err := e.srv.takeFolder(e.reg.Folder, e.me.Handle)
	if err == nil {
		return lock, runEnding{}
	}
	if !errors.Is(err, errLocked) {
		return nil, runEnding{state: core.AgentSessionFailed, reason: core.RunStartFailed, line: "failed: the folder's lock: " + err.Error()}
	}
	r.setReason(core.RunFolderBusy)
	holder := e.srv.folderHolder(e.reg.Folder)
	if holder == "" {
		holder = "another run"
	}
	e.sayRun(r.key, "waiting for the folder (%s works there)", holder)
	for {
		if end, ok := r.pauseWithin(ctx, e.srv.host.times.folderPoll); !ok {
			return nil, end
		}
		lock, err := e.srv.takeFolder(e.reg.Folder, e.me.Handle)
		if err == nil {
			r.setReason("")
			return lock, runEnding{}
		}
	}
}

// waitForQuietSession waits while the program session to resume was
// written by something else in the last few minutes (a person going on
// with it in a terminal), saying so on the run's row. Best effort: what
// starts writing after the run started is not seen.
func (r *agentRun) waitForQuietSession(ctx context.Context, session string) (runEnding, bool) {
	e := r.e
	t := e.srv.host.times
	seen := e.state.task(r.key).SessionFile
	path, ok := e.prog.SessionFile(e.srv.host.home, session, e.reg.Folder)
	if !ok || seen == nil {
		return runEnding{}, true
	}
	waited := false
	for {
		st, err := os.Stat(path)
		if err != nil {
			break
		}
		mark := fileMark{MTime: st.ModTime().UnixMilli(), Size: st.Size()}
		if mark == *seen || e.srv.host.clock.Now().Sub(st.ModTime()) >= t.sessionQuiet {
			break
		}
		if !waited {
			waited = true
			r.setReason(core.RunSessionOpen)
			e.sayRun(r.key, "waiting: its session was written outside Quadit a moment ago")
		}
		if end, ok := r.pauseWithin(ctx, t.sessionCheck); !ok {
			return end, false
		}
	}
	if waited {
		r.setReason("")
	}
	return runEnding{}, true
}

// pauseWithin waits d, unless the run ends meanwhile: a stop asked, the
// lease lost, the runner stopping. It gives that end, and false.
func (r *agentRun) pauseWithin(ctx context.Context, d time.Duration) (runEnding, bool) {
	if end, ok := r.endedYet(ctx); !ok {
		return end, false
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-r.stopAsked:
	case <-r.leaseGone:
	case <-ctx.Done():
	}
	return r.endedYet(ctx)
}

// endedYet gives the end of a run that ended by something beside its
// program, and false: a stop asked, the lease lost, the runner stopping.
func (r *agentRun) endedYet(ctx context.Context) (runEnding, bool) {
	switch {
	case r.stopped():
		return r.stoppedEnd(""), false
	case chanClosed(r.leaseGone):
		return r.leaseLostEnd("while this run waited"), false
	case ctx.Err() != nil:
		r.mu.Lock()
		accepted := r.accepted
		r.mu.Unlock()
		return runEnding{state: core.AgentSessionFailed, reason: core.RunInterrupted, summary: r.stoppedSummary(), ack: accepted,
			line: "interrupted: Quadit stopped while this run worked"}, false
	}
	return runEnding{}, true
}

// chanClosed reports whether ch is closed.
func chanClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// keepToContinue marks the head, kept after a usage limit or a sign-in
// failure, to be continued by the next run, when the work had begun;
// else its next run gives the same prompt again.
func (r *agentRun) keepToContinue(begun bool) {
	if !begun {
		return
	}
	_ = r.e.state.changeTask(r.key, func(t *taskState) { // not written: the head is given the same prompt again
		t.Continue = &continueMark{Seq: r.items[0].Seq, Run: r.id}
	})
}

// freshSession starts the next attempt in a new session after a lost one.
func (r *agentRun) freshSession() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fresh = true
	r.session = ""
	if r.e.prog.Name() == core.ProgramClaude {
		r.session = id.New()
		r.queueSession()
	}
	_ = r.e.state.changeTask(r.key, func(t *taskState) { t.Session, t.SessionFile = r.session, nil }) // not written: the lost one is found lost again
}

// queueSession tells the server the run's program session, once for each
// new one. The caller holds r.mu.
func (r *agentRun) queueSession() {
	if r.session == "" || r.session == r.sentSession {
		return
	}
	args := map[string]any{"id": r.id, "program_session": r.session}
	if r.fresh {
		args["fresh"] = true
	}
	r.sentSession = r.session
	_, _ = r.e.out.add(r.writeLocked(writeProgramSession, &pendingChange{Type: "session.update", Args: args})) // not stored: the row shows the session it had
}

// setReason says on the run's row why it waits ("" when it no longer does).
func (r *agentRun) setReason(reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, _ = r.e.out.add(r.writeLocked(writeReason, &pendingChange{Type: "session.update", Args: map[string]any{"id": r.id, "reason": reason}})) // not stored: the row's reason lags
}

// write is one of the run's writes, with the next ordinal of its name.
func (r *agentRun) write(name string, change *pendingChange) outboxWrite {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writeLocked(name, change)
}

func (r *agentRun) writeLocked(name string, change *pendingChange) outboxWrite {
	n := r.j.Ordinals[name]
	r.j.Ordinals[name] = n + 1
	return outboxWrite{Run: r.id, Task: r.key, Head: r.items[0].Seq, Write: name, Ordinal: n, ChangeID: changeID(r.id, name, n), Change: change}
}

// saveJournal writes the journal; the caller holds r.mu. Before a launch
// its error stops the launch; later, a journal not written is found one
// step behind at the next start, which ends the run the same way.
func (r *agentRun) saveJournal() error { return writeJournal(r.e.dir, r.j) }

// askStop says a member asked the run to stop.
func (r *agentRun) askStop() { r.stopOnce.Do(func() { close(r.stopAsked) }) }

// stopped reports whether a stop was asked.
func (r *agentRun) stopped() bool { return chanClosed(r.stopAsked) }

// loseLease says the lease is no longer the runner's.
func (r *agentRun) loseLease() { r.leaseOnce.Do(func() { close(r.leaseGone) }) }

// watchStop watches the run's row for a stop from the moment the server
// confirmed the run: the task's session.updated events from the seq the
// start answered, held a while each, and after any reconnect the row
// itself, read again.
func (r *agentRun) watchStop(ctx context.Context, after int64) {
	t := r.e.srv.host.times
	away, missed := t.awayFirst, false
	for ctx.Err() == nil {
		page, err := r.e.api.events(ctx, r.key, "session.updated", after, t.hold)
		if err != nil {
			missed = true
			r.e.srv.wait(ctx, away)
			away = min(away*2, t.awayMax)
			continue
		}
		away = t.awayFirst
		if missed {
			missed = false
			if row, ok, err := r.e.api.runRowOf(ctx, r.key, r.id); err == nil && ok && (row.StopRequestedAt > 0 || ended(row.State)) {
				r.askStop()
				return
			}
		}
		for _, ev := range page.Events {
			if ev.EntityID == r.id {
				if _, ok := ev.Data.Changes["stop_requested_at"]; ok {
					r.askStop()
					return
				}
			}
		}
		after = max(after, page.Seq)
	}
}

// renewLease keeps the lease with a one-second hold every renewal while
// the run lasts. A refusal saying another session holds the listener, or
// an answer with another lease, means the project was taken over.
func (r *agentRun) renewLease(ctx context.Context) {
	e := r.e
	for {
		e.srv.wait(ctx, e.srv.host.times.renew)
		if ctx.Err() != nil {
			return
		}
		ask := e.holdAsk(time.Second, false)
		ask.lease = r.lease
		ans, err := e.api.hold(ctx, ask)
		if ctx.Err() != nil {
			return
		}
		if accessRefused(err) {
			// The login lost its access: an infrastructure stop.
			r.accessLost.Store(true)
			r.loseLease()
			return
		}
		if leaseLost(err) || (err == nil && ans.Lease != r.lease) {
			r.loseLease()
			return
		}
	}
}

// sendSteps queues the run's new steps every few seconds, at most
// maxStepsPerUpdate in each update, and sends the outbox.
func (r *agentRun) sendSteps(ctx context.Context) {
	for {
		r.e.srv.wait(ctx, r.e.srv.host.times.steps)
		if ctx.Err() != nil {
			return
		}
		r.queueSteps()
		_ = r.e.flush(ctx) // what is not sent now is sent with the next
	}
}

// maxStepsPerUpdate is the most steps one session.update carries.
const maxStepsPerUpdate = 50

// queueSteps queues the steps not queued yet.
func (r *agentRun) queueSteps() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for len(r.steps) > 0 {
		n := min(len(r.steps), maxStepsPerUpdate)
		batch := r.steps[:n]
		if _, err := r.e.out.add(r.writeLocked(writeSteps, &pendingChange{Type: "session.update", Args: map[string]any{"id": r.id, "add_steps": batch}})); err != nil {
			return
		}
		r.steps = r.steps[n:]
	}
}

// sawSession takes the session the program said it works in: only an id
// of a UUID's form is ever kept, to be resumed.
func (r *agentRun) sawSession(session string) {
	if !id.Valid(session) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.session = session
	r.j.Session = session
	_ = r.saveJournal() // after the launch: see saveJournal
	r.queueSession()
	_ = r.e.state.changeTask(r.key, func(t *taskState) { t.Session = session }) // not written: the next run starts fresh
}

// sawAccepted takes the first evidence that the provider took the prompt:
// the run covers its items from now, and its row says it works.
func (r *agentRun) sawAccepted() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.accepted {
		return
	}
	r.accepted = true
	r.j.Phase = phaseAccepted
	_ = r.saveJournal() // after the launch: see saveJournal
	through := slicesMax(r.j.Prompted)
	_ = r.e.state.changeTask(r.key, func(t *taskState) { t.Through = max(t.Through, through) })                                                                                             // not written: the server's row says it
	_, _ = r.e.out.add(r.writeLocked(writeAccepted, &pendingChange{Type: "session.update", Args: map[string]any{"id": r.id, "state": core.AgentSessionRunning, "items_through": through}})) // not stored: the end still says how it ended
}

// slicesMax is the largest of seqs (none: 0).
func slicesMax(seqs []int64) int64 {
	m := int64(0)
	for _, s := range seqs {
		m = max(m, s)
	}
	return m
}

// sawEvents takes what one line of the program's output said.
func (r *agentRun) sawEvents(events []programEvent, at time.Time) {
	for _, ev := range events {
		switch ev.Kind {
		case evSession:
			r.sawSession(ev.Session)
		case evAccepted:
			r.sawAccepted()
		case evTool, evUnreadable:
			r.mu.Lock()
			if !r.toolActivity {
				r.toolActivity = true
				r.j.ToolActivity = true
				_ = r.saveJournal() // after the launch: see saveJournal
			}
			r.mu.Unlock()
		case evStep:
			if ev.Step.Tool == "" {
				continue // the server keeps a step only with its tool's name
			}
			r.mu.Lock()
			s := ev.Step
			s.At = at.UnixMilli()
			r.steps = append(r.steps, s)
			r.mu.Unlock()
		}
	}
}

// finish ends the run: the steps left and the terminal record are stored
// before any network call; then the folder is let go (it is not held
// while the server is told), the state is recorded, the journal cleared,
// and the outbox sent. A terminal record that cannot be stored is kept
// by the entry, which stores it before it does anything else
// (errEndNotKept): nothing is acknowledged, nothing new starts meanwhile.
func (r *agentRun) finish(ctx context.Context, end runEnding, folder *os.File) error {
	e := r.e
	r.queueSteps()
	r.mu.Lock()
	accepted := r.accepted
	session := r.session
	r.mu.Unlock()
	eligible := end.state == core.AgentSessionDone || (end.state == core.AgentSessionFailed &&
		(end.reason == core.RunProgramError || end.reason == core.RunIdle || end.reason == core.RunTimeLimit))
	m := e.srv.machineNow()
	t := terminalRecord{State: end.state, Reason: end.reason, Final: end.final, Summary: end.summary, StartSeq: r.j.StartSeq, Fallback: fallbackNone,
		SendEnd: true, Head: r.items[0].Seq, Ack: end.ack, Cursor: core.ListenCursorOf(e.reg.ProjectID), Lease: r.lease,
		AgentID: e.reg.AgentID, Machine: m.Name}
	if end.reason == core.RunUsageLimit && end.resetsAt.After(r.received) {
		t.ResetsAt = end.resetsAt.UnixMilli()
	}
	if eligible && cleanedFinal(end.final, m.Name) != "" {
		t.Fallback = decidePending
	}
	if eligible && accepted {
		t.Quiet = decidePending
	}
	kept := func() {
		_ = e.state.changeTask(r.key, func(ts *taskState) { // not written: the next run reads the state of the run before
			if path, ok := e.prog.SessionFile(e.srv.host.home, session, e.reg.Folder); session != "" && ok {
				if st, err := os.Stat(path); err == nil {
					ts.SessionFile = &fileMark{MTime: st.ModTime().UnixMilli(), Size: st.Size()}
				}
			}
			if r.continuing && end.reason != core.RunUsageLimit && end.reason != core.RunNotSignedIn {
				ts.Continue = nil
			}
		})
		if end.reason != core.RunUsageLimit && accepted {
			_ = e.state.change(func(s *entryState) { // the back-off of a usage limit starts over after a run that worked
				if s.Pause != nil && s.Pause.Reason == "" {
					s.Pause = nil
				}
			})
		}
		_ = clearJournal(e.dir) // the outbox's record wins over a journal left behind
		e.sayRun(r.key, "%s", end.line)
	}
	w := outboxWrite{Run: r.id, Task: r.key, Head: r.items[0].Seq, Write: writeEnd, Terminal: &t}
	_, err := e.out.add(w)
	if folder != nil {
		e.srv.releaseFolder(e.reg.Folder, folder) // the program ended; the server is told without holding the folder
	}
	if err != nil {
		e.keepEndLater(w, kept)
		e.sayRun(r.key, "could not keep how this run ended (%v); nothing goes on until it is kept", err)
		return errEndNotKept
	}
	kept()
	sendCtx, cancel := ctx, context.CancelFunc(func() {})
	if ctx.Err() != nil {
		sendCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), e.srv.host.times.sendOnStop)
	}
	defer cancel()
	_ = e.flush(sendCtx) // what is not sent now is sent at the next chance
	return nil
}

// duration says how long something took: 4m 12s.
func duration(d time.Duration) string {
	d = d.Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%dm %ds", int(d/time.Minute), int(d%time.Minute/time.Second))
	}
	return fmt.Sprintf("%dh %dm", int(d/time.Hour), int(d%time.Hour/time.Minute))
}
