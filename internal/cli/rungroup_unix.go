//go:build unix

package cli

import (
	"os/exec"
	"syscall"
)

// ownGroup starts cmd in a process group of its own.
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killGroup kills cmd's process group.
func killGroup(cmd *exec.Cmd) error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
