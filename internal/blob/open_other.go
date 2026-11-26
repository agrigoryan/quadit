//go:build !windows

package blob

import "os"

// OpenFile opens the file at path for reading. Meanwhile others may remove
// it or put another file in its place, and this reader goes on reading the
// one it opened.
func OpenFile(path string) (*os.File, error) {
	return os.Open(path)
}
