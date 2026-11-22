//go:build unix

package cli

import (
	"os/exec"
	"syscall"
)

// ownGroup starts cmd in a process group of its own.
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// endGroup asks cmd's process group to stop, or with hard kills it.
func endGroup(cmd *exec.Cmd, hard bool) error {
	sig := syscall.SIGTERM
	if hard {
		sig = syscall.SIGKILL
	}
	return syscall.Kill(-cmd.Process.Pid, sig)
}
