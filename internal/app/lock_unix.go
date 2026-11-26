//go:build unix

package app

import (
	"os"
	"syscall"
)

// lockNow takes f's lock for this process, or fails at once when another
// process holds it.
func lockNow(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
