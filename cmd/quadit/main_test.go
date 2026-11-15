package main

import (
	"os"
	"path/filepath"
	"testing"
)

// "restore" is a backup file on the server's machine, or a task in the
// trash: the binary has to send each to the right place.
func TestRestoreMeansTwoThings(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.WriteFile(filepath.Join(dir, "OLD-1"), []byte("an archive with an unlucky name"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		args []string
		task bool
	}{
		{[]string{"restore", "SVA-12"}, true},
		{[]string{"restore", "sva-12", "--json"}, true},
		{[]string{"restore", "backup.tar.gz"}, false},
		{[]string{"restore", "/backups/quadit.tar.gz", "--workspace", "games", "--task", "SVA-12"}, false},
		{[]string{"restore", "SVA-12", "--workspace", "games"}, false}, // flags of the backup restore
		{[]string{"restore", "OLD-1"}, false},                          // a file of that name is here
		{[]string{"restore"}, false},
		{[]string{"backup", "SVA-12"}, false},
	} {
		if got := restoresTask(c.args); got != c.task {
			t.Errorf("%v: a task from the trash = %v, want %v", c.args, got, c.task)
		}
	}
}
