//go:build !windows

package blob

import "os"

// OpenFile opens the file at path for reading. Meanwhile others may remove
// it or put another file in its place, and this reader goes on reading the
// one it opened.
func OpenFile(path string) (*os.File, error) {
	return os.Open(path)
}

// Replace moves the file at from to the path to, beside it, in one step:
// whatever was at to is replaced, even while it is being read, and its
// readers read on what they opened. A rename does all of it here.
func Replace(from, to string) error {
	return os.Rename(from, to)
}
