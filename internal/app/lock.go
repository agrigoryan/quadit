package app

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// lockData marks the data directory as in use by a running server, so that
// commands which must have the database to themselves (undoing an upgrade)
// can tell. The lock goes when the process ends, however it ends.
func lockData(dir string) (release func(), err error) {
	// A first start has no data directory yet.
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "quadit.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("a server is running on %s; stop it first", dir)
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
