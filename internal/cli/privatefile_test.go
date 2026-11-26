package cli

import (
	"os"
	"path/filepath"
	"testing"
)

// TestAPrivateFileIsKeptFromOthers: a file open to others is closed to
// them, and its owner still reads and writes it.
func TestAPrivateFileIsKeptFromOthers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "login.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	openToOthers(t, path)
	if !readableByOthers(t, path) {
		t.Fatal("the file opened to others is not")
	}
	if err := makePrivate(path); err != nil {
		t.Fatal(err)
	}
	if readableByOthers(t, path) {
		t.Fatal("others may still read the file")
	}
	if err := os.WriteFile(path, []byte(`{"url":"x"}`), 0o600); err != nil {
		t.Fatalf("its owner cannot write it: %v", err)
	}
	if raw, err := os.ReadFile(path); err != nil || string(raw) != `{"url":"x"}` {
		t.Fatalf("its owner cannot read it: %q, %v", raw, err)
	}
}
