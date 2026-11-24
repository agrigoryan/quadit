package fakeagent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheFakeNamesTheSessionEachProgramWasGiven(t *testing.T) {
	for _, c := range []struct {
		which         string
		args          []string
		session, last string
	}{
		{"claude", []string{"-p", "--session-id", "S1", "--name", "K"}, "S1", ""},
		{"claude", []string{"-p", "--resume", "S2"}, "S2", ""},
		{"codex", []string{"exec", "--json", "-o", "/l", "-"}, "", "/l"},
		{"codex", []string{"exec", "resume", "--json", "-o", "/l", "S3", "-"}, "S3", "/l"},
	} {
		if session, last := sessionOf(c.which, c.args); session != c.session || last != c.last {
			t.Fatalf("%s %v: %q %q", c.which, c.args, session, last)
		}
	}
}

func TestEachStartPlaysItsOwnScriptAndTheLastOneAfter(t *testing.T) {
	scripts := filepath.Join(t.TempDir(), "scripts.json")
	_ = os.WriteFile(scripts, []byte(`[[{"out":"one"}],[{"out":"two"}]]`), 0o600)
	t.Setenv("FAKEAGENT_SCRIPTS", scripts)
	for _, want := range []string{"one", "two", "two"} {
		if got := script(claimStart(scripts)); len(got) != 1 || got[0].Out != want {
			t.Fatalf("got %+v, want %s", got, want)
		}
	}
}
