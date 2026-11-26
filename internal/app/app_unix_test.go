//go:build unix

package app

import (
	"os/exec"
	"syscall"
	"testing"
)

// stoppableProcess is how a server started by a test is started so that
// askToStop can reach it: on Unix, as any process.
func stoppableProcess() *syscall.SysProcAttr { return nil }

// askToStop asks a server to stop as a service manager does: SIGTERM.
func askToStop(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
}
