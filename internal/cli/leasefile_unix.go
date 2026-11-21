//go:build unix

package cli

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes the file's lock for this process, or refuses at once when
// another process holds it. The system lets it go when the process ends,
// however it ends.
func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return errAnotherListen
	}
	return err
}
