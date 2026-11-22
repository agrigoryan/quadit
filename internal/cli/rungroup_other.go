//go:build !unix

package cli

import "os/exec"

// ownGroup does nothing where there are no process groups this way.
func ownGroup(*exec.Cmd) {}

// killGroup kills cmd's process alone.
func killGroup(cmd *exec.Cmd) error { return cmd.Process.Kill() }
