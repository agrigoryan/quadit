//go:build unix

package cli

import (
	"fmt"
	"io"
)

// guard is `quadit guard`, which exists on Windows only (guard_windows.go):
// on macOS and Linux the desktop app guards what it starts with sh.
func guard(_ []string, _, stderr io.Writer) int {
	fmt.Fprintln(stderr, "quadit guard is for Windows only: on macOS and Linux the desktop app guards what it starts with sh")
	return exitFailed
}
