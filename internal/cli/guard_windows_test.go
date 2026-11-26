//go:build windows

package cli

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/fakeagent"
)

// guardApart starts the test binary as `quadit guard` of spec.Guard, as
// the desktop app does: with no console of its own, its standard input a
// pipe the test holds, in dir. Its outputs go to stdout and stderr.
func guardApart(t *testing.T, dir string, spec testServe, stdout, stderr io.Writer) (*exec.Cmd, io.WriteCloser) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(spec)
	cmd := exec.Command(exe, "-test.run=^$")
	// The guard is no fake agent itself: what it guards may be one (spec.GuardEnv).
	cmd.Env = append(slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "FAKEAGENT=") }),
		"QUADIT_TEST_SERVE="+string(raw), appGuard+"=1") // as the app starts it
	cmd.Dir, cmd.Stdout, cmd.Stderr = dir, stdout, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS}
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return cmd, input
}

// fakeToGuard is a fake agent's world for the guard to start: its scripts
// and its record, in dir; GuardEnv makes the guarded program the fake.
func fakeToGuard(t *testing.T, dir string, script []fakeagent.Step) (spec testServe, record string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	scripts, record := filepath.Join(dir, "scripts.json"), filepath.Join(dir, "record.jsonl")
	writeJSON(t, scripts, [][]fakeagent.Step{script})
	return testServe{Guard: []string{exe}, GuardEnv: []string{"FAKEAGENT=claude", "FAKEAGENT_SCRIPTS=" + scripts, "FAKEAGENT_RECORD=" + record}}, record
}

// exitWithin waits for cmd to exit, at most d, and gives its exit code.
func exitWithin(t *testing.T, cmd *exec.Cmd, d time.Duration) int {
	t.Helper()
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait() // its status is read below
		close(exited)
	}()
	select {
	case <-exited:
		return cmd.ProcessState.ExitCode()
	case <-time.After(d):
		t.Fatalf("the guard did not exit within %s", d)
		return -1
	}
}

// waitFor polls cond until it holds, at most ten seconds.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); !cond(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("waited for %s", what)
		}
	}
}

// childOf is the pid of the child the fake agent started, once it has.
func childOf(t *testing.T, record string) int {
	t.Helper()
	child := 0
	waitFor(t, "the program's child", func() bool {
		for _, r := range fakeagent.Records(record) {
			child = max(child, r.Child)
		}
		return child > 0
	})
	return child
}

func TestTheGuardRunsTheProgramAsGivenAndExitsAsItDoes(t *testing.T) {
	dir := t.TempDir()
	spec, record := fakeToGuard(t, dir, []fakeagent.Step{{Out: "to standard output"}, {Err: "to standard error"}, exit(7)})
	args := []string{"--json", "two words", `a "quote"`, "%PATH%", "--dry-run", `ends\`}
	spec.Guard = append(spec.Guard, args...)
	spec.GuardEnv = append(spec.GuardEnv, "QUADIT_GUARD_MARK=passed on")
	var stdout, stderr syncBuffer
	cmd, input := guardApart(t, dir, spec, &stdout, &stderr)
	defer input.Close()
	if code := exitWithin(t, cmd, 10*time.Second); code != 7 {
		t.Fatalf("the guard exited %d, the program 7; it said %q", code, stderr.String())
	}
	if stdout.String() != "to standard output\n" || stderr.String() != "to standard error\n" {
		t.Fatalf("the outputs: %q and %q", stdout.String(), stderr.String())
	}
	records := fakeagent.Records(record)
	if len(records) != 1 {
		t.Fatalf("%d starts", len(records))
	}
	r := records[0]
	if !slices.Equal(r.Argv, args) {
		t.Fatalf("the program was given %q, not %q", r.Argv, args)
	}
	if want, _ := filepath.EvalSymlinks(dir); !strings.EqualFold(r.Dir, want) && !strings.EqualFold(r.Dir, dir) {
		t.Fatalf("the program ran in %s, not the guard's folder %s", r.Dir, dir)
	}
	if r.Stdin != "" || r.Env["QUADIT_GUARD_MARK"] != "passed on" {
		t.Fatalf("the program read %q from its input and saw %v", r.Stdin, r.Env)
	}
	if _, ok := r.Env[appGuard]; ok {
		t.Fatalf("the app's mark was passed on to the program: %v", r.Env)
	}
}

func TestWhatTheProgramStartedEndsWithIt(t *testing.T) {
	dir := t.TempDir()
	spec, record := fakeToGuard(t, dir, []fakeagent.Step{{Child: true}, exit(0)})
	cmd, input := guardApart(t, dir, spec, io.Discard, io.Discard)
	defer input.Close()
	if code := exitWithin(t, cmd, 10*time.Second); code != 0 {
		t.Fatalf("the guard exited %d", code)
	}
	child := childOf(t, record)
	waitFor(t, "the child gone", func() bool { return !alive(child) })
}

func TestClosingTheGuardsInputEndsAProgramThatHearsNoStopAtOnce(t *testing.T) {
	dir := t.TempDir()
	spec, record := fakeToGuard(t, dir, []fakeagent.Step{{Child: true}, {SleepMS: 60_000}})
	cmd, input := guardApart(t, dir, spec, io.Discard, io.Discard)
	child := childOf(t, record)
	program := fakeagent.Records(record)[0].PID
	closed := time.Now()
	input.Close()
	exitWithin(t, cmd, 10*time.Second)
	if took := time.Since(closed); took >= stopGrace {
		t.Fatalf("a program with no stop event was given the grace: %s", took)
	}
	waitFor(t, "the program and its child gone", func() bool { return !alive(program) && !alive(child) })
}

func TestKillingTheGuardEndsTheProgramAndAllItStarted(t *testing.T) {
	dir := t.TempDir()
	spec, record := fakeToGuard(t, dir, []fakeagent.Step{{Child: true}, {SleepMS: 60_000}})
	cmd, input := guardApart(t, dir, spec, io.Discard, io.Discard)
	defer input.Close()
	child := childOf(t, record)
	program := fakeagent.Records(record)[0].PID
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	waitFor(t, "the program and its child gone", func() bool { return !alive(program) && !alive(child) })
}

// TestClosingTheGuardsInputStopsQuaditRunAsSigtermDoes: the guard, started
// with no console as the desktop app starts it, guards quadit run; closing
// its input asks quadit run to stop, which ends its run as interrupted, by
// itself, within the grace, and exits 0.
func TestClosingTheGuardsInputStopsQuaditRunAsSigtermDoes(t *testing.T) {
	stubborn := []fakeagent.Step{claudeInit(), claudeSays("Counting."), {Child: true}, {UntilSignal: []string{"{}"}}}
	rt := newRunTest(t, core.ProgramClaude, stubborn)
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var out syncBuffer
	cmd, input := guardApart(t, rt.dir, testServe{Registry: rt.files.registry, Home: rt.home, FakeAgent: core.ProgramClaude, Guard: []string{exe, "-test.run=^$"}}, &out, &out)
	rt.out = &out
	rt.running(0)
	rt.eventually("the program's child", func() bool { return len(rt.children()) == 1 })
	input.Close()
	if code := exitWithin(t, cmd, stopGrace+5*time.Second); code != 0 {
		t.Fatalf("the guard exited %d: quadit run did not stop by itself; it said:\n%s", code, &out)
	}
	if row := rt.f.allRuns()[0]; row["state"] != core.AgentSessionFailed || row["reason"] != core.RunInterrupted {
		t.Fatalf("the run reads %v: quadit run did not end it", row)
	}
	waitFor(t, "the program and its child gone", func() bool { return !alive(rt.records()[0].PID) && !alive(rt.children()[0]) })
}

func TestTheGuardStartsACmdFileWithItsArgumentsAsTheyAre(t *testing.T) {
	dir := t.TempDir()
	spec, record := fakeToGuard(t, dir, []fakeagent.Step{exit(3)})
	// As npm writes a program's .cmd: the program, then every argument.
	shim := filepath.Join(dir, "with space", "claude.cmd")
	_ = os.MkdirAll(filepath.Dir(shim), 0o700)
	if err := os.WriteFile(shim, []byte("@ECHO off\r\n\""+spec.Guard[0]+"\" %*\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"-p", "two words", "a&calc", "(x)", "^y", "<z>", "a|b", "!PATH!", `ends\`, ""}
	spec.Guard = append([]string{shim}, args...)
	var stderr syncBuffer
	cmd, input := guardApart(t, dir, spec, io.Discard, &stderr)
	defer input.Close()
	if code := exitWithin(t, cmd, 10*time.Second); code != 3 {
		t.Fatalf("the guard exited %d, the program 3; it said %q", code, stderr.String())
	}
	if records := fakeagent.Records(record); len(records) != 1 || !slices.Equal(records[0].Argv, args) {
		t.Fatalf("the program was given %+v, not %q", records, args)
	}

	for _, refused := range []string{"50%", `say "hi"`, "two\nlines"} {
		spec.Guard = []string{shim, "-p", refused}
		var stderr syncBuffer
		cmd, input := guardApart(t, dir, spec, io.Discard, &stderr)
		code := exitWithin(t, cmd, 10*time.Second)
		input.Close()
		if code != 126 || !strings.Contains(stderr.String(), "a .cmd file's line may not hold") {
			t.Fatalf("%q: the guard exited %d and said %q", refused, code, stderr.String())
		}
	}
	if n := len(fakeagent.Records(record)); n != 1 {
		t.Fatalf("a refused line started the program: %d starts", n)
	}
}

func TestTheGuardStartsNothingUnlessTheAppStartedIt(t *testing.T) {
	dir := t.TempDir()
	spec, record := fakeToGuard(t, dir, []fakeagent.Step{exit(0)})
	for _, kv := range spec.GuardEnv {
		name, value, _ := strings.Cut(kv, "=")
		t.Setenv(name, value) // were it started, the program would record it
	}
	for _, mark := range []string{"", "0", "yes"} {
		t.Setenv(appGuard, mark)
		var out, errs strings.Builder
		if code := Run(append([]string{"guard"}, spec.Guard...), &out, &errs); code != 126 ||
			errs.String() != "quadit guard is the Quadit app's own way to start programs: a person or an agent starts them otherwise\n" {
			t.Fatalf("%s=%q: exit %d, said %q", appGuard, mark, code, errs.String())
		}
	}
	if records := fakeagent.Records(record); len(records) != 0 {
		t.Fatalf("a guard the app did not start started %d programs", len(records))
	}
}

func TestTheGuardSaysHowItIsUsedAndWhatItDidNotFind(t *testing.T) {
	t.Setenv(appGuard, "1")
	var out, errs strings.Builder
	if code := Run([]string{"guard"}, &out, &errs); code != exitFailed || errs.String() != "usage: quadit guard PROGRAM [ARGS...]\n" {
		t.Fatalf("exit %d, said %q", code, errs.String())
	}
	if code := Run([]string{"guard", filepath.Join(t.TempDir(), "nothing.exe")}, &out, &errs); code != 127 {
		t.Fatalf("a program not found: exit %d", code)
	}
}
