//go:build unix

package server_test

import (
	"os"
	"sync"
	"testing"
)

// denyWriting keeps the person running the test from adding anything to
// the folder dir, until the test ends or allow is called. Root is not kept
// from anything: a test that needs this skips for it.
func denyWriting(t *testing.T, dir string) (allow func()) {
	t.Helper()
	return chmodUntil(t, dir, 0o500)
}

// denyReading keeps the person running the test from listing what the
// folder dir holds, until the test ends or allow is called.
func denyReading(t *testing.T, dir string) (allow func()) {
	t.Helper()
	return chmodUntil(t, dir, 0o300)
}

// chmodUntil gives dir the mode until the test ends or allow is called,
// then the mode it had.
func chmodUntil(t *testing.T, dir string, mode os.FileMode) (allow func()) {
	t.Helper()
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, mode); err != nil {
		t.Fatal(err)
	}
	allow = sync.OnceFunc(func() {
		if err := os.Chmod(dir, info.Mode().Perm()); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(allow) // so the test's folder can be removed
	return allow
}
