package server_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestRepositorySync(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		tmp := t.TempDir()
		origin := filepath.Join(tmp, "origin.git")
		work := filepath.Join(tmp, "work")
		gitIn(t, tmp, "init", "--quiet", "--bare", "-b", "main", origin)
		gitIn(t, tmp, "clone", "--quiet", origin, work)
		write := func(rel, text string) {
			p := filepath.Join(work, rel)
			os.MkdirAll(filepath.Dir(p), 0o755)
			if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		push := func(msg string) {
			gitIn(t, work, "add", "--all")
			gitIn(t, work, "commit", "--quiet", "-m", msg)
			gitIn(t, work, "push", "--quiet", "origin", "HEAD:main")
		}
		write("docs/design.md", "# Design\n\nThe boss has three phases.\n")
		write("docs/art/sprites.md", "Sprites\n\n* idle\n* attack\n")
		write("README.md", "not under docs\n")
		push("first")

		src := s.change(s.owner, "", "source.create", M{"title": "Game docs", "repo": origin, "subdir": "docs"})["ref"].(string)
		var res struct {
			PagesCreated int    `json:"pages_created"`
			PagesUpdated int    `json:"pages_updated"`
			PagesTrashed int    `json:"pages_trashed"`
			FilesWritten int    `json:"files_written"`
			Pushed       string `json:"pushed"`
		}
		sync := func() {
			t.Helper()
			res.PagesCreated, res.PagesUpdated, res.PagesTrashed, res.FilesWritten, res.Pushed = 0, 0, 0, 0, ""
			s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, &res)
		}
		sync()
		if res.PagesCreated != 2 || res.FilesWritten != 0 {
			t.Fatalf("first sync = %+v", res)
		}
		tree := s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil)
		if !strings.Contains(tree, "Game docs") || !strings.Contains(tree, "\n  Design  (") || !strings.Contains(tree, "\n  art  (") || !strings.Contains(tree, "\n    sprites  (") || strings.Contains(tree, "README") {
			t.Fatalf("page tree:\n%s", tree)
		}
		idOf := func(title string) string {
			for _, line := range strings.Split(s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil), "\n") {
				if strings.HasPrefix(strings.TrimSpace(line), title+"  (") {
					return line[strings.LastIndex(line, "(")+1 : len(line)-1]
				}
			}
			t.Fatalf("no page %q", title)
			return ""
		}
		// Nothing changed on either side: a second sync does nothing, and in
		// particular does not rewrite files into the server's own Markdown style.
		sync()
		if res.PagesUpdated != 0 || res.FilesWritten != 0 || res.PagesCreated != 0 {
			t.Fatalf("idle sync = %+v", res)
		}

		// A page edited here becomes a commit there.
		design := idOf("Design") // called by its heading
		s.change(s.owner, "", "doc.write", M{"doc": design, "markdown": "# Design\n\nThe boss has four phases.\n"})
		sync()
		if res.FilesWritten != 1 || res.Pushed != "main" {
			t.Fatalf("page edit sync = %+v", res)
		}
		gitIn(t, work, "pull", "--quiet", "origin", "main")
		if raw, _ := os.ReadFile(filepath.Join(work, "docs/design.md")); !strings.Contains(string(raw), "four phases") {
			t.Fatalf("the repository did not get the edit: %s", raw)
		}
		// The commit is in the name of the person who edited the page.
		if who := gitIn(t, work, "log", "-1", "--format=%an <%ae>"); !strings.Contains(who, "Aram <owner@example.com>") {
			t.Fatalf("the commit's author is %q", who)
		}
		if !strings.Contains(gitIn(t, work, "log", "-1", "--format=%s"), "from Quadit") {
			t.Fatal("the commit is not marked as coming from Quadit")
		}

		// A file edited there updates the page here; a new file becomes a page;
		// a deleted file sends its page to the trash.
		write("docs/design.md", "# Design\n\nThe boss has five phases.\n")
		write("docs/audio.md", "Music loops.\n")
		os.Remove(filepath.Join(work, "docs/art/sprites.md"))
		push("edits")
		sync()
		if res.PagesUpdated != 1 || res.PagesCreated != 1 || res.PagesTrashed != 1 {
			t.Fatalf("file edit sync = %+v", res)
		}
		if got := s.call(s.owner, "", "GET", w+"/docs/"+design+"?format=md", nil, 200, nil); !strings.Contains(got, "five phases") {
			t.Fatalf("the page did not get the file's edit:\n%s", got)
		}

		// Both sides change the same page: the repository has the say by default.
		s.change(s.owner, "", "doc.write", M{"doc": design, "markdown": "page says six\n"})
		write("docs/design.md", "file says seven\n")
		push("conflict")
		sync()
		if got := s.call(s.owner, "", "GET", w+"/docs/"+design+"?format=md", nil, 200, nil); !strings.Contains(got, "file says seven") {
			t.Fatalf("conflict was not settled for the repository:\n%s", got)
		}
		// The page's own version is not lost: it is in the page's history.
		var vs struct{ Versions []struct{ ID string } }
		s.call(s.owner, "", "GET", w+"/docs/"+design+"/versions", nil, 200, &vs)
		if len(vs.Versions) == 0 {
			t.Fatal("the overwritten page left no version behind")
		}

		// A page made here inside the folder becomes a new file.
		root := idOf("Game docs")
		s.change(s.owner, "", "doc.create", M{"parent": root, "title": "Release Notes", "markdown": "v0.1\n"})
		sync()
		gitIn(t, work, "pull", "--quiet", "origin", "main")
		if raw, err := os.ReadFile(filepath.Join(work, "docs/release-notes.md")); err != nil || !strings.Contains(string(raw), "v0.1") {
			t.Fatalf("new page did not become a file: %v %s", err, raw)
		}
	})
}
