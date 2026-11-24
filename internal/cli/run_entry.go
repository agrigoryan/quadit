// One entry of `quadit run` at work: its checks, its hold of the project's
// listener, what it does with each item the server hands it, its pause,
// its recovery at start, and letting the project go when it is removed.
// Each entry has its own login, client, lease, state, journal and outbox,
// and its own goroutine: a server away, a pause or an error of one entry
// holds back no other.

package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
)

// liveEntry is one entry being served.
type liveEntry struct {
	srv   *serving
	reg   regEntry
	dir   string // entries/<id>
	prog  program
	api   entryAPI
	state *stateFile
	out   *outbox

	// What the last check found; set by the entry's goroutine before its
	// first hold, read by its runs. checkedFolder and checkedProgram are
	// the identities of the folder and the program last checked.
	me             whoAmI
	projectKey     string
	version        string
	label          string // the folder's label
	checkedFolder  string
	checkedProgram string

	// lease is the listener's lease, kept by the entry's goroutine.
	lease     string
	leaseFile *leaseFile

	// loginRaw is the login file as it was verified (verifyLogin); verified
	// says it was, and nothing is sent for the entry before. halted is
	// what a run found that the entry must stop for and check again (the
	// login changed, the disk refused a write).
	loginRaw []byte
	verified bool
	halted   atomic.Pointer[entryError]

	// unkept is a run's terminal record that could not be stored, and what
	// follows its storing; the entry does nothing else until it is stored.
	unkept      *outboxWrite
	afterUnkept func()

	mu     sync.Mutex
	cancel context.CancelCauseFunc // ends the entry: the runner stopping, the entry removed or changed
	ended  error                   // why it was ended before it began to serve
	shown  entryStatus             // what status.json says of it
}

// entryError is a reason an entry is not served for now, in the words a
// person reads (status.json, quadit run list, the desktop app's card).
type entryError string

func (e entryError) Error() string { return string(e) }

// The entry errors the contract names.
const (
	errLoginRefused = entryError("login refused")
	errProjectGone  = entryError("project gone")
	errServerOld    = entryError("this Quadit server cannot run agents yet: update it")
	errNotInPlace   = entryError("this version of quadit runs a folder in place only")
	errServerWrong  = entryError("the server sent an answer that does not hold together")
	errServerAway   = entryError("the server is not answering; trying again")
)

// errRemoving ends an entry that quadit run remove asked to let go.
var errRemoving = errors.New("the entry is being removed")

// errEndNotKept is a run's end that could not be stored on this computer.
var errEndNotKept = entryError("how a run ended could not be kept on this computer")

// keepEndLater holds a terminal record that could not be stored, to store
// before anything else.
func (e *liveEntry) keepEndLater(w outboxWrite, after func()) {
	e.unkept, e.afterUnkept = &w, after
}

// keepUnkept stores a terminal record that could not be stored before.
func (e *liveEntry) keepUnkept() error {
	if e.unkept == nil {
		return nil
	}
	if _, err := e.out.add(*e.unkept); err != nil {
		return err
	}
	e.unkept = nil
	e.afterUnkept()
	return nil
}

// errLocked is a lock another holder has.
var errLocked = errors.New("locked")

// newEntry makes an entry ready to serve: its folders, state and outbox.
func newEntry(srv *serving, reg regEntry) (*liveEntry, error) {
	prog, ok := programs[reg.Program]
	if !ok {
		return nil, fmt.Errorf("program= is claude or codex, not %q", reg.Program)
	}
	dir := srv.files.entry(reg.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	state, err := openState(filepath.Join(dir, "state.json"), entryState{Server: reg.Server, WorkspaceID: reg.WorkspaceID, AgentID: reg.AgentID, Program: reg.Program, Folder: reg.Folder})
	if err != nil {
		return nil, err
	}
	out, err := openOutbox(filepath.Join(dir, "outbox"))
	if err != nil {
		return nil, err
	}
	e := &liveEntry{srv: srv, reg: reg, dir: dir, prog: prog, state: state, out: out, label: srv.host.rules().label(reg.Folder)}
	out.blocked = func(w outboxWrite, err error) {
		code := err.Error()
		if ae, ok := refusalOf(err); ok {
			code = ae.Code
		}
		e.sayEntry("the server refused how run %s ended (%s); kept in the outbox's failed folder", shortID(w.Run), code)
		e.refreshStatus()
	}
	out.quiet = func(task, run string, quiet bool) {
		_ = state.countQuiet(task, run, quiet) // a count not kept holds nothing back but G4 for this run
	}
	return e, nil
}

// serve serves the entry until the runner stops (runner ends) or the entry
// is ended (stop(cause)). Removed, it lets the project go before it
// returns, unless the runner itself stops meanwhile.
func (e *liveEntry) serve(runner context.Context) {
	ctx, cancel := context.WithCancelCause(runner)
	e.mu.Lock()
	e.cancel = cancel
	if e.ended != nil {
		cancel(e.ended)
	}
	e.mu.Unlock()
	defer cancel(nil)
	defer func() {
		if e.leaseFile != nil {
			e.leaseFile.close()
		}
	}()
	e.setStatus(entryStatus{State: statusStarting})
	e.recover(runner) // on this computer alone: nothing is sent before the login is verified
	if e.reg.Removing {
		cancel(errRemoving)
	}
	// failed waits after an entry error: a server away (one starting with
	// the runner, as the app starts both) is tried again soon, doubling,
	// anything else at the recheck.
	away := e.srv.host.times.awayFirst
	failed := func(err error) {
		if !serverAway(err) {
			e.setStatus(entryStatus{State: statusError, Message: err.Error()})
			e.srv.wait(ctx, e.srv.host.times.recheck)
			return
		}
		e.setStatus(entryStatus{State: statusError, Message: string(errServerAway)})
		e.srv.wait(ctx, away)
		away = min(away*2, e.srv.host.times.awayMax)
	}
	for ctx.Err() == nil {
		if err := e.keepUnkept(); err != nil {
			e.setStatus(entryStatus{State: statusError, Message: string(errEndNotKept)})
			e.srv.wait(ctx, e.srv.host.times.recheck)
			continue
		}
		if e.reg.Mode != modeInPlace {
			e.setStatus(entryStatus{State: statusError, Message: string(errNotInPlace)})
			<-ctx.Done()
			break
		}
		pause, err := e.check(ctx)
		if err == nil {
			away = e.srv.host.times.awayFirst // the server answered
		}
		if e.verified && !e.out.empty() {
			_ = e.flush(ctx) // what is not sent now is sent with the next round
		}
		current := e.state.pause()
		switch {
		case ctx.Err() != nil:
		case err != nil:
			failed(err)
		case pause != "":
			if current == nil || current.Reason != pause {
				e.pauseEntry(pause)
			}
			e.whilePaused(ctx)
		case current != nil:
			// A pause lifts by its own rule (whilePaused): a usage limit at
			// its reset, any other once the checks pass at a recheck, not
			// at once (a program can say it is not signed in while its own
			// check says it is).
			e.whilePaused(ctx)
		default:
			if err := e.listen(ctx); err != nil && ctx.Err() == nil {
				failed(err)
			}
		}
	}
	if errors.Is(context.Cause(ctx), errRemoving) {
		e.letGo(runner)
	}
}

// stop ends the entry's serving, for cause, whether it began to serve or
// not.
func (e *liveEntry) stop(cause error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cancel != nil {
		e.cancel(cause)
	} else if e.ended == nil {
		e.ended = cause
	}
}

// check makes the checks of an entry's start, in order: the login and the
// project (verifyLogin), the lease file, the folder, the program, the
// program's own settings, its sign-in. It gives the pause the first that
// fails sets, or the error it says; neither when all pass. A paused entry
// has its login, project and lease file all the same: its holds need them.
func (e *liveEntry) check(ctx context.Context) (pause string, err error) {
	if err := e.verifyLogin(ctx); err != nil {
		return "", err
	}
	if err := e.openLease(); err != nil {
		return "", err
	}
	if pause := e.checkFolderAndProgram(ctx); pause != "" {
		return pause, nil
	}
	if pause := settingsPause(e.prog, e.srv.host.home, e.reg.Folder, e.reg.Login); pause != "" {
		return pause, nil
	}
	signedIn, err := e.signedIn(ctx)
	if err != nil {
		return "", err
	}
	if !signedIn {
		return core.PauseNotSignedIn, nil
	}
	return "", nil
}

// settingsPause is login_mismatch when the program's own settings could
// make a run work as another login than the entry's, whichever of its
// settings files wins: QUADIT_CONFIG naming another file, QUADIT_URL or
// QUADIT_TOKEN set at all, or a settings file that cannot be read. "" when
// none.
func settingsPause(p program, home, folder, login string) string {
	settings, err := p.QuaditSettings(home, folder)
	if err != nil {
		return core.PauseLoginMismatch
	}
	for _, s := range settings {
		if s.Name != "QUADIT_CONFIG" || resolved(expandHome(s.Value, home)) != resolved(login) {
			return core.PauseLoginMismatch
		}
	}
	return ""
}

// verifyLogin reads the entry's login file and makes sure it is the
// entry's: of its server, and, as GET /me says, of its workspace and its
// agent, an agent's login that may write; and that the project is still
// the agent's. Until it has, nothing is sent for the entry; a program is
// started with the login as it was verified (loginUnchanged).
func (e *liveEntry) verifyLogin(ctx context.Context) error {
	e.verified = false
	raw, err := os.ReadFile(e.reg.Login)
	if err != nil {
		return errLoginRefused
	}
	c, err := loginClientOf(raw, e.reg.Login)
	if err != nil || c.URL != e.reg.Server {
		return errLoginRefused
	}
	api := entryAPI{c: c}
	me, err := api.me(ctx)
	if err != nil {
		if temporary(err) {
			return err
		}
		return errLoginRefused
	}
	if me.Kind != "agent" || me.ReadOnly || me.UserID != e.reg.AgentID || me.Workspace.ID != e.reg.WorkspaceID {
		return errLoginRefused
	}
	projects, err := api.projects(ctx)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(projects, func(p projectRow) bool { return p.ID == e.reg.ProjectID })
	if i < 0 || !keyForm.MatchString(projects[i].Key) {
		return errProjectGone
	}
	if e.leaseFile != nil && (e.api.c == nil || e.api.c.Token != c.Token || e.projectKey != projects[i].Key) {
		e.leaseFile.close() // the lease file is the login's and the project's: another's is opened
		e.leaseFile, e.lease = nil, ""
	}
	e.api, e.me, e.projectKey, e.loginRaw, e.verified = api, me, projects[i].Key, raw, true
	return nil
}

// halt stops the entry's listening for why, before its next hold; it is
// shown and checked again.
func (e *liveEntry) halt(why entryError) { e.halted.Store(&why) }

// loginUnchanged reports whether the login file still holds what was
// verified.
func (e *liveEntry) loginUnchanged() bool {
	raw, err := os.ReadFile(e.reg.Login)
	return err == nil && bytes.Equal(raw, e.loginRaw)
}

// openLease opens the lease file of the verified login and project, once.
func (e *liveEntry) openLease() error {
	if e.leaseFile != nil {
		return nil
	}
	lf, err := openLeaseFile(filepath.Dir(e.reg.Login), e.api.c, e.projectKey)
	if err != nil {
		return err
	}
	e.leaseFile, e.lease = lf, lf.kept()
	return nil
}

// dropLease forgets a lease the server says ended: the next hold asks
// for one again (never taking it from another session).
func (e *liveEntry) dropLease() {
	e.lease = ""
	if e.leaseFile != nil {
		e.leaseFile.keep("")
	}
}

// checkFolderAndProgram checks again what is checked before every start
// of the program: the folder passes the folder rules and is still the one
// registered, and the program is the file registered and answers
// --version. It gives the pause a failure sets, "" when both pass.
//
// What it checked is kept by identity, so a start can be made only in the
// folder and with the file checked (stillAsChecked).
func (e *liveEntry) checkFolderAndProgram(ctx context.Context) string {
	if canon, _, err := e.srv.host.rules().check(e.reg.Folder); err != nil || canon != e.reg.Folder {
		return core.PauseFolderMissing
	}
	folder, err := fileIdentity(e.reg.Folder)
	if err != nil {
		return core.PauseFolderMissing
	}
	file, err := fileIdentity(e.reg.ProgramPath)
	if err != nil {
		return core.PauseProgramMissing
	}
	version, err := programVersionOf(ctx, e.reg.ProgramPath, e.srv.host.times.version)
	if err != nil {
		return core.PauseProgramMissing
	}
	e.mu.Lock()
	e.version, e.checkedFolder, e.checkedProgram = version, folder, file
	e.mu.Unlock()
	return ""
}

// stillAsChecked gives the pause to set when the folder or the program is
// no longer the one checkFolderAndProgram checked, "" when both are.
func (e *liveEntry) stillAsChecked() string {
	e.mu.Lock()
	folder, file := e.checkedFolder, e.checkedProgram
	e.mu.Unlock()
	if id, err := fileIdentity(e.reg.Folder); err != nil || id != folder {
		return core.PauseFolderMissing
	}
	if id, err := fileIdentity(e.reg.ProgramPath); err != nil || id != file {
		return core.PauseProgramMissing
	}
	return ""
}

// programVersionOf is the version a program at path says it is, asked
// with --version for at most within: an error for a path that is not an
// executable regular file, or a program that does not answer.
func programVersionOf(ctx context.Context, path string, within time.Duration) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("%s is not a program", path)
	}
	exit, out, err := probe(ctx, path, []string{"--version"}, os.Environ(), within)
	if err == nil && exit != 0 {
		err = fmt.Errorf("it exited %d", exit)
	}
	if err != nil {
		return "", fmt.Errorf("%s --version did not answer: %w", path, err)
	}
	v := programVersion(out)
	if v == "" {
		return "", fmt.Errorf("%s --version said no version", path)
	}
	return v, nil
}

// signedIn asks the program whether it is signed in, the passive way.
func (e *liveEntry) signedIn(ctx context.Context) (bool, error) {
	exit, out, err := probe(ctx, e.reg.ProgramPath, e.prog.SignedIn(), programEnv(os.Environ(), e.reg.Login, "", ""), e.srv.host.times.version)
	if err != nil {
		return false, entryError(e.prog.Title() + " could not check its sign-in")
	}
	return e.prog.ReadSignedIn(exit, out)
}

// maxProbeOutput is the most of a probe's output kept.
const maxProbeOutput = 64 << 10

// probe runs a program briefly (its version, its sign-in) in a group of
// its own, for at most within: it gives the exit status and the start of
// what it printed. Past within, or when its pipes are still held a moment
// after it exited, the whole group is stopped.
func probe(ctx context.Context, path string, args, env []string, within time.Duration) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, within)
	defer cancel()
	out := &capped{max: maxProbeOutput}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env, cmd.Stdout, cmd.Stderr = env, out, out
	cmd.WaitDelay = time.Second
	cmd.Cancel = func() error {
		signalGroup(cmd.Process.Pid, sigKill)
		return nil
	}
	if err := startInGroup(cmd); err != nil {
		return -1, nil, err
	}
	err := cmd.Wait()
	signalGroup(cmd.Process.Pid, sigKill) // what it left behind goes with it
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return -1, out.bytes(), err
	}
	if ctx.Err() != nil {
		return -1, out.bytes(), ctx.Err()
	}
	return cmd.ProcessState.ExitCode(), out.bytes(), nil
}

// capped keeps what is written to it up to max bytes, and takes the rest
// without keeping it.
type capped struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf = append(c.buf, p[:min(len(p), max(c.max-len(c.buf), 0))]...)
	return len(p), nil
}

func (c *capped) bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.buf...)
}

// expandHome is a path a setting gave, with a leading ~ made the home folder.
func expandHome(path, home string) string {
	if path == "~" {
		return home
	}
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		return filepath.Join(home, rest)
	}
	return path
}

// pauseEntry pauses the entry for reason. (A usage limit pauses every
// entry of the agent: serving.pauseAgent.)
func (e *liveEntry) pauseEntry(reason string) {
	_ = e.state.change(func(s *entryState) { // a pause not written is held in memory for this run of quadit
		backoff := 0
		if s.Pause != nil {
			backoff = s.Pause.BackoffMinutes
		}
		s.Pause = &pauseState{Reason: reason, BackoffMinutes: backoff}
	})
	e.sayEntry("paused: %s", pauseWords(reason, e.prog.Title(), time.Time{}))
}

// liftPause ends the entry's pause; the back-off of a usage limit is kept
// until a run ends another way.
func (e *liveEntry) liftPause() {
	_ = e.state.change(func(s *entryState) { // not written: the next check finds the pause lifted anyway
		if s.Pause != nil {
			s.Pause = &pauseState{BackoffMinutes: s.Pause.BackoffMinutes}
		}
	})
}

// whilePaused keeps the lease with a short hold every renewal, acting on
// no item, until the pause's own condition passes: its reset for a usage
// limit, else the entry's checks, every recheck.
func (e *liveEntry) whilePaused(ctx context.Context) {
	t := e.srv.host.times
	lastCheck := e.srv.host.clock.Now()
	for ctx.Err() == nil {
		p := e.state.pause()
		if p == nil {
			return
		}
		until := time.Time{}
		if p.Until > 0 {
			until = time.UnixMilli(p.Until)
		}
		e.setStatus(entryStatus{State: statusPaused, Pause: p.Reason, Until: until})
		if !e.out.empty() {
			_ = e.flush(ctx) // a pause holds back runs, not what waits to be sent
		}
		e.keepLease(ctx, p.Reason, p.Until)
		now := e.srv.host.clock.Now()
		switch {
		case p.Reason == core.PauseUsageLimit:
			if !now.Before(until) {
				e.liftPause()
				return
			}
		case now.Sub(lastCheck) >= t.recheck:
			lastCheck = now
			if p.Reason == core.PauseServerOld {
				e.liftPause()
				return
			}
			pause, err := e.check(ctx)
			if err == nil && pause == "" {
				e.liftPause()
				return
			}
			if pause != "" && pause != p.Reason {
				e.pauseEntry(pause)
			}
		}
		wait := t.renew
		if !until.IsZero() {
			wait = min(wait, until.Sub(now))
		}
		e.srv.wait(ctx, max(wait, time.Millisecond))
	}
}

// keepLease renews the lease with a one-second hold that says the pause,
// and acts on nothing it hands back.
func (e *liveEntry) keepLease(ctx context.Context, paused string, until int64) {
	ask := e.holdAsk(time.Second, false)
	ask.paused = paused
	if paused == core.PauseUsageLimit {
		ask.pausedUntil = until
	}
	ans, err := e.api.hold(ctx, ask)
	switch {
	case err == nil && leaseForm.MatchString(ans.Lease):
		e.keepLeaseID(ans.Lease)
	case leaseLost(err) && refusalReason(err) == "lease_stale":
		e.dropLease()
	}
}

// holdAsk is a hold of the entry's listener with its lease and its mark.
func (e *liveEntry) holdAsk(wait time.Duration, batch bool) holdAsk {
	e.mu.Lock()
	version := e.version
	e.mu.Unlock()
	return holdAsk{project: e.projectKey, lease: e.lease, wait: wait, batch: batch, machineID: e.srv.machineNow().ID, machineName: e.srv.machineNow().Name,
		folder: e.label, program: e.reg.Program, version: version}
}

// keepLeaseID keeps the lease the server answered with, for the next hold
// and the next start of quadit run.
func (e *liveEntry) keepLeaseID(lease string) {
	if lease == e.lease {
		return
	}
	e.lease = lease
	if e.leaseFile != nil {
		e.leaseFile.keep(lease)
	}
}

// listen holds the project's listener, round after round, and does with
// each item what its wake and the guards say. It returns when the entry
// pauses, with an error the entry waits out, or when ctx ends.
func (e *liveEntry) listen(ctx context.Context) error {
	t := e.srv.host.times
	aside, away := t.asideFirst, t.awayFirst
	ready := false
	for ctx.Err() == nil {
		if e.state.pause() != nil {
			return nil
		}
		if why := e.halted.Swap(nil); why != nil {
			return *why // checked again (the login verified again) before anything more
		}
		if !e.out.empty() {
			_ = e.flush(ctx) // what is not sent now is sent before the next run, which waits for it
		}
		// The first hold is short: it takes the lease and says so at once,
		// rather than when the first item comes.
		wait := t.hold
		if !ready {
			wait = time.Second
		}
		ans, err := e.api.hold(ctx, e.holdAsk(wait, true))
		if ctx.Err() != nil {
			return ctx.Err() // the entry ends: whoever ended it does not wait on this
		}
		switch {
		case leaseLost(err) && refusalReason(err) == "lease_stale":
			e.dropLease() // that lease ended: ask for one again at once
			continue
		case leaseLost(err):
			if e.shownState() != statusAside {
				e.sayEntry("a chat listens to %s; trying again in %s", e.projectKey, seconds(aside))
			}
			e.setStatus(entryStatus{State: statusAside})
			ready = false
			e.srv.wait(ctx, aside)
			aside = min(aside*2, t.asideMax)
			continue
		case err != nil && temporary(err):
			e.srv.wait(ctx, away)
			away = min(away*2, t.awayMax)
			continue
		case err != nil:
			return errLoginRefused
		}
		aside, away = t.asideFirst, t.awayFirst
		if !leaseForm.MatchString(ans.Lease) || ans.Project != e.projectKey {
			e.pauseEntry(core.PauseServerOld)
			return nil
		}
		e.keepLeaseID(ans.Lease)
		if !ready {
			e.setStatus(entryStatus{State: statusReady})
			e.sayEntry("listening")
			ready = true
		}
		if ans.Item == nil {
			continue
		}
		if !understood(ans) {
			e.pauseEntry(core.PauseServerOld)
			return nil
		}
		if !consistent(ans, e.projectKey) {
			return errServerWrong // nothing of it is recorded or acknowledged
		}
		if err := e.handle(ctx, ans); err != nil {
			return err
		}
		if e.shownState() != statusReady && ctx.Err() == nil && e.state.pause() == nil {
			e.setStatus(entryStatus{State: statusReady})
		}
	}
	return nil
}

// understood reports whether the runner knows what an answer with an
// item asks: every item has a wake it knows. (A server that does not is
// older than the runner needs.)
func understood(ans held) bool {
	if !ans.Wake.understood() {
		return false
	}
	for _, b := range ans.Batch {
		if !b.Wake.understood() {
			return false
		}
	}
	return true
}

// consistent reports whether an answer holds together, before anything of
// it is recorded or acknowledged: positive feed positions, each item's
// own the same as its place's, the batch after the head and in order, on
// the head's task; and an item to run or to refuse on a task of the
// entry's project (an item to acknowledge may be of a task moved away).
func consistent(ans held, project string) bool {
	head := ans.Item
	ofProject := func(task string) bool {
		key, _, _ := strings.Cut(task, "-")
		return taskForm.MatchString(task) && key == project
	}
	if ans.Seq <= 0 || head.Seq != ans.Seq || (ans.Wake.Do != wakeAck && !ofProject(head.Task)) {
		return false
	}
	last := ans.Seq
	for _, b := range ans.Batch {
		if b.Item == nil || b.Item.Seq != b.Seq || b.Seq <= last || b.Item.Task != head.Task {
			return false
		}
		last = b.Seq
	}
	return true
}

// handle does with the head what its wake, the outbox and the guards say.
func (e *liveEntry) handle(ctx context.Context, ans held) error {
	head := *ans.Item
	if e.out.endWaits(head.Seq) {
		// The end of its last run waits to be sent: the head is never
		// started again meanwhile.
		if e.flush(ctx) != nil {
			e.srv.wait(ctx, e.srv.host.times.resend)
		}
		return nil
	}
	switch ans.Wake.Do {
	case wakeAck:
		e.acknowledge(ctx, head, itemRunID(head.ID))
		return nil
	case wakeRefuse:
		e.notStarted(ctx, head, ans.Wake.Why)
		return nil
	}
	task := e.state.task(head.Task)
	continuing := task.Continue != nil && task.Continue.Seq == head.Seq
	covered, err := e.covered(ctx, head, task)
	switch {
	case err != nil:
		// What the head's task covers could not be read: it is never taken
		// as "nothing", the head comes again.
		e.sayRun(head.Task, "waiting: what %s covers could not be read (%v)", head.Task, err)
		e.srv.wait(ctx, e.srv.host.times.awayFirst)
		return nil
	case covered && !continuing:
		e.acknowledge(ctx, head, itemRunID(head.ID))
		return nil
	}
	if head.ByAgent {
		if why := e.guard(head.Task); why != "" {
			e.notStarted(ctx, head, why)
			return nil
		}
	}
	// The other items of the task go with the head, never with a
	// continuation, which carries nothing new: what came during its pause
	// comes as its own head. They come after the head, which no program
	// took, so none took them either.
	items := []listenItem{head}
	for _, b := range ans.Batch {
		if b.Wake.Do == wakeRun && !continuing {
			items = append(items, *b.Item)
		}
	}
	return e.run(ctx, items, continuing)
}

// covered reports whether a program of this task already took the head:
// by the entry's own record, or, when it has none, by a run of this agent
// on the task that the server says its program took. With neither, no
// program took anything of the task. A read of the server's runs that
// failed is an error, never "nothing covered".
func (e *liveEntry) covered(ctx context.Context, head listenItem, task taskState) (bool, error) {
	if task.Through > 0 {
		return head.Seq <= task.Through, nil
	}
	through := int64(0)
	err := e.api.eachRun(ctx, head.Task, func(row runRow) bool {
		if row.AgentID == e.reg.AgentID && row.AcceptedAt > 0 {
			through = max(through, row.ItemsThrough)
		}
		return false
	})
	if err != nil {
		return false, err
	}
	return head.Seq <= through, nil
}

// The guards on automatic runs.
const (
	maxAutomaticPerTask  = 4  // G3, per entry and task in any hour
	maxAutomaticPerEntry = 12 // G11, per entry in any hour
)

// guard is why an automatic run of the task is held back (G3, G11, G4),
// or "".
func (e *liveEntry) guard(key string) string {
	now := e.srv.host.clock.Now()
	why := ""
	e.state.read(func(s *entryState) {
		t := s.Tasks[key]
		switch {
		case t != nil && len(withinHour(t.Automatic, now)) >= maxAutomaticPerTask, len(withinHour(s.Automatic, now)) >= maxAutomaticPerEntry:
			why = core.RunCapped
		case t != nil && len(t.Quiet) == 2 && t.Quiet[0] && t.Quiet[1]:
			why = core.RunNoProgress
		}
	})
	return why
}

// acknowledge moves the cursor past the head, through the outbox.
func (e *liveEntry) acknowledge(ctx context.Context, head listenItem, run string) {
	_, _ = e.out.add(e.ackWrite(run, head, e.lease)) // not stored: the head comes again
	_ = e.flush(ctx)                                 // not sent: the head comes again, and waits for it (endWaits)
}

// ackWrite is the acknowledgment of a head, with the lease it was handed
// under.
func (e *liveEntry) ackWrite(run string, head listenItem, lease string) outboxWrite {
	return outboxWrite{Run: run, Task: head.Task, Head: head.Seq, Write: writeAck,
		Ack: &pendingAck{Cursor: core.ListenCursorOf(e.reg.ProjectID), Seq: head.Seq, Lease: lease}}
}

// notStarted records that the head starts no run, and why, then
// acknowledges it. Its row's run id and change id are made from the
// item's id: one row per item however often it comes.
func (e *liveEntry) notStarted(ctx context.Context, head listenItem, why string) {
	run := itemRunID(head.ID)
	args := e.startArgs(run, []listenItem{head}, core.AgentSessionNotStarted)
	args["reason"] = why
	// The row and the acknowledgment are one write: decided together, so a
	// crash between them never sends the row again with other bytes.
	w := e.ackWrite(run, head, e.lease)
	w.Write, w.ChangeID, w.Change = writeStart, run, &pendingChange{Type: "session.start", Args: args}
	if _, err := e.out.add(w); err != nil {
		return // not stored: the head comes again
	}
	e.sayRun(head.Task, "not started: %s", e.notStartedWords(why, head))
	_ = e.flush(ctx) // not sent: the head comes again, and waits for it (endWaits)
}

// startArgs are a run's session.start arguments, in a state, for its
// items (the head first).
func (e *liveEntry) startArgs(run string, items []listenItem, state string) map[string]any {
	head := items[0]
	return map[string]any{"id": run, "task": head.Task, "state": state, "program": e.reg.Program, "machine_id": e.srv.machineNow().ID,
		"machine_name": e.srv.machineNow().Name, "folder": e.label, "lease": e.lease, "item_seq": head.Seq, "instructions": runInstructions(items)}
}

// runInstructions is what started a run, as its row shows it to people
// under "Started by": the head item said as a person would, and how many
// more items the prompt carries ("@ann commented: "…" and 2 more."). The
// agent reads the items' own lines in its prompt, not this.
func runInstructions(items []listenItem) string {
	said := items[0].sentence()
	if n := len(items) - 1; n > 0 {
		said = strings.TrimSuffix(said, ".") + fmt.Sprintf(" and %d more.", n)
	}
	return said
}

// sentence is the item as a person says it, the agent being "it": who did
// what, with their words in quotes ("@ann commented: "…""). It keeps the
// care of the item's line: a handle and a task key only of their form,
// the words as quotable gives them.
func (item listenItem) sentence() string {
	who := "Someone"
	if handleForm.MatchString(item.By) {
		who = item.By
	}
	words := quotable(item.Snippet)
	did := func(what string) string {
		if words == "" {
			return who + " " + what + "."
		}
		return who + " " + what + `: "` + words + `"`
	}
	switch item.Type {
	case core.NoteComment:
		return did("commented")
	case core.NoteReplied:
		return did("replied")
	case core.NoteMentioned:
		return did("mentioned it")
	case core.NoteResult:
		return did("posted a result")
	case core.NoteWaitingOn:
		return did("is waiting on it")
	case core.NoteAsked:
		return did("asked it a question")
	case core.NotePicked:
		return did("answered its question")
	case core.NoteUnclear:
		return did("found its answer unclear")
	case core.NoteAssigned:
		if taskForm.MatchString(item.Task) {
			return who + " assigned " + item.Task + "."
		}
		return who + " assigned a task to it."
	}
	if words == "" {
		return who + "."
	}
	return who + `: "` + words + `"`
}

// flush sends the outbox, and says whether everything was sent.
func (e *liveEntry) flush(ctx context.Context) error {
	_, err := e.out.flush(ctx, e.api, "")
	e.refreshStatus()
	return err
}

// recover finds what a runner that stopped left behind, before the first
// hold: a run in flight is ended (its program stopped if it still runs),
// and the outbox is sent.
func (e *liveEntry) recover(ctx context.Context) {
	j, err := readJournal(e.dir)
	if err == nil && j != nil {
		e.recoverRun(ctx, *j)
	}
}

// recoverRun ends the run a journal holds. A terminal record in the outbox
// wins: the run ended and only its sending was cut. A program that was, or
// may have been, started is never started again by itself: its run is
// interrupted and its head acknowledged (a comment continues it). One that
// never ran keeps its head, which comes again.
func (e *liveEntry) recoverRun(ctx context.Context, j journal) {
	if e.out.hasEnd(j.Run) {
		_ = clearJournal(e.dir) // the outbox's record wins; a journal left is read the same way next time
		return
	}
	t := terminalRecord{State: core.AgentSessionFailed, Reason: core.RunInterrupted, StartSeq: j.StartSeq, Fallback: fallbackNone,
		Head: j.Head.Seq, Cursor: core.ListenCursorOf(e.reg.ProjectID), Lease: j.Lease, AgentID: e.reg.AgentID, Machine: e.srv.machineNow().Name,
		SendEnd: j.StartSeq > 0 || e.out.hasStart(j.Run), Summary: "Quadit stopped on " + e.srv.machineNow().Name + " while this run worked."}
	if j.Phase != phaseReceived {
		if j.PGID > 0 && j.ProcStart != "" {
			if started, err := processStart(ctx, j.PGID); err == nil && started == j.ProcStart {
				e.srv.ladder(j.PGID, e.srv.host.times.infraLadder, nil, nil)
			}
		}
		t.Ack = true
	}
	if _, err := e.out.add(outboxWrite{Run: j.Run, Task: j.Task, Head: j.Head.Seq, Write: writeEnd, Terminal: &t}); err != nil {
		return // the journal stays: the next start tries again
	}
	_ = clearJournal(e.dir) // the outbox's record wins over a journal left behind
	e.sayRun(j.Task, "interrupted: Quadit stopped while this run worked")
}

// letGo ends an entry that is removed: its run already ended (the end of
// the entry's own context did that), the outbox is sent, then the
// project's runner is released, then the entry is dropped from the
// registry. It goes on trying until all is sent or the runner stops
// (runner, a context that ends only then).
func (e *liveEntry) letGo(runner context.Context) {
	e.setStatus(entryStatus{State: statusRemoving})
	for !e.verified {
		// Nothing is sent, the release neither, with a login not verified.
		if err := e.verifyLogin(runner); err == nil || runner.Err() != nil {
			break
		}
		e.srv.wait(runner, e.srv.host.times.recheck)
	}
	if !e.verified {
		return
	}
	project := e.projectKey
	if project == "" {
		project = e.reg.Project
	}
	if _, err := e.out.add(outboxWrite{Write: writeRelease, Release: &pendingRelease{Project: project, MachineID: e.srv.machineNow().ID}}); err != nil {
		return
	}
	for runner.Err() == nil {
		if e.flush(runner) == nil && e.out.empty() {
			e.srv.drop(runner, e.reg.ID)
			e.sayEntry("removed")
			return
		}
		e.srv.wait(runner, e.srv.host.times.resend)
	}
}

// shortID is the start of a run's id, as lines print it.
func shortID(run string) string {
	if len(run) > 8 {
		return run[:8] + "…"
	}
	return run
}

// seconds says a duration in whole seconds.
func seconds(d time.Duration) string {
	return fmt.Sprintf("%d s", max(int(d.Round(time.Second)/time.Second), 1))
}

// newRunID is a run's id.
func newRunID() string { return id.New() }
