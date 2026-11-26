//go:build unix

package cli

import (
	"bytes"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
)

// What the runner's tests ask of the system on macOS and Linux.

// programOutlivesRunner: a program whose runner is killed goes on in its
// process group, until the next runner recognizes it and ends it.
const programOutlivesRunner = true

// alive reports whether a process lives (a zombie not reaped counts as gone).
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && len(bytes.TrimSpace(out)) > 0 && !bytes.HasPrefix(bytes.TrimSpace(out), []byte("Z"))
}

// groupLeft reports whether anything of the process group pid leads is left.
func groupLeft(pid int) bool { return syscall.Kill(-pid, 0) == nil && alive(pid) }

// killLeft kills what a failed test left: a process, and its group.
func killLeft(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGKILL) // a group left by a failed test
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

// askThisRunnerToStop asks the runner of this process to stop as the
// system does: SIGTERM.
func askThisRunnerToStop() error { return syscall.Kill(os.Getpid(), syscall.SIGTERM) }

// refuseWritesIn makes dir refuse new files until allow is called.
func refuseWritesIn(t *testing.T, dir string) (allow func()) {
	t.Helper()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	allow = func() { _ = os.Chmod(dir, 0o700) }
	t.Cleanup(allow)
	return allow
}

// makeUnreadable makes a file refuse to be read.
func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
}

// startAlone starts cmd in a process group of its own, as a runner starts
// a program.
func startAlone(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd.Start()
}
