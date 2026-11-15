package main

import (
	"os"
	"testing"
)

// TestGeneratedFileIsCurrent holds the web app's change types to the
// engine: a change or an argument added, renamed or retyped in Go fails
// here until the file is written again.
func TestGeneratedFileIsCurrent(t *testing.T) {
	have, err := os.ReadFile("../../" + target)
	if err != nil {
		t.Fatal(err)
	}
	if string(have) != source() {
		t.Fatalf("%s is out of date with the engine's change arguments: run \"make generate\" and commit the result", target)
	}
}
