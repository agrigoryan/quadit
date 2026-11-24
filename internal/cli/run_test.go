//go:build unix

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/fakeagent"
)

// runTest is quadit run serving one entry against a fake server, with the
// test binary itself as the agent's program (the fake agent), everything
// in a temporary folder: home, the project's folder, the login, the
// registry and the runner's files.
type runTest struct {
	t       *testing.T
	f       *fakeQuadit
	url     string
	dir     string
	home    string
	folder  string // canonical
	login   string
	files   runFiles
	scripts string
	record  string
	out     *syncBuffer
	clock   *testClock
	entry   regEntry
	times   runTimings
	poll    time.Duration // how often eventually looks

	cancel context.CancelFunc
	done   chan int
}

// testTimings are the runner's times made short, so no test waits on the
// real ones; the idle watchdog's limit stays, driven by the test clock.
func testTimings() runTimings {
	return runTimings{
		hold: waitHold, renew: 30 * time.Millisecond, idle: 30 * time.Minute, watchdogTick: 5 * time.Millisecond,
		stopLadder:  []ladderStep{{sigInterrupt, 300 * time.Millisecond}, {sigTerminate, 300 * time.Millisecond}, {sigKill, time.Second}},
		infraLadder: []ladderStep{{sigTerminate, 300 * time.Millisecond}, {sigKill, time.Second}},
		pollGroup:   2 * time.Millisecond, drain: 300 * time.Millisecond, sendOnStop: time.Second, steps: 20 * time.Millisecond,
		attemptWaits: []time.Duration{5 * time.Millisecond, 5 * time.Millisecond}, sessionQuiet: 5 * time.Minute, sessionCheck: 10 * time.Millisecond,
		folderPoll: 5 * time.Millisecond, recheck: 50 * time.Millisecond, usageFirst: 30 * time.Minute, usageMax: 4 * time.Hour,
		resend: 10 * time.Millisecond, version: 10 * time.Second, registryPoll: 10 * time.Millisecond, removeWait: 10 * time.Second,
		asideFirst: 5 * time.Millisecond, asideMax: 20 * time.Millisecond, awayFirst: 5 * time.Millisecond, awayMax: 20 * time.Millisecond,
	}
}

// testClock is a clock a test moves: the wall clock jumps by what jump
// adds; the time awake is the real one, or, once held, only what advance
// adds.
type testClock struct {
	mu        sync.Mutex
	start     time.Time
	jumped    time.Duration
	held      bool
	awakeHeld time.Duration
}

func newTestClock() *testClock { return &testClock{start: time.Now()} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.jumped)
}

func (c *testClock) Awake() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.held {
		return c.awakeHeld
	}
	return time.Since(c.start)
}

// jump moves the wall clock, as a computer that slept wakes to.
func (c *testClock) jump(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.jumped += d
}

// holdAwake stops the time awake where it is; advance moves it.
func (c *testClock) holdAwake() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.awakeHeld, c.held = time.Since(c.start), true
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.awakeHeld += d
}

// testRoots are the system folders, but those the tests' temporary folders
// are under.
func testRoots() []string {
	return slices.DeleteFunc(slices.Clone(systemRoots), func(r string) bool { return r == "/private" || r == "/var" || r == "/tmp" })
}

// The machine of the tests' registries.
var testMachine = machine{ID: "3f9c0a7d5e21b864", Name: "Test Mac"}

// newRunTest makes a runner's world with one entry of program, whose
// program plays scripts, one per start.
func newRunTest(t *testing.T, program string, scripts ...[]fakeagent.Step) *runTest {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rt := &runTest{t: t, f: newFakeQuadit(), dir: dir, home: filepath.Join(dir, "home"), out: &syncBuffer{}, clock: newTestClock(), times: testTimings(), poll: 3 * time.Millisecond}
	rt.folder = filepath.Join(rt.home, "devel", "game")
	for _, d := range []string{rt.folder, filepath.Join(dir, "config")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	rt.url = serveFake(t, rt.f)
	rt.login = filepath.Join(dir, "config", program+".json")
	token := agentToken
	if program == core.ProgramCodex {
		token = codexToken
	}
	writeJSON(t, rt.login, map[string]string{"url": rt.url, "token": token})
	rt.scripts, rt.record = filepath.Join(dir, "scripts.json"), filepath.Join(dir, "record.jsonl")
	rt.setScripts(scripts...)
	t.Setenv("FAKEAGENT", program)
	// A test binary built with -race sleeps a second as it exits, unless told
	// not to: the fake program is one, started many times.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	t.Setenv("FAKEAGENT_SCRIPTS", rt.scripts)
	t.Setenv("FAKEAGENT_RECORD", rt.record)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	rt.files = runFiles{registry: filepath.Join(dir, "config", "runner.json"), dir: filepath.Join(dir, "config", "runner")}
	agentID, agent := fakeAgentID, "@claude"
	if program == core.ProgramCodex {
		agentID, agent = fakeCodexID, "@codex"
	}
	rt.entry = regEntry{ID: "e5d2a91c", Server: rt.url, WorkspaceID: fakeWorkspaceID, Workspace: "personal", AgentID: agentID, Agent: agent,
		Login: rt.login, ProjectID: fakeProjectID, Project: "SVA", Folder: rt.folder, Program: program, ProgramPath: exe, Mode: modeInPlace,
		AddedAt: "2026-11-24T14:02:00Z"}
	rt.writeRegistry(rt.entry)
	t.Cleanup(rt.cleanup)
	return rt
}

// setScripts gives the fake program its scripts, the starts counted anew.
func (rt *runTest) setScripts(scripts ...[]fakeagent.Step) {
	rt.t.Helper()
	if scripts == nil {
		scripts = [][]fakeagent.Step{}
	}
	writeJSON(rt.t, rt.scripts, scripts)
	marks, _ := filepath.Glob(rt.scripts + ".start-*")
	for _, m := range marks {
		os.Remove(m)
	}
}

// writeRegistry writes the registry with these entries.
func (rt *runTest) writeRegistry(entries ...regEntry) {
	rt.t.Helper()
	if err := os.MkdirAll(rt.files.dir, 0o700); err != nil {
		rt.t.Fatal(err)
	}
	if err := writeWhole(rt.files.registry, plainJSON(registry{Version: 1, Machine: testMachine, Entries: entries})); err != nil {
		rt.t.Fatal(err)
	}
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// host is the test's computer.
func (rt *runTest) host() runHost {
	return runHost{home: rt.home, roots: testRoots(), clock: rt.clock, times: rt.times}
}

// serve starts quadit run.
func (rt *runTest) serve() {
	ctx, cancel := context.WithCancel(context.Background())
	rt.cancel, rt.done = cancel, make(chan int, 1)
	go func() { rt.done <- serve(ctx, rt.files, rt.host(), rt.out, rt.out) }()
}

// stop stops quadit run as SIGINT or SIGTERM does, and gives its exit
// code.
func (rt *runTest) stop() int {
	rt.t.Helper()
	if rt.cancel == nil {
		return -1
	}
	rt.cancel()
	rt.cancel = nil
	select {
	case code := <-rt.done:
		return code
	case <-time.After(15 * time.Second):
		rt.t.Fatalf("quadit run did not stop; it said:\n%s", rt.out)
		return -1
	}
}

// cleanup stops the runner and whatever the fake program left, whatever
// the test did.
func (rt *runTest) cleanup() {
	if rt.cancel != nil {
		rt.cancel()
		select {
		case <-rt.done:
		case <-time.After(15 * time.Second):
		}
	}
	for _, r := range fakeagent.Records(rt.record) {
		for _, pid := range []int{r.PID, r.Child} {
			if pid > 0 {
				_ = syscall.Kill(-pid, syscall.SIGKILL) // a group left by a failed test
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	}
}

// eventually waits until cond holds, or fails the test saying what was
// awaited and what the runner printed.
func (rt *runTest) eventually(what string, cond func() bool) {
	rt.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			status, _ := os.ReadFile(rt.files.status())
			rt.t.Fatalf("waited for %s; quadit run said:\n%s\nstatus.json: %s\nchanges (fake server): %s", what, rt.out, status, rt.changeTypes())
		}
		time.Sleep(rt.poll)
	}
}

// changeTypes says which changes the server got, for a failure's message.
func (rt *runTest) changeTypes() string {
	var b strings.Builder
	for _, ch := range rt.f.changeList() {
		raw, _ := json.Marshal(ch.Args)
		b.WriteString("\n  " + ch.Type + " " + string(raw))
	}
	return b.String()
}

// runState is the state of the nth run row (from 0), "" for none.
func (rt *runTest) runState(n int) string {
	runs := rt.f.allRuns()
	if n >= len(runs) {
		return ""
	}
	s, _ := runs[n]["state"].(string)
	return s
}

// ended waits until the nth run row has ended, and gives it.
func (rt *runTest) ended(n int) map[string]any {
	rt.t.Helper()
	rt.eventually("run "+string(rune('0'+n))+" to end", func() bool { return ended(rt.runState(n)) })
	return rt.f.allRuns()[n]
}

// acked waits until the cursor is past seq.
func (rt *runTest) acked(seq int64) {
	rt.t.Helper()
	rt.eventually("the head to be acknowledged", func() bool { return rt.f.cursorAt() >= seq })
}

// records are the fake program's starts (not its children).
func (rt *runTest) records() []fakeagent.Record {
	return slices.DeleteFunc(fakeagent.Records(rt.record), func(r fakeagent.Record) bool { return r.PID == 0 })
}

// children are the pids of the grandchildren the fake program started.
func (rt *runTest) children() []int {
	var out []int
	for _, r := range fakeagent.Records(rt.record) {
		if r.Child > 0 {
			out = append(out, r.Child)
		}
	}
	return out
}

// alive reports whether a process lives (a zombie not reaped counts as gone).
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && len(bytes.TrimSpace(out)) > 0 && !bytes.HasPrefix(bytes.TrimSpace(out), []byte("Z"))
}

// changesOf are the changes the server got of a type, in order.
func (rt *runTest) changesOf(typ string) []fakeChange {
	return slices.DeleteFunc(rt.f.changeList(), func(ch fakeChange) bool { return ch.Type != typ })
}

// The scripts' output lines, as the programs print them.
func claudeInit() fakeagent.Step {
	return fakeagent.Step{Out: `{"type":"system","subtype":"init","session_id":"{session}","cwd":"/x","tools":["Bash"]}`}
}

func claudeSays(text string) fakeagent.Step {
	raw, _ := json.Marshal(map[string]any{"type": "assistant", "session_id": "{session}", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}})
	return fakeagent.Step{Out: string(raw)}
}

func claudeRunsBash(description string) fakeagent.Step {
	raw, _ := json.Marshal(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
		map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{"command": "go test ./... && cat ~/.ssh/id_rsa", "description": description}}}}})
	return fakeagent.Step{Out: string(raw)}
}

func claudeEnds(final string) fakeagent.Step {
	raw, _ := json.Marshal(map[string]any{"type": "result", "subtype": "success", "is_error": false, "result": final, "session_id": "{session}"})
	return fakeagent.Step{Out: string(raw)}
}

func exit(n int) fakeagent.Step { return fakeagent.Step{Exit: &n} }

// claudeDone is a Claude Code run that takes the prompt and ends well.
func claudeDone(final string) []fakeagent.Step {
	return []fakeagent.Step{claudeInit(), claudeSays("On it."), claudeEnds(final)}
}

// codexDone is a Codex run that takes the prompt and ends well; its
// thread is {thread} fresh, {session} resumed.
func codexDone(thread, final string) []fakeagent.Step {
	return []fakeagent.Step{
		{Out: `{"type":"thread.started","thread_id":"` + thread + `"}`},
		{Out: `{"type":"turn.started"}`},
		{Out: `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"` + final + `"}}`},
		{Last: final},
		{Out: `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`},
	}
}

// untilSignal is a run whose program takes the prompt, then works until
// it is stopped.
func untilSignal() []fakeagent.Step {
	return []fakeagent.Step{claudeInit(), claudeSays("Working."), {UntilSignal: []string{`{"type":"system","subtype":"stopping"}`}}, exit(130)}
}

// running waits until the nth run is running.
func (rt *runTest) running(n int) map[string]any {
	rt.t.Helper()
	rt.eventually("run to be running", func() bool { return rt.runState(n) == core.AgentSessionRunning })
	return rt.f.allRuns()[n]
}

func TestQuaditRunWithSecretIsStillTheSecretsRunner(t *testing.T) {
	srv := serveFakeSecrets(t)
	t.Setenv("QUADIT_URL", srv)
	t.Setenv("QUADIT_TOKEN", "t")
	var out, errs bytes.Buffer
	code := Run([]string{"run", "--secret", "KEY", "--", "sh", "-c", `echo "the key is $KEY"`}, &out, &errs)
	if code != 0 || out.String() != "the key is •••\n" {
		t.Fatalf("exit %d, printed %q %q", code, out.String(), errs.String())
	}
}

// serveFakeSecrets answers POST /secrets/env with one secret.
func serveFakeSecrets(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"env":{"KEY":"hunter22"}}`)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestTheRunnerFormsNeedNoDefaultLogin(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	t.Setenv("QUADIT_CONFIG", filepath.Join(rt.dir, "no-login.json"))
	var out, errs bytes.Buffer
	if code := Run([]string{"run", "list", "registry=" + rt.files.registry}, &out, &errs); code != 0 {
		t.Fatalf("quadit run list without a login: exit %d, %s", code, errs.String())
	}
	if !strings.Contains(out.String(), "e5d2a91c  @claude  SVA") || !strings.Contains(out.String(), "not served: no quadit run is running") {
		t.Fatalf("quadit run list printed %q", out.String())
	}
}

func TestAnotherRunnerExitsWithThree(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	_ = os.MkdirAll(rt.files.dir, 0o700)
	lock, err := takeRunnerLock(rt.files)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	var out, errs bytes.Buffer
	code := Run([]string{"run", "registry=" + rt.files.registry}, &out, &errs)
	if want := "another quadit run serves this computer (pid " + strconv.Itoa(os.Getpid()) + ")\n"; code != 3 || errs.String() != want {
		t.Fatalf("exit %d, said %q, want 3 and %q", code, errs.String(), want)
	}
}

func TestEachEntryUsesItsOwnLoginAndLeaseFile(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	otherLogin := filepath.Join(rt.dir, "other", "codex.json")
	_ = os.MkdirAll(filepath.Dir(otherLogin), 0o700)
	writeJSON(t, otherLogin, map[string]string{"url": rt.url, "token": codexToken})
	second := rt.entry
	second.ID, second.AgentID, second.Agent, second.Login = "0000bbbb", fakeCodexID, "@codex", otherLogin
	rt.writeRegistry(rt.entry, second)
	rt.serve()
	rt.eventually("both logins holding", func() bool {
		by := map[string]bool{}
		for _, q := range rt.f.holdList() {
			by[q.Get("token")] = true
		}
		return by["@claude"] && by["@codex"]
	})
	for _, dir := range []string{filepath.Dir(rt.login), filepath.Dir(otherLogin)} {
		if files, _ := filepath.Glob(filepath.Join(dir, "listen-*.lease")); len(files) != 1 {
			t.Fatalf("%s holds lease files %v, want one", dir, files)
		}
	}
}

func TestAnEntryStartsWhenItIsAddedAndStopsWhenItIsRemoved(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	rt.writeRegistry()
	rt.serve()
	rt.eventually("the runner serving", func() bool { return strings.Contains(rt.out.String(), "serving 0 entries") })
	rt.writeRegistry(rt.entry)
	rt.eventually("the entry listening", func() bool { return strings.Contains(rt.out.String(), "SVA @claude ~/devel/game: listening") })
	rt.writeRegistry()
	rt.eventually("the entry gone from status.json", func() bool { _, ok := readStatus(rt.files.status()).Entries[rt.entry.ID]; return !ok })
	held := len(rt.f.holdList())
	time.Sleep(100 * time.Millisecond)
	if now := len(rt.f.holdList()); now > held+1 {
		t.Fatalf("an entry removed from the registry still holds: %d holds, then %d", held, now)
	}
}

func TestRemovingAnEntryEndsItsRunSendsItsRecordThenReleases(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, untilSignal())
	head := rt.f.addItem(fakeItem{Task: "SVA-12", Type: "assigned"})
	rt.serve()
	rt.running(0)
	var out bytes.Buffer
	code := runRemove(context.Background(), rt.files, rt.host(), []string{rt.entry.ID}, map[string][]string{}, &out, &out)
	if code != 0 || out.String() != "Removed: @claude no longer runs SVA on this computer.\n" {
		t.Fatalf("remove: %d %q\n%s", code, out.String(), rt.out)
	}
	row := rt.f.allRuns()[0]
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunInterrupted {
		t.Fatalf("the run ended %v\n%s", row, rt.out)
	}
	calls := rt.f.callList()
	end, ack, release := slices.Index(calls, "session.update"), slices.Index(calls, "ack"), slices.Index(calls, "release")
	if release < 0 || slices.ContainsFunc(calls[release:], func(c string) bool { return c != "release" }) || ack < 0 || end < 0 {
		t.Fatalf("the writes came %v: the release must come last", calls)
	}
	if rt.f.cursorAt() != head {
		t.Fatalf("the head of a run that took the prompt is acknowledged; the cursor is at %d", rt.f.cursorAt())
	}
	if alive(rt.records()[0].PID) {
		t.Fatal("the program still runs")
	}
	if reg, _ := readRegistry(rt.files.registry); len(reg.Entries) != 0 {
		t.Fatalf("the registry still holds %+v", reg.Entries)
	}
}

func TestARunnerNeverTakesTheLeaseFromAChat(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	rt.f.set(func(f *fakeQuadit) { f.chat = true })
	rt.f.addItem(fakeItem{Task: "SVA-1"})
	rt.serve()
	rt.eventually("a few holds refused", func() bool { return len(rt.f.holdList()) >= 4 })
	for _, q := range rt.f.holdList() {
		if q.Has("take") {
			t.Fatalf("a hold asked to take the lease: %v", q)
		}
	}
	if st := readStatus(rt.files.status()).Entries[rt.entry.ID]; st.State != statusAside {
		t.Fatalf("status %+v, want aside", st)
	}
	if !strings.Contains(rt.out.String(), "SVA @claude ~/devel/game: a chat listens to SVA; trying again in") || len(rt.records()) != 0 {
		t.Fatalf("said:\n%s", rt.out)
	}
}

func TestAChatTakingOverDuringARunInterruptsItWithoutAcknowledging(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, untilSignal())
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.running(0)
	rt.f.set(func(f *fakeQuadit) { f.lease = "ZZZZ2222" }) // a chat took the lease (take=1)
	row := rt.ended(0)
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunInterrupted {
		t.Fatalf("the run ended %v", row)
	}
	rt.eventually("the program stopped", func() bool { return !alive(rt.records()[0].PID) })
	if len(rt.f.ackList()) != 0 {
		t.Fatalf("the head was acknowledged after the lease was lost: %v", rt.f.ackList())
	}
	if !strings.Contains(rt.out.String(), "SVA-12 @claude: interrupted: a chat took SVA over") {
		t.Fatalf("said:\n%s", rt.out)
	}
}

func TestQuaditRunListSaysWhatEachEntryDoes(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	rt.serve()
	rt.eventually("ready", func() bool { return readStatus(rt.files.status()).Entries[rt.entry.ID].State == statusReady })
	var out bytes.Buffer
	runList(rt.files, rt.host(), false, &out, &out)
	if out.String() != "e5d2a91c  @claude  SVA  ~/devel/game  Claude Code  ready\n" {
		t.Fatalf("list printed %q", out.String())
	}
	out.Reset()
	runList(rt.files, rt.host(), true, &out, &out)
	var listed struct {
		Serving bool
		Entries []struct {
			ID     string
			Status *statusEntry
		}
	}
	if err := json.Unmarshal(out.Bytes(), &listed); err != nil || !listed.Serving || listed.Entries[0].Status == nil || listed.Entries[0].Status.State != statusReady {
		t.Fatalf("list --json printed %s (%v)", out.String(), err)
	}
	rt.stop()
	out.Reset()
	runList(rt.files, rt.host(), true, &out, &out)
	if strings.Contains(out.String(), `"status"`) || !strings.Contains(out.String(), `"serving": false`) {
		t.Fatalf("list --json with no runner printed %s", out.String())
	}
}

// testServe is how a test starts the test binary as quadit run in a
// process of its own (QUADIT_TEST_SERVE, read by TestMain): the registry,
// the home folder, the program it fakes.
type testServe struct {
	Registry  string `json:"registry"`
	Home      string `json:"home"`
	FakeAgent string `json:"fake_agent"`
}

// serveForTest serves as quadit run does, on the test's computer, until
// SIGINT or SIGTERM (or SIGKILL, which is what such a test sends). The
// programs it starts are the fake agent.
func serveForTest(spec string) int {
	var s testServe
	if err := json.Unmarshal([]byte(spec), &s); err != nil {
		return 2
	}
	_ = os.Setenv("FAKEAGENT", s.FakeAgent) // for its children: this process is past fakeagent.Main
	files, err := runFilesFor(s.Registry)
	if err != nil {
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	host := runHost{home: s.Home, roots: testRoots(), clock: systemClock{start: time.Now()}, times: testTimings()}
	return serve(ctx, files, host, os.Stdout, os.Stderr)
}

// serveApart starts quadit run in a process of its own, its output in
// out, and gives the process.
func (rt *runTest) serveApart(out io.Writer) *exec.Cmd {
	rt.t.Helper()
	exe, _ := os.Executable()
	spec, _ := json.Marshal(testServe{Registry: rt.files.registry, Home: rt.home, FakeAgent: os.Getenv("FAKEAGENT")})
	cmd := exec.Command(exe, "-test.run=^$")
	cmd.Env = append(slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "FAKEAGENT=") }), "QUADIT_TEST_SERVE="+string(spec))
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		rt.t.Fatal(err)
	}
	rt.t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd
}

func TestTheMachineExistsBeforeServingAndARenameIsUsed(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	_ = os.Remove(rt.files.registry)
	rt.serve()
	var made machine
	rt.eventually("the machine made before serving", func() bool {
		reg, err := readRegistry(rt.files.registry)
		made = reg.Machine
		return err == nil && regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(made.ID) && readStatus(rt.files.status()).Machine == made
	})
	entry := rt.entry
	_, err := changeRegistry(context.Background(), rt.files, func(reg *registry) error {
		reg.Entries = append(reg.Entries, entry)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.eventually("holds naming the machine", func() bool {
		holds := rt.f.holdList()
		return len(holds) > 0 && holds[len(holds)-1].Get("machine_id") == made.ID
	})
	var out bytes.Buffer
	if code := runMachine(context.Background(), rt.files, map[string][]string{"name": {"Renamed Mac"}}, &out, &out); code != 0 {
		t.Fatal(out.String())
	}
	rt.eventually("the new name in holds and the status", func() bool {
		holds := rt.f.holdList()
		return holds[len(holds)-1].Get("machine_name") == "Renamed Mac" && readStatus(rt.files.status()).Machine.Name == "Renamed Mac"
	})
}

func TestTheFolderIsLetGoBeforeTheEndIsSent(t *testing.T) {
	slow := []fakeagent.Step{claudeInit(), claudeSays("On it."), {SleepMS: 200}, claudeEnds("done")}
	rt := newRunTest(t, core.ProgramClaude, slow, claudeDone("done"))
	otherLogin := filepath.Join(rt.dir, "other", "claude.json")
	_ = os.MkdirAll(filepath.Dir(otherLogin), 0o700)
	writeJSON(t, otherLogin, map[string]string{"url": rt.url, "token": codexToken})
	second := rt.entry
	second.ID, second.AgentID, second.Agent, second.Login = "0000bbbb", fakeCodexID, "@codex", otherLogin
	rt.writeRegistry(rt.entry, second)
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.running(0)
	// @claude's writes cannot reach the server from now on: its run ends,
	// and its end waits to be sent.
	rt.f.set(func(f *fakeQuadit) { f.changesAwayFor = "@claude" })
	rt.eventually("@claude's run ended on this computer", func() bool { return strings.Contains(rt.out.String(), "SVA-12 @claude: done in") })
	rt.f.addItem(fakeItem{Task: "SVA-13", For: fakeCodexID})
	rt.eventually("@codex's run done in the same folder", func() bool { return rt.runState(1) == core.AgentSessionDone })
	if rt.runState(0) != core.AgentSessionRunning {
		t.Fatalf("@claude's end reached the server: %v", rt.f.allRuns()[0])
	}
}
