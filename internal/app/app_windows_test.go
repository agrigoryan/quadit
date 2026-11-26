package app

import (
	"os/exec"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

// stoppableProcess is how a server started by a test is started so that
// askToStop can reach it: on Windows, in a process group of its own, which
// a console's Ctrl+Break can be sent to without reaching the test.
func stoppableProcess() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// askToStop asks a server to stop as a person does in its console window:
// Ctrl+Break, which Go gives the program as os.Interrupt. (Windows sends a
// console program no SIGTERM; closing the console or signing out is the
// one it gets as syscall.SIGTERM.)
func askToStop(t *testing.T, cmd *exec.Cmd) {
	t.Helper()
	if err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(cmd.Process.Pid)); err != nil {
		t.Fatal(err)
	}
}
