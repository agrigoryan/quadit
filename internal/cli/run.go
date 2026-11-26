// `quadit run`: Quadit runs the agent for a task. On a person's computer
// it holds the listener of one agent for one project per entry of its
// registry, and for each inbox item either acknowledges it or starts the
// agent's program (Claude Code or Codex) in the project's folder, resuming
// one program session per task (agent-runs-contract.md §5).
//
// The files, by what each knows:
//
//	run.go           the forms of the command (serve, add, remove, list,
//	                 machine) and the serving process the entries share
//	run_registry.go  runner.json, the runner's files, the folder rules
//	run_entry.go     one entry: checks, its hold, each item, pause, recovery
//	run_execute.go   one run, step by step, and how it ends
//	run_attempt.go   one start of the program: its process, output, ladders
//	run_programs.go  the program interface; run_claude.go, run_codex.go
//	run_prompt.go    the prompts
//	run_outbox.go    the ordered, durable writes to the server
//	run_state.go     state.json and journal.json
//	run_server.go    what the runner asks of the server
//	run_status.go    status.json and the printed lines
//	run_unix.go, run_windows.go   what the system gives the runner
//	guard_windows.go  quadit guard, how the desktop app starts programs on
//	                 Windows, and the stop event it asks quadit run to stop by
//
// The secrets form, `quadit run --secret NAME -- COMMAND`, is another
// command (cmd_secrets.go) that shares the name.

package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
)

// The exit codes of quadit run's forms.
const (
	exitOK         = 0
	exitFailed     = 1
	exitAnotherRun = 3 // another quadit run serves this computer
)

// runnerForm runs every form of quadit run but the secrets one; none of
// them needs a default login.
func runnerForm(ctx context.Context, args []string, sw switches, stdout, stderr io.Writer) int {
	host, err := systemHost()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	return runnerFormOn(ctx, host, args, sw, stdout, stderr)
}

// runnerFormOn is runnerForm on a computer as host gives it.
func runnerFormOn(ctx context.Context, host runHost, args []string, sw switches, stdout, stderr io.Writer) int {
	if sw.dry {
		fmt.Fprintln(stderr, "quadit run has no dry run: it cannot check without doing")
		return exitFailed
	}
	pos, fields := splitFields(args)
	form := ""
	if len(pos) > 0 {
		form, pos = pos[0], pos[1:]
	}
	if err := formArgs(form, pos, fields); err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	files, err := runFilesFor(firstValue(fields["registry"]))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	delete(fields, "registry")
	switch form {
	case "":
		ctx, stop := untilAskedToStop(ctx)
		defer stop()
		return serve(ctx, files, host, stdout, stderr)
	case "add":
		return runAdd(ctx, files, host, fields, sw.json, stdout, stderr)
	case "remove":
		return runRemove(ctx, files, host, pos, fields, stdout, stderr)
	case "list":
		return runList(files, host, sw.json, stdout, stderr)
	case "machine":
		return runMachine(ctx, files, fields, stdout, stderr)
	case "waiting":
		return runWaiting(ctx, fields, sw.json, stdout, stderr)
	}
	return exitFailed // formArgs refused every other form
}

// runUsage is what quadit run says to an argument it does not take.
const runUsage = "usage: quadit run [registry=PATH] | run add … | run remove … | run list | run waiting … | run machine name=… | run --secret NAME -- COMMAND (quadit help run)"

// runForms are the fields each form of quadit run takes (registry= is
// every form's), and how many arguments besides its name.
var runForms = map[string]struct {
	fields []string
	args   int
}{
	"":        {nil, 0},
	"add":     {[]string{"login", "project", "folder", "program", "program_path", "max_minutes"}, 0},
	"remove":  {[]string{"login", "project"}, 1},
	"list":    {nil, 0},
	"machine": {[]string{"name"}, 0},
	"waiting": {[]string{"login", "project"}, 0},
}

// formArgs refuses, before anything is touched, a form of quadit run that
// does not exist, a field it does not take, a field given twice, and more
// arguments than it takes: a typo must never widen what a command does.
func formArgs(form string, pos []string, fields map[string][]string) error {
	f, ok := runForms[form]
	if !ok {
		return errors.New(runUsage)
	}
	name := strings.TrimSpace("quadit run " + form)
	for key, values := range fields {
		if key != "registry" && !slices.Contains(f.fields, key) {
			return fmt.Errorf("%s takes no %s=; %s", name, key, runUsage)
		}
		if len(values) > 1 {
			return fmt.Errorf("%s= is given twice", key)
		}
	}
	if len(pos) > f.args {
		return fmt.Errorf("%s takes no argument %q; %s", name, pos[f.args], runUsage)
	}
	if form == "remove" && fields["project"] != nil && fields["login"] == nil {
		return errors.New("project= goes with login=: quadit run remove ENTRY_ID | login=PATH [project=KEY]")
	}
	return nil
}

// runClock is the time a runner keeps: the wall clock, for what is written
// down and compared with a server's or a program's times, and the time
// awake since the runner started, which does not advance while the
// computer sleeps (Go's monotonic clock), for the idle watchdog.
type runClock interface {
	Now() time.Time
	Awake() time.Duration
}

// systemClock is the computer's clock.
type systemClock struct{ start time.Time }

func (c systemClock) Now() time.Time       { return time.Now() }
func (c systemClock) Awake() time.Duration { return time.Since(c.start) }

// runTimings are every waiting time of the runner, in one place.
type runTimings struct {
	hold         time.Duration // a hold of the listener
	renew        time.Duration // a renewal of the lease during a run, a wait, or a pause
	idle         time.Duration // the idle watchdog
	watchdogTick time.Duration // how often the watchdog looks
	stopLadder   []ladderStep  // a member's stop, the watchdog, the cap
	infraLadder  []ladderStep  // the runner stopping, an entry removed, a lease lost, recovery
	pollGroup    time.Duration // how often a ladder looks whether a group is gone
	drain        time.Duration // the pipes after the program exited
	sendOnStop   time.Duration // sending what a stop wrote
	steps        time.Duration // a batch of steps
	attemptWaits []time.Duration
	sessionQuiet time.Duration // a session written outside the runner more recently is not resumed
	sessionCheck time.Duration
	folderPoll   time.Duration
	recheck      time.Duration // a paused entry's or an entry error's check again
	usageFirst   time.Duration // a usage limit with no reset said
	usageMax     time.Duration
	resend       time.Duration // the outbox again
	version      time.Duration // --version and sign-in checks
	registryPoll time.Duration
	removeWait   time.Duration // quadit run remove waiting for a serving runner
	asideFirst   time.Duration // trying again while a chat holds the project
	asideMax     time.Duration
	awayFirst    time.Duration // trying again while the server is away
	awayMax      time.Duration
}

// defaultTimings are the runner's times (agent-runs-contract.md §5.15).
var defaultTimings = runTimings{
	hold: waitHold, renew: time.Minute, idle: 30 * time.Minute, watchdogTick: 10 * time.Second,
	stopLadder:  []ladderStep{{sigInterrupt, 10 * time.Second}, {sigTerminate, 5 * time.Second}, {sigKill, time.Second}},
	infraLadder: []ladderStep{{sigTerminate, 2 * time.Second}, {sigKill, time.Second}},
	pollGroup:   20 * time.Millisecond, drain: 5 * time.Second, sendOnStop: time.Second, steps: 10 * time.Second,
	attemptWaits: []time.Duration{10 * time.Second, time.Minute}, sessionQuiet: 5 * time.Minute, sessionCheck: 30 * time.Second,
	folderPoll: time.Second, recheck: 5 * time.Minute, usageFirst: 30 * time.Minute, usageMax: 4 * time.Hour,
	resend: 30 * time.Second, version: 10 * time.Second, registryPoll: 2 * time.Second, removeWait: time.Minute,
	asideFirst: 2 * time.Second, asideMax: time.Minute, awayFirst: time.Second, awayMax: 30 * time.Second,
}

// runHost is what the runner takes from the computer: the home folder, the
// system folders, the clock and the times.
type runHost struct {
	home  string
	roots []string
	clock runClock
	times runTimings
}

func (h runHost) rules() folderRules { return folderRules{home: h.home, roots: h.roots} }

// systemHost is this computer.
func systemHost() (runHost, error) {
	home, err := os.UserHomeDir()
	return runHost{home: home, roots: systemRoots(), clock: systemClock{start: time.Now()}, times: defaultTimings}, err
}

// serving is one quadit run at work: what its entries share.
type serving struct {
	files  runFiles
	host   runHost
	print  *printer
	status *statusBoard

	machineMu sync.Mutex
	machine   machine // this computer as the registry names it now

	foldersMu sync.Mutex
	holders   map[string]string // who works in each folder now, by folder

	entriesMu sync.Mutex
	entries   map[string]*servedEntry
}

// servedEntry is an entry's goroutine, and the registry line it serves.
type servedEntry struct {
	e    *liveEntry
	reg  regEntry
	done chan struct{}
}

// newServing is a runner over files, printing to out.
func newServing(files runFiles, host runHost, m machine, out io.Writer, logPath string) *serving {
	return &serving{files: files, host: host, machine: m, holders: map[string]string{}, entries: map[string]*servedEntry{},
		print:  &printer{out: out, path: logPath, clock: host.clock},
		status: &statusBoard{path: files.status(), machine: m, clock: host.clock, entries: map[string]statusEntry{}}}
}

// machineNow is this computer as the registry names it now.
func (srv *serving) machineNow() machine {
	srv.machineMu.Lock()
	defer srv.machineMu.Unlock()
	return srv.machine
}

// setMachine takes a renamed machine from the registry, for later holds
// and the status.
func (srv *serving) setMachine(m machine) {
	srv.machineMu.Lock()
	changed := srv.machine != m
	srv.machine = m
	srv.machineMu.Unlock()
	if changed {
		srv.status.setMachine(m)
	}
}

// serve serves every entry of the registry until ctx ends, then stops each
// entry's program, keeps how each run ended, and returns. One runner
// serves a computer: a second is refused (exitAnotherRun).
func serve(ctx context.Context, files runFiles, host runHost, stdout, stderr io.Writer) int {
	if err := os.MkdirAll(files.dir, 0o700); err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	lock, err := takeRunnerLock(files)
	if errors.Is(err, errLocked) {
		fmt.Fprintf(stderr, "another quadit run serves this computer%s\n", runnerPID(files))
		return exitAnotherRun
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	defer lock.Close()
	// The machine is made before serving: every hold names it.
	reg, err := changeRegistry(ctx, files, func(*registry) error { return nil })
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	srv := newServing(files, host, reg.Machine, stdout, files.runnerLog())
	srv.status.setMachine(reg.Machine) // status.json says who serves, entries or not
	n := "entries"
	if len(reg.Entries) == 1 {
		n = "entry"
	}
	name := reg.Machine.Name
	if name == "" {
		name = "this computer"
	}
	srv.print.say(fmt.Sprintf("quadit run: serving %d %s on %s (stop with Ctrl-C)", len(reg.Entries), n, name))
	cleanRuns(files.runs(), host.clock.Now())
	cleaned := host.clock.Now()
	seen := registryMark(files.registry)
	srv.reconcile(ctx, reg)
	tick := time.NewTicker(host.times.registryPoll)
	defer tick.Stop()
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-tick.C:
			if mark := registryMark(files.registry); mark != seen {
				if next, err := readRegistry(files.registry); err == nil {
					seen, reg = mark, next
					srv.setMachine(reg.Machine)
				}
			}
			srv.reconcile(ctx, reg)
			if now := host.clock.Now(); now.Sub(cleaned) > 24*time.Hour {
				cleanRuns(files.runs(), now)
				cleaned = now
			}
		}
	}
	srv.entriesMu.Lock()
	running := make([]*servedEntry, 0, len(srv.entries))
	for _, s := range srv.entries {
		running = append(running, s)
	}
	srv.entriesMu.Unlock()
	for _, s := range running {
		<-s.done
	}
	return exitOK
}

// takeRunnerLock takes runner.lock, writing this process's id in it.
func takeRunnerLock(files runFiles) (*os.File, error) {
	f, err := os.OpenFile(files.runnerLock(), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := tryLock(f); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Truncate(0); err == nil {
		_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0) // the id is for the refusal of a second runner alone
	}
	return f, nil
}

// runnerPID is " (pid N)" of the runner holding runner.lock, or "".
func runnerPID(files runFiles) string {
	raw, err := os.ReadFile(files.runnerLock())
	if err != nil {
		return ""
	}
	if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
		return fmt.Sprintf(" (pid %d)", pid)
	}
	return ""
}

// serving reports whether a runner holds runner.lock now.
func runnerServing(files runFiles) bool {
	f, err := os.OpenFile(files.runnerLock(), os.O_RDWR, 0)
	if err != nil {
		return false
	}
	defer f.Close() // closing it lets a lock taken here go
	return errors.Is(tryLock(f), errLocked)
}

// registryMark is what changes when the registry is written again.
func registryMark(path string) string {
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d %d", st.ModTime().UnixNano(), st.Size())
}

// reconcile serves what the registry says: new entries start, entries
// gone or changed stop (a changed one starts again once stopped), and an
// entry marked removing lets its project go.
func (srv *serving) reconcile(ctx context.Context, reg registry) {
	srv.entriesMu.Lock()
	defer srv.entriesMu.Unlock()
	for id, s := range srv.entries {
		select {
		case <-s.done:
			delete(srv.entries, id)
			continue
		default:
		}
		i := slices.IndexFunc(reg.Entries, func(r regEntry) bool { return r.ID == id })
		switch {
		case i < 0:
			s.e.stop(errEntryGone)
		case reg.Entries[i].Removing && !s.reg.Removing:
			s.reg.Removing = true
			s.e.stop(errRemoving)
		case !sameServing(reg.Entries[i], s.reg):
			s.e.stop(errEntryGone)
		}
	}
	for _, r := range reg.Entries {
		if _, ok := srv.entries[r.ID]; ok {
			continue
		}
		e, err := newEntry(srv, r)
		if err != nil {
			srv.status.set(r.ID, entryStatus{State: statusError, Message: err.Error()}, nil)
			continue
		}
		s := &servedEntry{e: e, reg: r, done: make(chan struct{})}
		srv.entries[r.ID] = s
		go func() {
			defer close(s.done)
			e.serve(ctx)
			srv.status.drop(r.ID)
		}()
	}
}

// errEntryGone ends an entry the registry no longer holds as it was.
var errEntryGone = errors.New("the entry left the registry, or changed")

// sameServing reports whether two lines of the registry are served the
// same way: anything but the removing mark.
func sameServing(a, b regEntry) bool {
	a.Removing, b.Removing = false, false
	return a == b
}

// wait waits d, or less when ctx ends first.
func (srv *serving) wait(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// takeFolder takes a folder's lock for a run of handle's, or errLocked
// when another run holds it.
func (srv *serving) takeFolder(folder, handle string) (*os.File, error) {
	identity, err := fileIdentity(folder)
	if err != nil {
		return nil, err
	}
	path := srv.files.folderLock(identity)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := tryLock(f); err != nil {
		f.Close()
		return nil, err
	}
	srv.foldersMu.Lock()
	srv.holders[identity] = handle
	srv.foldersMu.Unlock()
	return f, nil
}

// releaseFolder lets a folder's lock go.
func (srv *serving) releaseFolder(folder string, f *os.File) {
	if identity, err := fileIdentity(folder); err == nil {
		srv.foldersMu.Lock()
		delete(srv.holders, identity)
		srv.foldersMu.Unlock()
	}
	f.Close()
}

// folderHolder is the agent whose run works in a folder now, when this
// runner knows.
func (srv *serving) folderHolder(folder string) string {
	identity, err := fileIdentity(folder)
	if err != nil {
		return ""
	}
	srv.foldersMu.Lock()
	defer srv.foldersMu.Unlock()
	return srv.holders[identity]
}

// pauseAgent pauses every entry of an agent on this computer for its
// program's usage limit: until the reset the program said, else for a
// back-off that doubles each time, from 30 minutes to 4 hours. It gives
// when the pause ends.
func (srv *serving) pauseAgent(of regEntry, resetsAt time.Time) time.Time {
	srv.entriesMu.Lock()
	var agents []*liveEntry
	for _, s := range srv.entries {
		if s.reg.Server == of.Server && s.reg.WorkspaceID == of.WorkspaceID && s.reg.AgentID == of.AgentID {
			agents = append(agents, s.e)
		}
	}
	srv.entriesMu.Unlock()
	now := srv.host.clock.Now()
	t := srv.host.times
	backoff := t.usageFirst
	for _, e := range agents {
		if e.reg.ID != of.ID {
			continue
		}
		e.state.read(func(s *entryState) {
			if s.Pause != nil && s.Pause.BackoffMinutes > 0 {
				backoff = min(time.Duration(s.Pause.BackoffMinutes)*time.Minute*2, t.usageMax)
			}
		})
	}
	until := now.Add(backoff)
	if resetsAt.After(now) {
		until = resetsAt
	}
	for _, e := range agents {
		_ = e.state.change(func(s *entryState) { // not written: this run of quadit holds the pause in memory
			s.Pause = &pauseState{Reason: core.PauseUsageLimit, Until: until.UnixMilli(), BackoffMinutes: int(backoff / time.Minute)}
		})
		e.sayEntry("paused: %s", pauseWords(core.PauseUsageLimit, e.prog.Title(), until))
	}
	return until
}

// drop removes an entry from the registry, once it let its project go.
func (srv *serving) drop(ctx context.Context, id string) {
	_, _ = changeRegistry(ctx, srv.files, func(reg *registry) error { // not dropped: the runner lets it go again at its next start
		reg.Entries = slices.DeleteFunc(reg.Entries, func(e regEntry) bool { return e.ID == id })
		return nil
	})
}

// runAdd is `quadit run add`: it checks the login, the project, the
// folder and the program, then writes the entry with its ids.
func runAdd(ctx context.Context, files runFiles, host runHost, fields map[string][]string, asJSON bool, stdout, stderr io.Writer) int {
	refuse := func(err error) int {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	login, project, folder, name := firstValue(fields["login"]), firstValue(fields["project"]), firstValue(fields["folder"]), firstValue(fields["program"])
	if login == "" || project == "" || folder == "" || name == "" {
		return refuse(errors.New("usage: quadit run add login=PATH project=KEY folder=PATH program=claude|codex [program_path=PATH] [max_minutes=N]"))
	}
	prog, ok := programs[name]
	if !ok {
		return refuse(errors.New("program= is claude or codex"))
	}
	maxMinutes := 0
	if v := firstValue(fields["max_minutes"]); v != "" {
		if maxMinutes, ok = wholeIn(v, 0, 7*24*60); !ok {
			return refuse(errors.New("max_minutes= is a number of minutes, from 0 (no limit) to 10080"))
		}
	}
	canon, label, err := host.rules().check(folder)
	if err != nil {
		return refuse(err)
	}
	path := firstValue(fields["program_path"])
	switch {
	case path == "":
		if path, err = exec.LookPath(name); err != nil {
			return refuse(fmt.Errorf("%s was not found on this computer: install it, or give program_path=", prog.Title()))
		}
	case !filepath.IsAbs(path):
		return refuse(errors.New("program_path= must be an absolute path"))
	}
	if path, err = filepath.Abs(path); err != nil {
		return refuse(err)
	}
	if err := canStartIn(path, canon); err != nil {
		return refuse(err)
	}
	version, err := programVersionOf(ctx, path, host.times.version)
	if err != nil {
		return refuse(fmt.Errorf("%s was not found on this computer: install it, or give program_path=", prog.Title()))
	}
	if login, err = filepath.Abs(login); err != nil {
		return refuse(err)
	}
	c, err := loginClient(login)
	if err != nil {
		return refuse(err)
	}
	api := entryAPI{c: c}
	me, err := api.me(ctx)
	if err != nil {
		return refuse(err)
	}
	switch {
	case me.Kind != "agent":
		return refuse(fmt.Errorf("this login is %s's, a person's: Quadit runs an agent with the agent's own login", me.Handle))
	case me.ReadOnly:
		return refuse(errors.New("this login may only read: Quadit runs an agent whose login may write"))
	case me.Workspace.ID == "" || me.UserID == "":
		return refuse(errServerOld)
	}
	projects, err := api.projects(ctx)
	if err != nil {
		return refuse(err)
	}
	i := slices.IndexFunc(projects, func(p projectRow) bool {
		return strings.EqualFold(p.Key, project) || strings.EqualFold(p.Name, project)
	})
	if i < 0 {
		keys := ""
		if len(me.Projects) > 0 {
			keys = " (it may work in " + strings.Join(me.Projects, ", ") + ")"
		}
		return refuse(fmt.Errorf("%s may not work in %s: quadit me lists its projects%s", me.Handle, project, keys))
	}
	p := projects[i]
	entry := regEntry{ID: randomHex(4), Server: c.URL, WorkspaceID: me.Workspace.ID, Workspace: me.Workspace.Slug, AgentID: me.UserID, Agent: me.Handle,
		Login: login, ProjectID: p.ID, Project: p.Key, Folder: canon, Program: name, ProgramPath: path, Mode: modeInPlace, MaxMinutes: maxMinutes,
		AddedAt: host.clock.Now().UTC().Format(time.RFC3339)}
	reg, err := changeRegistry(ctx, files, func(reg *registry) error {
		for _, o := range reg.Entries {
			switch {
			case o.sameAgentAndProject(entry):
				return fmt.Errorf("%s already runs %s on this computer, in %s", entry.Agent, o.Project, host.rules().label(o.Folder))
			case o.Folder == entry.Folder && (o.Server != entry.Server || o.WorkspaceID != entry.WorkspaceID || o.ProjectID != entry.ProjectID):
				return fmt.Errorf("%s already runs %s on this computer: one project per folder", label, o.Project)
			}
		}
		reg.Entries = append(reg.Entries, entry)
		return nil
	})
	if err != nil {
		return refuse(err)
	}
	if asJSON {
		fmt.Fprintln(stdout, strings.TrimSpace(string(plainJSON(entry))))
		return exitOK
	}
	fmt.Fprintf(stdout, "Added: %s runs %s in %s with %s %s on %s.\n", entry.Agent, entry.Project, label, prog.Title(), version, reg.Machine.Name)
	return exitOK
}

// runRemove is `quadit run remove`: each entry matched stops its run, has
// how the run ended sent, lets its project go, and is dropped. A serving
// runner does that (the entry is marked removing, and this waits); with
// none, this does it.
func runRemove(ctx context.Context, files runFiles, host runHost, pos []string, fields map[string][]string, stdout, stderr io.Writer) int {
	login, project := firstValue(fields["login"]), firstValue(fields["project"])
	if (len(pos) == 0) == (login == "") {
		fmt.Fprintln(stderr, "usage: quadit run remove ENTRY_ID | login=PATH [project=KEY]")
		return exitFailed
	}
	if login != "" {
		abs, err := filepath.Abs(login)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return exitFailed
		}
		login = abs
	}
	matches := func(e regEntry) bool {
		if len(pos) > 0 {
			return e.ID == pos[0]
		}
		return e.Login == login && (project == "" || strings.EqualFold(e.Project, project))
	}
	if err := os.MkdirAll(files.dir, 0o700); err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	// Holding runner.lock, this is the runner: none starts meanwhile.
	lock, err := takeRunnerLock(files)
	if err != nil && !errors.Is(err, errLocked) {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	var matched []regEntry
	reg, err := changeRegistry(ctx, files, func(reg *registry) error {
		for i := range reg.Entries {
			if matches(reg.Entries[i]) {
				reg.Entries[i].Removing = true
				matched = append(matched, reg.Entries[i])
			}
		}
		return nil
	})
	if err != nil {
		if lock != nil {
			lock.Close()
		}
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	if len(matched) == 0 {
		if lock != nil {
			lock.Close()
		}
		fmt.Fprintln(stdout, "Nothing to remove.")
		return exitOK
	}
	if lock != nil {
		// No runner serves: this sends what the entries left, and lets them go.
		defer lock.Close()
		srv := newServing(files, host, reg.Machine, io.Discard, "")
		for _, r := range matched {
			e, err := newEntry(srv, r)
			if err != nil {
				continue
			}
			e.recover(ctx)
			if e.verifyLogin(ctx) != nil {
				continue // nothing is sent with a login not verified: the entry stays, removing
			}
			_, _ = e.out.add(outboxWrite{Write: writeRelease, Release: &pendingRelease{Project: e.projectKey, MachineID: reg.Machine.ID}}) // not stored: the entry stays, removing
			if e.flush(ctx) == nil && e.out.empty() {
				srv.drop(ctx, r.ID)
			}
		}
	} else {
		deadline := time.Now().Add(host.times.removeWait)
		for time.Now().Before(deadline) && ctx.Err() == nil {
			now, err := readRegistry(files.registry)
			if err == nil && !slices.ContainsFunc(now.Entries, func(e regEntry) bool {
				return slices.ContainsFunc(matched, func(m regEntry) bool { return m.ID == e.ID })
			}) {
				break
			}
			time.Sleep(host.times.registryPoll)
		}
	}
	now, err := readRegistry(files.registry)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	code := exitOK
	for _, m := range matched {
		if slices.ContainsFunc(now.Entries, func(e regEntry) bool { return e.ID == m.ID }) {
			fmt.Fprintf(stdout, "Quadit is still telling the server how %s's last run ended; it is removed once the server answers.\n", m.Agent)
			code = exitFailed
			continue
		}
		fmt.Fprintf(stdout, "Removed: %s no longer runs %s on this computer.\n", m.Agent, m.Project)
	}
	return code
}

// runList is `quadit run list`: the entries, with what each is doing now
// when a runner serves.
func runList(files runFiles, host runHost, asJSON bool, stdout, stderr io.Writer) int {
	reg, err := readRegistry(files.registry)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	serving := runnerServing(files)
	status := statusFile{}
	if serving {
		status = readStatus(files.status())
	}
	if asJSON {
		type listed struct {
			regEntry
			Status *statusEntry `json:"status,omitempty"`
		}
		out := struct {
			Machine machine  `json:"machine"`
			Serving bool     `json:"serving"`
			Entries []listed `json:"entries"`
		}{Machine: reg.Machine, Serving: serving, Entries: []listed{}}
		for _, e := range reg.Entries {
			l := listed{regEntry: e}
			if st, ok := status.Entries[e.ID]; ok && serving {
				l.Status = &st
			}
			out.Entries = append(out.Entries, l)
		}
		fmt.Fprintln(stdout, strings.TrimSpace(string(plainJSON(out))))
		return exitOK
	}
	if len(reg.Entries) == 0 {
		fmt.Fprintln(stdout, "Nothing runs on this computer: quadit run add registers an agent's project.")
		return exitOK
	}
	for _, e := range reg.Entries {
		title := e.Program
		if p, ok := programs[e.Program]; ok {
			title = p.Title()
		}
		words := "not served: no quadit run is running"
		switch st, ok := status.Entries[e.ID]; {
		case e.Removing:
			words = "removing"
		case serving && ok:
			words = listWords(st, title)
		case serving:
			words = "starting"
		}
		fmt.Fprintf(stdout, "%s  %s  %s  %s  %s  %s\n", e.ID, e.Agent, e.Project, host.rules().label(e.Folder), title, words)
	}
	return exitOK
}

// runMachine is `quadit run machine name="…"`: this computer's name, as
// servers show it.
func runMachine(ctx context.Context, files runFiles, fields map[string][]string, stdout, stderr io.Writer) int {
	name := strings.TrimSpace(firstValue(fields["name"]))
	if name == "" || utf8.RuneCountInString(name) > 64 || strings.ContainsFunc(name, unicode.IsControl) {
		fmt.Fprintln(stderr, "name= is this computer's name: 1 to 64 characters")
		return exitFailed
	}
	if _, err := changeRegistry(ctx, files, func(reg *registry) error {
		reg.Machine.Name = name
		return nil
	}); err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	fmt.Fprintf(stdout, "This computer is now %q.\n", name)
	return exitOK
}

// runWaiting says what a runner set up now for the agent of the login
// file and the project would start at once: the tasks with items that
// wait on the agent there, the first five named. It asks the server and
// changes nothing.
func runWaiting(ctx context.Context, fields map[string][]string, asJSON bool, stdout, stderr io.Writer) int {
	login, project := firstValue(fields["login"]), firstValue(fields["project"])
	if login == "" || project == "" {
		fmt.Fprintln(stderr, "usage: quadit run waiting login=PATH project=KEY [--json]")
		return exitFailed
	}
	c, err := loginClient(login)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	answer, raw, err := entryAPI{c: c}.waiting(ctx, project)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitFailed
	}
	if asJSON {
		fmt.Fprintln(stdout, strings.TrimSpace(string(raw)))
		return exitOK
	}
	// What the server said is printed only in its form, a line each, as
	// an item's line is (line).
	agent, project := "the agent", "this project"
	if handleForm.MatchString(answer.Agent) {
		agent = answer.Agent
	}
	if keyForm.MatchString(answer.Project) {
		project = answer.Project
	}
	switch answer.Runs {
	case 0:
		fmt.Fprintf(stdout, "Nothing waits on %s in %s: Quadit starts it with what comes next.\n", agent, project)
		return exitOK
	case 1:
		fmt.Fprintf(stdout, "1 run starts when Quadit runs %s in %s:\n", agent, project)
	default:
		fmt.Fprintf(stdout, "%d runs start when Quadit runs %s in %s:\n", answer.Runs, agent, project)
	}
	for _, t := range answer.Tasks {
		row := []string{}
		if taskForm.MatchString(t.Key) {
			row = append(row, t.Key)
		}
		fmt.Fprintf(stdout, "  %s\n", strings.Join(append(row, quotable(t.Title)), "  "))
	}
	if more := answer.Runs - len(answer.Tasks); more > 0 {
		fmt.Fprintf(stdout, "  and %d more\n", more)
	}
	return exitOK
}
