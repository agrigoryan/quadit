//go:build windows

// `quadit guard PROGRAM [ARGS...]`: how the desktop app starts a program
// on Windows (quadit run, or an agent program), so that none outlives the
// app. Windows has no sh, no process groups and no signal the app can
// send, so this does there what desktop/src/main/child-guard.ts's sh guard
// does on macOS and Linux, with the same promise:
//
//   - PROGRAM runs with ARGS exactly as given (no shell; a .cmd under the
//     rule of programCommand), with no standard input, its two outputs
//     passed through, in the guard's working folder and environment;
//   - the guard's exit code is PROGRAM's;
//   - when PROGRAM ends by itself, nothing it started outlives it;
//   - when the guard's standard input closes (the app stopped it, quit, or
//     was killed), PROGRAM is asked to stop and, five seconds later, it and
//     all it started are ended outright; then the guard exits;
//   - if the guard itself is killed, PROGRAM and all it started end too.
//
// Asking to stop is the stop event: a named event, Local\quadit-stop-PID,
// that a process makes for itself when it heeds one (quadit run does,
// heedStopRequests) and the guard sets. It needs no console: the app is a
// windowed program, and what it starts may have none. A program that made
// no such event hears nothing: the guard ends it outright at once, which
// is all Windows offers for a program that shares no console with it.
//
// It is not in the help that lists commands for people: only the app uses
// it.

package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"time"

	"golang.org/x/sys/windows"
)

// stopGrace is how long a program asked to stop has before it is ended
// outright: the desktop guard's five seconds, within which quadit run ends
// its own runs (agent-runs-contract.md §5.10).
const stopGrace = 5 * time.Second

// guard runs `quadit guard PROGRAM [ARGS...]` (see the file's comment). Its
// exit code is PROGRAM's; 127 when PROGRAM is not found, 126 when it is
// not a program the guard starts.
func guard(args []string, _, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: quadit guard PROGRAM [ARGS...]")
		return exitFailed
	}
	path, err := exec.LookPath(args[0])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 127
	}
	// The program is stopped by its job, never by a context.
	cmd, err := programCommand(context.Background(), path, args[1:])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 126
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr // no standard input: os/exec gives the null device
	group, err := startInGroup(cmd)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 126
	}
	defer group.release()
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait() // its status is read from cmd.ProcessState below
		close(exited)
	}()
	// The guard's input is read until it closes. The read cannot be called
	// off: this goroutine ends with the input or with the guard's process.
	inputClosed := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin) // what the app writes means nothing; only its end does
		close(inputClosed)
	}()
	select {
	case <-exited:
	case <-inputClosed:
		if askToStop(cmd.Process.Pid) {
			select {
			case <-exited:
			case <-time.After(stopGrace):
			}
		}
		group.signal(sigKill)
		<-exited
	}
	group.signal(sigKill) // nothing PROGRAM started outlives it
	return cmd.ProcessState.ExitCode()
}

// stopEventName is the name of the stop event of the process pid.
func stopEventName(pid int) string { return `Local\quadit-stop-` + strconv.Itoa(pid) }

// askToStop sets the stop event of the process pid, and reports whether
// it has one: whether it heeds being asked.
func askToStop(pid int) bool {
	name, err := windows.UTF16PtrFromString(stopEventName(pid))
	if err != nil {
		return false
	}
	event, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name)
	if err != nil {
		return false
	}
	defer closeHandle(event)
	return windows.SetEvent(event) == nil
}

// heedStopRequests is ctx, ended when this process's stop event is set
// (askToStop). The event is made here, so a guard asking before it exists
// finds none and ends the process outright: nothing the process does
// before it heeds the event needs an orderly stop. stop lets the event go.
func heedStopRequests(ctx context.Context) (_ context.Context, stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	name, err := windows.UTF16PtrFromString(stopEventName(os.Getpid()))
	if err != nil {
		return ctx, cancel
	}
	// Manual reset: once asked, it stays asked. An event already there
	// (ERROR_ALREADY_EXISTS, with its handle) is this process's all the same.
	event, err := windows.CreateEvent(nil, 1, 0, name)
	if event == 0 {
		_ = err // no event: Ctrl-C and the console closing still stop it, and a guard ends it outright
		return ctx, cancel
	}
	waited := make(chan struct{})
	go func() {
		defer close(waited)
		_, _ = windows.WaitForSingleObject(event, windows.INFINITE) // set by a guard, or by stop below
		cancel()
	}()
	return ctx, func() {
		cancel()
		_ = windows.SetEvent(event) // wakes the wait; the process is stopping anyway
		<-waited
		closeHandle(event)
	}
}
