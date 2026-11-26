//go:build !windows

package blob

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAFileIsReplacedInAFolderThatCannotBeListed: on Unix, replacing a file
// needs what a rename needs, and no more: writing in the folder and
// passing through it, not listing it.
func TestAFileIsReplacedInAFolderThatCannotBeListed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root lists any folder")
	}
	dir := t.TempDir()
	path, other := filepath.Join(dir, "file"), filepath.Join(dir, "other")
	for name, text := range map[string]string{path: "before", other: "after"} {
		if err := os.WriteFile(name, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(dir, 0o300); err != nil { // write and pass through, not list
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) }) // so the test's folder can be removed
	if err := Replace(other, path); err != nil {
		t.Fatalf("replacing a file in a folder that cannot be listed: %v", err)
	}
	if raw, err := os.ReadFile(path); err != nil || string(raw) != "after" {
		t.Fatalf("the file holds %q, %v", raw, err)
	}
}
