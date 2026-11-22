//go:build !unix

package cli

import "os/exec"

// ownGroup does nothing where there are no process groups this way.
func ownGroup(*exec.Cmd) {}

// endGroup ends cmd's process alone, at once.
func endGroup(cmd *exec.Cmd, _ bool) error { return cmd.Process.Kill() }
