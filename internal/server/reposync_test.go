package server_test

import (
	"encoding/json"
	"maps"
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

		src := s.change(t, s.owner, "", "source.create", M{"title": "Game docs", "repo": origin, "subdir": "docs"})["ref"].(string)
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
			s.call(t, s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, &res)
		}
		sync()
		if res.PagesCreated != 2 || res.FilesWritten != 0 {
			t.Fatalf("first sync = %+v", res)
		}
		tree := s.call(t, s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil)
		if !strings.Contains(tree, "Game docs") || !strings.Contains(tree, "\n  Design  (") || !strings.Contains(tree, "\n  art  (") || !strings.Contains(tree, "\n    sprites  (") || strings.Contains(tree, "README") {
			t.Fatalf("page tree:\n%s", tree)
		}
		idOf := func(title string) string {
			for line := range strings.SplitSeq(s.call(t, s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil), "\n") {
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
		s.change(t, s.owner, "", "doc.write", M{"doc": design, "markdown": "# Design\n\nThe boss has four phases.\n"})
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
		if got := s.call(t, s.owner, "", "GET", w+"/docs/"+design+"?format=md", nil, 200, nil); !strings.Contains(got, "five phases") {
			t.Fatalf("the page did not get the file's edit:\n%s", got)
		}

		// Both sides change the same page: the repository has the say by default.
		s.change(t, s.owner, "", "doc.write", M{"doc": design, "markdown": "page says six\n"})
		write("docs/design.md", "file says seven\n")
		push("conflict")
		sync()
		if got := s.call(t, s.owner, "", "GET", w+"/docs/"+design+"?format=md", nil, 200, nil); !strings.Contains(got, "file says seven") {
			t.Fatalf("conflict was not settled for the repository:\n%s", got)
		}
		// The page's own version is not lost: it is in the page's history.
		var vs struct{ Versions []struct{ ID string } }
		s.call(t, s.owner, "", "GET", w+"/docs/"+design+"/versions", nil, 200, &vs)
		if len(vs.Versions) == 0 {
			t.Fatal("the overwritten page left no version behind")
		}

		// A page made here inside the folder becomes a new file.
		root := idOf("Game docs")
		s.change(t, s.owner, "", "doc.create", M{"parent": root, "title": "Release Notes", "markdown": "v0.1\n"})
		sync()
		gitIn(t, work, "pull", "--quiet", "origin", "main")
		if raw, err := os.ReadFile(filepath.Join(work, "docs/release-notes.md")); err != nil || !strings.Contains(string(raw), "v0.1") {
			t.Fatalf("new page did not become a file: %v %s", err, raw)
		}
	})
}

// syncOutcome is all a sync answers.
type syncOutcome struct {
	PagesCreated int    `json:"pages_created"`
	PagesUpdated int    `json:"pages_updated"`
	PagesTrashed int    `json:"pages_trashed"`
	FilesWritten int    `json:"files_written"`
	FilesRemoved int    `json:"files_removed"`
	Commit       string `json:"commit"`
	Pushed       string `json:"pushed"`
	Note         string `json:"note"`
}

// syncAnswering syncs and expects the status want; it gives back the
// answer, and its raw text for an error.
func (r *syncedRepo) syncAnswering(want int) (syncOutcome, string) {
	r.t.Helper()
	var res syncOutcome
	raw := r.s.call(r.t, r.s.owner, "", "POST", w+"/sources/"+r.src+"/sync", nil, want, nil)
	if want == 200 {
		if err := json.Unmarshal([]byte(raw), &res); err != nil {
			r.t.Fatalf("the answer %q: %v", raw, err)
		}
	}
	return res, raw
}

// files lists the files a branch holds.
func (r *syncedRepo) files(branch string) string {
	return gitIn(r.t, r.origin, "ls-tree", "-r", "--name-only", branch)
}

// TestRepositorySyncDecides pins, from a real repository to the pages and
// back, each case a sync decides that the other sync tests do not name.
func TestRepositorySyncDecides(t *testing.T) {
	source := func(r *syncedRepo, args M) {
		a := M{"title": "Game docs", "repo": r.origin, "subdir": "docs"}
		maps.Copy(a, args)
		r.src = r.s.change(r.t, r.s.owner, "", "source.create", a)["ref"].(string)
	}
	cases := []struct {
		name  string
		files map[string]string
		run   func(t *testing.T, s *site, r *syncedRepo)
	}{
		{"a repository with no commits says so", nil, func(t *testing.T, s *site, r *syncedRepo) {
			empty := filepath.Join(t.TempDir(), "empty.git")
			gitIn(t, filepath.Dir(empty), "init", "--quiet", "--bare", "-b", "main", empty)
			r.origin = empty
			source(r, nil)
			if res, _ := r.syncAnswering(200); res.Note != "the repository has no commits yet; pages will sync once it has" || res.PagesCreated != 0 {
				t.Fatalf("%+v", res)
			}
		}},
		{"a branch the repository does not have says so", map[string]string{"docs/a.md": "A.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, M{"branch": "nope"})
			if res, _ := r.syncAnswering(200); res.Note != "the repository has no branch nope yet; pages will sync once it has" || res.PagesCreated != 0 {
				t.Fatalf("%+v", res)
			}
		}},
		{"an address with no repository is said", nil, func(t *testing.T, s *site, r *syncedRepo) {
			r.origin = filepath.Join(t.TempDir(), "nowhere.git")
			source(r, nil)
			if _, raw := r.syncAnswering(409); !strings.Contains(raw, "the repository could not be found at that address") {
				t.Fatal(raw)
			}
		}},
		{"a folder that is a file there is refused", map[string]string{"docs": "a file\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			if _, raw := r.syncAnswering(409); !strings.Contains(raw, "the source's folder docs is a file in the repository; set it to a folder") {
				t.Fatal(raw)
			}
		}},
		{"a changed address is followed", map[string]string{"docs/a.md": "A.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			r.syncAnswering(200)
			other := newSyncedRepo(t, s, map[string]string{"docs/b.md": "B.\n"})
			s.change(t, s.owner, "", "source.update", M{"id": r.src, "repo": other.origin})
			if res, _ := r.syncAnswering(200); res.PagesCreated != 1 || res.PagesTrashed != 1 {
				t.Fatalf("%+v", res)
			}
			s.pageID(t, "b")
		}},
		{"a push to a working copy with the branch checked out is refused and explained", nil, func(t *testing.T, s *site, r *syncedRepo) {
			checkedOut := t.TempDir()
			gitIn(t, checkedOut, "init", "--quiet", "-b", "main")
			os.MkdirAll(filepath.Join(checkedOut, "docs"), 0o755)
			os.WriteFile(filepath.Join(checkedOut, "docs", "a.md"), []byte("A.\n"), 0o644)
			gitIn(t, checkedOut, "add", "--all")
			gitIn(t, checkedOut, "commit", "--quiet", "-m", "first")
			r.origin = checkedOut
			source(r, nil)
			r.syncAnswering(200)
			page := s.pageID(t, "a")
			s.change(t, s.owner, "", "doc.write", M{"doc": page, "markdown": "A, edited.\n"})
			for range 2 {
				if _, raw := r.syncAnswering(409); !strings.Contains(raw, "the repository is a working copy with main checked out, and git lets nobody push to that") {
					t.Fatal(raw)
				}
			}
			if got := s.call(t, s.owner, "", "GET", w+"/docs/"+page+"?format=md", nil, 200, nil); !strings.Contains(got, "A, edited.") {
				t.Fatalf("the page lost its edit: %q", got)
			}
		}},
		{"a file's HTML, a comment span's look-alike too, is its text both ways", map[string]string{"docs/a.md": "A <span class=\"badge\">new</span> thing.\n\nWrite <span data-comment=\"ID\">words</span> to mark them.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			r.syncAnswering(200)
			page := s.pageID(t, "a")
			if res, _ := r.syncAnswering(200); res.FilesWritten != 0 || res.PagesUpdated != 0 {
				t.Fatalf("an idle sync wrote: %+v", res)
			}
			// An agent reads the page with its comment spans and writes it back with an edit.
			text := s.call(t, s.owner, "", "GET", w+"/docs/"+page+"?format=md", nil, 200, nil)
			s.change(t, s.owner, "", "doc.write", M{"doc": page, "markdown": strings.Replace(text, "thing", "feature", 1)})
			if res, _ := r.syncAnswering(200); res.FilesWritten != 1 {
				t.Fatalf("the edit was not written: %+v", res)
			}
			want := "A <span class=\"badge\">new</span> feature.\n\nWrite <span data-comment=\"ID\">words</span> to mark them.\n"
			if got := gitIn(t, r.origin, "show", "main:docs/a.md"); got+"\n" != want {
				t.Fatalf("the file reads\n%s\nwant\n%s", got, want)
			}
		}},
		{"both changed and the pages have the say: the page is written", map[string]string{"docs/a.md": "A.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, M{"authority": "pages"})
			r.syncAnswering(200)
			s.change(t, s.owner, "", "doc.write", M{"doc": s.pageID(t, "a"), "markdown": "A, from the page.\n"})
			r.write("docs/a.md", "A, from the file.\n")
			r.push("there")
			if res, _ := r.syncAnswering(200); res.FilesWritten != 1 || res.PagesUpdated != 0 {
				t.Fatalf("%+v", res)
			}
			if got := r.read("main", "docs/a.md"); got != "A, from the page.\n" {
				t.Fatalf("%q", got)
			}
			r.idle("after the page won")
		}},
		{"a page trashed here takes its unchanged file with it", map[string]string{"docs/a.md": "A.\n", "docs/b.md": "B.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			r.syncAnswering(200)
			s.change(t, s.owner, "", "doc.delete", M{"id": s.pageID(t, "a")})
			if res, _ := r.syncAnswering(200); res.FilesRemoved != 1 || res.FilesWritten != 0 || res.Pushed != "main" {
				t.Fatalf("%+v", res)
			}
			if got := r.files("main"); strings.Contains(got, "docs/a.md") || !strings.Contains(got, "docs/b.md") {
				t.Fatal(got)
			}
			if res, _ := r.syncAnswering(200); res.PagesCreated != 0 || res.FilesRemoved != 0 {
				t.Fatalf("the sync after: %+v", res)
			}
		}},
		{"a page trashed here while its file changed there, pages having the say: the file goes", map[string]string{"docs/a.md": "A.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, M{"authority": "pages"})
			r.syncAnswering(200)
			s.change(t, s.owner, "", "doc.delete", M{"id": s.pageID(t, "a")})
			r.write("docs/a.md", "A, changed there.\n")
			r.push("there")
			if res, _ := r.syncAnswering(200); res.FilesRemoved != 1 || res.Note != "" {
				t.Fatalf("%+v", res)
			}
			if got := r.files("main"); strings.Contains(got, "docs/a.md") {
				t.Fatal(got)
			}
		}},
		{"a source that is never written to takes file edits and writes nothing", map[string]string{"docs/a.md": "A.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, M{"write_mode": "none"})
			r.syncAnswering(200)
			s.change(t, s.owner, "", "doc.create", M{"parent": s.pageID(t, "Game docs"), "title": "New", "markdown": "New.\n"})
			r.write("docs/a.md", "A, edited there.\n")
			r.push("there")
			if res, _ := r.syncAnswering(200); res.FilesWritten != 0 || res.Pushed != "" || res.PagesUpdated != 1 || res.Commit == "" {
				t.Fatalf("%+v", res)
			}
			if res, _ := r.syncAnswering(200); res.FilesWritten != 0 || res.Pushed != "" || res.PagesUpdated != 0 || res.PagesCreated != 0 {
				t.Fatalf("the sync after: %+v", res)
			}
			if got := r.files("main"); strings.Contains(got, "new.md") {
				t.Fatal(got)
			}
		}},
		{"a proposal is pushed once, and the branch is left as it was", map[string]string{"docs/a.md": "A.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, M{"write_mode": "propose"})
			r.syncAnswering(200)
			s.change(t, s.owner, "", "doc.write", M{"doc": s.pageID(t, "a"), "markdown": "A, proposed.\n"})
			if res, _ := r.syncAnswering(200); res.FilesWritten != 1 || res.Pushed != "quadit/docs" {
				t.Fatalf("%+v", res)
			}
			if res, _ := r.syncAnswering(200); res.FilesWritten != 0 || res.Pushed != "" || res.PagesUpdated != 0 {
				t.Fatalf("the sync after the proposal: %+v", res)
			}
			if r.read("main", "docs/a.md") != "A.\n" || r.read("quadit/docs", "docs/a.md") != "A, proposed.\n" {
				t.Fatal("the branches after a proposal")
			}
		}},
		{"only Markdown files under the size limit, outside hidden folders and node_modules, are pages", map[string]string{
			"docs/a.md": "A.\n", "docs/UPPER.MD": "Upper.\n", "docs/.hidden/b.md": "B.\n", "docs/node_modules/c.md": "C.\n",
			"docs/notes.txt": "text\n", "docs/big.md": strings.Repeat("x", 2<<20),
		}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			if res, _ := r.syncAnswering(200); res.PagesCreated != 2 {
				t.Fatalf("%+v", res)
			}
			s.pageID(t, "a")
			s.pageID(t, "UPPER")
		}},
		{"a file with a second opening heading keeps both and is called by its name", map[string]string{"docs/two.md": "# One\n\n# Two\n\nText.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			r.syncAnswering(200)
			if got := s.call(t, s.owner, "", "GET", w+"/docs/"+s.pageID(t, "two")+"?format=md", nil, 200, nil); !strings.Contains(got, "# One") {
				t.Fatalf("%q", got)
			}
			r.idle("after the first sync")
		}},
		{"folders become pages that hold their files, and a page made in one gets its file there", map[string]string{"docs/a/b/c.md": "C.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			if res, _ := r.syncAnswering(200); res.PagesCreated != 1 {
				t.Fatalf("%+v", res)
			}
			tree := s.call(t, s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil)
			if !strings.Contains(tree, "\n  a  (") || !strings.Contains(tree, "\n    b  (") || !strings.Contains(tree, "\n      c  (") {
				t.Fatal(tree)
			}
			s.change(t, s.owner, "", "doc.create", M{"parent": s.pageID(t, "b"), "title": "New Page", "markdown": "New.\n"})
			if res, _ := r.syncAnswering(200); res.FilesWritten != 1 {
				t.Fatalf("%+v", res)
			}
			if got := r.read("main", "docs/a/b/new-page.md"); got != "New.\n" {
				t.Fatalf("%q", got)
			}
			r.idle("after the new page")
		}},
		{"a page moved here keeps its file", map[string]string{"docs/a.md": "A.\n", "docs/f/b.md": "B.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			r.syncAnswering(200)
			s.change(t, s.owner, "", "doc.update", M{"id": s.pageID(t, "a"), "parent": s.pageID(t, "f")})
			r.idle("after a move")
			if got := r.files("main"); !strings.Contains(got, "docs/a.md") || strings.Contains(got, "docs/f/a.md") {
				t.Fatal(got)
			}
		}},
		{"the commit is the last editor's and names the others", map[string]string{"docs/a.md": "A.\n", "docs/b.md": "B.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			source(r, nil)
			r.syncAnswering(200)
			s.change(t, s.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
			var tok struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
			s.change(t, s.owner, "", "doc.write", M{"doc": s.pageID(t, "a"), "markdown": "A, by Aram.\n"})
			s.change(t, nil, tok.Token, "doc.write", M{"doc": s.pageID(t, "b"), "markdown": "B, by the artist.\n"})
			if res, _ := r.syncAnswering(200); res.FilesWritten != 2 {
				t.Fatalf("%+v", res)
			}
			if got := gitIn(t, r.origin, "log", "-1", "--format=%an <%ae>|%B", "main"); got != "Artist <artist@quadit.invalid>|docs: update 2 page(s) from Quadit\n\nAlso edited by: Aram" {
				t.Fatalf("%q", got)
			}
		}},
		{"a folder that cannot be read stops the sync and trashes nothing", map[string]string{"docs/a.md": "A.\n", "docs/sub/b.md": "B.\n"}, func(t *testing.T, s *site, r *syncedRepo) {
			if os.Geteuid() == 0 {
				t.Skip("root reads any folder")
			}
			source(r, nil)
			r.syncAnswering(200)
			sub := filepath.Join(s.dir, "repos", r.src, "docs", "sub")
			if err := os.Chmod(sub, 0o300); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.Chmod(sub, 0o755) })
			r.syncAnswering(500) // the server's own disk, not the source's setup
			s.pageID(t, "b")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newSite(t, testdb.SQLite(t))
			files := c.files
			if files == nil {
				files = map[string]string{"README.md": "readme\n"}
			}
			r := newSyncedRepo(t, s, files)
			c.run(t, s, r)
		})
	}
}

func TestARepositorySyncFailsWhenItCannotReadWhoEditedThePages(t *testing.T) {
	st := newFaultyStore(testdb.SQLite(t))
	s := newSite(t, st)
	r := newSyncedRepo(t, s, map[string]string{"docs/design.md": "# Design\n\nThe boss has three phases.\n"})
	r.src = s.change(t, s.owner, "", "source.create", M{"title": "Game docs", "repo": r.origin, "subdir": "docs"})["ref"].(string)
	r.sync()
	s.change(t, s.owner, "", "doc.write", M{"doc": s.pageID(t, "Design"), "markdown": "# Design\n\nThe boss has four phases.\n"})
	before := gitIn(t, r.origin, "rev-parse", "main")

	// The commit's author is read by id alone; signing in reads the same row
	// as a live one, and is let through.
	owner := s.ownerID(t)
	fired := st.faults.arm(fault{op: "get", table: "users", times: 1,
		match: func(_ map[string]any, where []store.Cond) bool {
			return len(where) == 1 && whereHas(where, "id", owner)
		}})
	// A database that does not answer is the server's failure, not a
	// conflict with what the source asks.
	r.syncAnswering(500)
	if fired() != 1 {
		t.Fatalf("fault fired %d times", fired())
	}
	if after := gitIn(t, r.origin, "rev-parse", "main"); after != before {
		t.Fatal("a commit went out though its author could not be read")
	}
	// The next run, with the database back, makes the commit in the editor's name.
	r.sync()
	if who := gitIn(t, r.origin, "log", "-1", "--format=%an <%ae>", "main"); who != "Aram <owner@example.com>" {
		t.Fatalf("the commit's author is %q", who)
	}
}
