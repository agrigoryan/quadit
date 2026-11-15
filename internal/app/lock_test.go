package app

import (
	"path/filepath"
	"testing"
)

// TestDataLock checks that a first start can take the lock on a directory
// that does not exist yet, and that a second holder is refused.
func TestDataLock(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh", "data")
	release, err := lockData(dir)
	if err != nil {
		t.Fatalf("a first start could not lock a new data directory: %v", err)
	}
	if _, err := lockData(dir); err == nil {
		t.Fatal("two holders of one data directory")
	}
	release()
	again, err := lockData(dir)
	if err != nil {
		t.Fatalf("the lock was not given back: %v", err)
	}
	again()
}
