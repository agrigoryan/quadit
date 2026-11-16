package main

import (
	"os"
	"testing"
)

// TestGeneratedFilesAreCurrent holds the web app's generated types to the
// server: a change or an argument, or a row's field, added, renamed or
// retyped in Go fails here until the files are written again.
func TestGeneratedFilesAreCurrent(t *testing.T) {
	for target, source := range files {
		have, err := os.ReadFile("../../" + target)
		if err != nil {
			t.Fatal(err)
		}
		if string(have) != source() {
			t.Errorf("%s is out of date with the server: run \"make generate\" and commit the result", target)
		}
	}
}
