//go:build unix

// What `quadit run` needs of the system, on macOS and Linux: file locks
// that the system lets go when the process ends; process groups, so a
// program and everything it started can be stopped together; and the
// signals that ask a runner to stop.

package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// fileIdentity is what names a file whatever its spelling: its device and
// inode, following links. Two paths to one folder have one identity, on a
// volume that does not tell case apart too.
func fileIdentity(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New("no identity for " + path)
	}
	// Printed, not converted: the device number is a different integer type on each system.
	return fmt.Sprintf("%d:%d", sys.Dev, sys.Ino), nil
}

// tryLock takes f's lock for this process, or answers errLocked at once
// when another holder has it. Two opens of one file are two holders, even
// in one process, so the folder lock keeps two entries of one runner apart.
// The system lets it go when f is closed or the process ends, however it
// ends.
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

// programCommand is the command that starts the program at path with
// args, each given as it is: a regular file the system may run.
func programCommand(ctx context.Context, path string, args []string) (*exec.Cmd, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o111 == 0 {
		return nil, fmt.Errorf("%s is not a program", path)
	}
	return exec.CommandContext(ctx, path, args...), nil
}

// processGroup is a program the runner started, with everything it
// started since: its process group, which the program leads.
type processGroup struct{ pgid int }

// startInGroup starts cmd as the leader of a process group of its own.
func startInGroup(cmd *exec.Cmd) (*processGroup, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &processGroup{pgid: cmd.Process.Pid}, nil
}

// leftGroup is the group a runner recorded before it stopped (its id and
// its start as processStart gave it), when it still runs: recognized by
// both, never by name.
func leftGroup(ctx context.Context, id int, started string) (*processGroup, bool) {
	if now, err := processStart(ctx, id); err != nil || now != started {
		return nil, false
	}
	return &processGroup{pgid: id}, true
}

// id is what a journal records of the group: its process group id.
func (g *processGroup) id() int { return g.pgid }

// signal sends sig to every process of the group. A group that is gone is
// not an error.
func (g *processGroup) signal(sig groupSignal) {
	s := map[groupSignal]syscall.Signal{sigInterrupt: syscall.SIGINT, sigTerminate: syscall.SIGTERM, sigKill: syscall.SIGKILL}[sig]
	_ = syscall.Kill(-g.pgid, s) // a group already gone has nothing to stop
}

// alive reports whether any process of the group is left.
func (g *processGroup) alive() bool {
	err := syscall.Kill(-g.pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// release lets go of the group once nothing more is asked of it; on macOS
// and Linux a process group holds nothing to let go.
func (*processGroup) release() {}

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

// untilAskedToStop is ctx, ended when the runner is asked to stop: by
// SIGINT (Ctrl-C) or SIGTERM (the desktop app's guard).
func untilAskedToStop(ctx context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
}

// replaceFile renames from over to, which may exist. Whether the rename
// reaches the disk at once is syncDir's on macOS and Linux.
func replaceFile(from, to string, _ bool) error { return os.Rename(from, to) }

// readWhole reads a file that writeWhole writes.
func readWhole(path string) ([]byte, error) { return os.ReadFile(path) }

// syncDir flushes a folder's entries to the disk: the renames and
// removals the crash boundaries rely on survive a power loss.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
