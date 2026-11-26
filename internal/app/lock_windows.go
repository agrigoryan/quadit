package app

import (
	"os"

	"golang.org/x/sys/windows"
)

// lockNow takes f's lock for this process, or fails at once when another
// process holds it. The lock is on the file's first byte: nothing reads the
// file, so a lock that also keeps others from reading that byte costs nothing.
func lockNow(f *os.File) error {
	const exclusiveNoWait = windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY
	return windows.LockFileEx(windows.Handle(f.Fd()), exclusiveNoWait, 0, 1, 0, &windows.Overlapped{})
}
