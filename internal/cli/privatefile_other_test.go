//go:build !windows

package cli

import (
	"os"
	"testing"
)

// openToOthers lets everyone read the file at path.
func openToOthers(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
}

// readableByOthers reports whether anyone but the file's owner may read or
// write it.
func readableByOthers(t *testing.T, path string) bool {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()&0o077 != 0
}
