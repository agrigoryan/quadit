//go:build !windows

package cli

import "os"

// makePrivate keeps the file at path to the person running the command:
// only its owner may read or write it.
func makePrivate(path string) error {
	return os.Chmod(path, 0o600)
}
