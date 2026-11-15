package server_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestSyncKeepsEveryNote: a sync that holds pages back says so beside what
// it said before in the same sync, here that the source's folder is not in
// the repository yet.
func TestSyncKeepsEveryNote(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	if os.Geteuid() == 0 {
		t.Skip("a folder that may not be written to is written to anyway by root")
	}
	s := newSite(t, testdb.SQLite(t))
	work := t.TempDir()
	bare := filepath.Join(t.TempDir(), "origin.git")
	git := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	// A repository with no docs folder.
	git(work, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(work, "README"), []byte("hi\n"), 0o644)
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "first")
	git(work, "init", "-q", "--bare", "-b", "main", bare)
	git(work, "remote", "add", "origin", bare)
	git(work, "push", "-q", "origin", "main")

	src := s.change(s.owner, "", "source.create", M{"title": "Handbook", "repo": bare, "subdir": "docs"})["ref"].(string)
	sync := func() string { return s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, nil) }
	if out := sync(); !strings.Contains(out, "no folder docs") {
		t.Fatalf("the first sync does not say the folder is missing: %s", out)
	}
	var docs struct{ Docs []struct{ ID, Title string } }
	s.call(s.owner, "", "GET", w+"/docs", nil, 200, &docs)
	root := ""
	for _, d := range docs.Docs {
		if d.Title == "Handbook" {
			root = d.ID
		}
	}
	s.change(s.owner, "", "doc.create", M{"title": "held", "parent": root, "markdown": "Cannot land.\n"})

	// The working copy may not be written to: the folder cannot be made, so
	// the page is held back, and the folder is still missing.
	copyDir := filepath.Join(s.dir, "repos", src)
	if err := os.Chmod(copyDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(copyDir, 0o755) })
	out := sync()
	if !strings.Contains(out, "stands in the way") || !strings.Contains(out, "no folder docs") {
		t.Fatalf("a sync that held a page back lost what it said before: %s", out)
	}
	// Once a sync has made the folder, it no longer says it is missing.
	os.Chmod(copyDir, 0o755)
	if out := sync(); !strings.Contains(out, `"files_written":1`) || strings.Contains(out, "no folder") || strings.Contains(out, "stands in the way") {
		t.Fatalf("the sync that made the folder: %s", out)
	}
}
