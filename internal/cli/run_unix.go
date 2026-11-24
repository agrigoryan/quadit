//go:build unix

// What `quadit run` needs of the system, on macOS and Linux: file locks
// that the system lets go when the process ends, and process groups, so a
// program and everything it started can be stopped together.

package cli

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// canServe is nil where quadit run can serve agents.
func canServe() error { return nil }

// tryLock takes f's lock for this process, or answers errLocked at once
// when another holder has it. Two opens of one file are two holders, even
// in one process, so the folder lock keeps two entries of one runner apart.
func tryLock(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return errLocked
	}
	return err
}

// waitLock takes f's lock, waiting for whoever has it.
func waitLock(f *os.File) error {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}

// startInGroup starts cmd as the leader of a process group of its own.
func startInGroup(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd.Start()
}

// signalGroup sends sig to every process of the group pgid. A group that
// is gone is not an error.
func signalGroup(pgid int, sig groupSignal) {
	s := map[groupSignal]syscall.Signal{sigInterrupt: syscall.SIGINT, sigTerminate: syscall.SIGTERM, sigKill: syscall.SIGKILL}[sig]
	_ = syscall.Kill(-pgid, s) // a group already gone has nothing to stop
}

// groupAlive reports whether any process of the group pgid is left.
func groupAlive(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// processStart is when the process pid started, as `ps -o lstart=` prints
// it: with the process group id, what recognizes a program a runner
// launched before it stopped, whatever its name.
func processStart(ctx context.Context, pid int) (string, error) {
	out, err := exec.CommandContext(ctx, "ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// keepAwake keeps the computer from idle sleep while pid runs, on macOS
// (`caffeinate -i -w`, which ends by itself with pid); a closed lid still
// sleeps. Elsewhere it does nothing. The caller calls done once pid ended.
func keepAwake(ctx context.Context, pid int) (done func()) {
	const caffeinate = "/usr/bin/caffeinate"
	if runtime.GOOS != "darwin" {
		return func() {}
	}
	if _, err := os.Stat(caffeinate); err != nil {
		return func() {}
	}
	cmd := exec.CommandContext(ctx, caffeinate, "-i", "-w", strconv.Itoa(pid))
	if cmd.Start() != nil {
		return func() {}
	}
	return func() { _ = cmd.Wait() } // it ends with pid; its status says nothing
}
