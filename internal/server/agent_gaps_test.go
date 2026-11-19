package server_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/cli"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// quadit runs the command-line tool against the site as the holder of
// token, and gives back what it printed and its exit code.
func (s *site) quadit(t *testing.T, token string, args ...string) (string, int) {
	t.Helper()
	t.Setenv("QUADIT_URL", s.url)
	t.Setenv("QUADIT_TOKEN", token)
	t.Setenv("QUADIT_CONFIG", filepath.Join(s.dir, "no-config.json"))
	var out, errs bytes.Buffer
	code := cli.Run(args, &out, &errs)
	return out.String() + errs.String(), code
}

// agentToken makes an agent and a token for it.
func (s *site) agentToken(t *testing.T, handle string) string {
	t.Helper()
	s.change(t, s.owner, "", "agent.create", M{"name": handle, "handle": handle})
	var tok struct {
		Token string `json:"token"`
	}
	s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@" + handle}, 201, &tok)
	return tok.Token
}

// someFiles writes small files to a folder and gives their paths by name.
func someFiles(t *testing.T, names ...string) map[string]string {
	dir := t.TempDir()
	out := map[string]string{}
	for _, n := range names {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, []byte("picture "+n), 0o600); err != nil {
			t.Fatal(err)
		}
		out[n] = p
	}
	return out
}

// askedFiles is what a task's events say was attached where: the file
// names on the question, and on each option by its id.
func (s *site) askedFiles(t *testing.T, token, key string) (question []string, onOption map[string][]string) {
	t.Helper()
	var page struct {
		Events []struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		} `json:"events"`
	}
	s.call(t, nil, token, "GET", "/api/v1/w/-/events?task="+key+"&limit=500", nil, 200, &page)
	type att struct {
		SubjectType string `json:"subject_type"`
		SubjectID   string `json:"subject_id"`
		File        struct {
			Name string `json:"name"`
		} `json:"file"`
	}
	onOption = map[string][]string{}
	for _, ev := range page.Events {
		var d struct {
			Row         att   `json:"row"`
			Attachments []att `json:"attachments"`
		}
		json.Unmarshal(ev.Data, &d)
		switch ev.Type {
		case "decision.opened":
			for _, a := range d.Attachments {
				onOption[a.SubjectID] = append(onOption[a.SubjectID], a.File.Name)
			}
		case "attachment.created":
			if d.Row.SubjectType == "decision" {
				question = append(question, d.Row.File.Name)
			}
		}
	}
	return question, onOption
}

// TestAskWithFiles: a question goes out with its pictures in one go, each
// file on what it was typed after, and the same --id sent again does
// nothing twice.
func TestAskWithFiles(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		agent := s.agentToken(t, "coder")
		f := someFiles(t, "context.png", "a.gif", "b.gif", "b-side.gif")

		// Nothing is sent when a file cannot be read.
		if out, code := s.quadit(t, agent, "ask", "SVA-1", "Which arrival?", "option=A", "file="+f["a.gif"], "option=B", "file=/no/such.gif"); code == 0 || !strings.Contains(out, "/no/such.gif") {
			t.Fatalf("an unreadable file: %d %s", code, out)
		}
		// A dry run uploads nothing and says where each file would go.
		ask := []string{"ask", "SVA-1", "Which arrival?", "file=" + f["context.png"], "option=A announced", "file=" + f["a.gif"],
			"option=B walks in", "file=" + f["b.gif"], "file=" + f["b-side.gif"], "recommended=2", "why=it surprises"}
		out, code := s.quadit(t, agent, append([]string{"--dry-run"}, ask...)...)
		if code != 0 || !strings.Contains(out, "would attach "+f["context.png"]+" to the question") || !strings.Contains(out, "would attach "+f["b-side.gif"]+" to option 2") {
			t.Fatalf("dry run: %d %s", code, out)
		}
		if detail := s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, nil); strings.Contains(detail, "Which arrival?") {
			t.Fatalf("the dry run opened the decision: %s", detail)
		}

		given := "--id=" + id.New()
		out, code = s.quadit(t, agent, append([]string{given, "--json"}, ask...)...)
		if code != 0 {
			t.Fatalf("ask with files: %d %s", code, out)
		}
		var res struct {
			Decision struct{ Ref string } `json:"decision"`
			Files    []struct{ ID, On string }
		}
		if err := json.Unmarshal([]byte(out), &res); err != nil || res.Decision.Ref == "" || len(res.Files) != 4 || res.Files[0].ID == "" {
			t.Fatalf("--json: %v %s", err, out)
		}

		var detail struct {
			Decisions []struct {
				ID          string
				Recommended int
				Options     []struct {
					ID          string
					Label       string
					Attachments []struct{ Name string }
				}
			}
		}
		s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &detail)
		if len(detail.Decisions) != 1 || len(detail.Decisions[0].Options) != 2 || detail.Decisions[0].Recommended != 2 {
			t.Fatalf("decisions = %+v", detail.Decisions)
		}
		names := func(i int) string {
			var n []string
			for _, a := range detail.Decisions[0].Options[i].Attachments {
				n = append(n, a.Name)
			}
			return strings.Join(n, ",")
		}
		if names(0) != "a.gif" || names(1) != "b.gif,b-side.gif" {
			t.Fatalf("option files = %q and %q", names(0), names(1))
		}
		// The question's own file came in the same write as the question.
		question, onOption := s.askedFiles(t, agent, "SVA-1")
		if strings.Join(question, ",") != "context.png" || strings.Join(onOption[detail.Decisions[0].Options[1].ID], ",") != "b.gif,b-side.gif" {
			t.Fatalf("question files %v, option files %v", question, onOption)
		}

		// The same command with the same id again: nothing new.
		var before struct{ Seq int64 }
		s.call(t, nil, agent, "GET", "/api/v1/w/-/me", nil, 200, &before)
		if out, code := s.quadit(t, agent, append([]string{given}, ask...)...); code != 0 {
			t.Fatalf("retry: %d %s", code, out)
		}
		var after struct{ Seq int64 }
		s.call(t, nil, agent, "GET", "/api/v1/w/-/me", nil, 200, &after)
		s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &detail)
		if after.Seq != before.Seq || len(detail.Decisions) != 1 || names(1) != "b.gif,b-side.gif" {
			t.Fatalf("the retry changed things: seq %d -> %d, %+v", before.Seq, after.Seq, detail.Decisions)
		}

		// An approval takes files too: they are on the question.
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Cut the intro"})
		if out, code := s.quadit(t, agent, "approval", "SVA-2", "Cut it?", "file="+f["a.gif"]); code != 0 {
			t.Fatalf("approval with a file: %d %s", code, out)
		}
		if question, _ := s.askedFiles(t, agent, "SVA-2"); strings.Join(question, ",") != "a.gif" {
			t.Fatalf("approval files = %v", question)
		}
	})
}

// TestCommentsWithFiles: a comment, a result and a reply each take their
// files with them, on a task and on a page, and nothing is sent when a file
// cannot be read.
func TestCommentsWithFiles(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Art notes"})["ref"].(string)
		agent := s.agentToken(t, "coder")
		f := someFiles(t, "wip.png", "done.png", "closer.png", "sheet.png", "sheet-2.png")
		run := func(args ...string) {
			t.Helper()
			if out, code := s.quadit(t, agent, args...); code != 0 {
				t.Fatalf("quadit %s: %s", strings.Join(args, " "), out)
			}
		}
		// comments is every comment so far by its text: its id and the names of its files.
		type comment struct {
			id    string
			files []string
		}
		comments := func() map[string]comment {
			t.Helper()
			var page struct {
				Events []struct {
					Data struct {
						Row struct {
							ID   string `json:"id"`
							Body string `json:"body"`
						} `json:"row"`
						Attachments []struct {
							File struct {
								Name string `json:"name"`
							} `json:"file"`
						} `json:"attachments"`
					} `json:"data"`
				} `json:"events"`
			}
			s.call(t, nil, agent, "GET", "/api/v1/w/-/events?after=0&types=comment.created&limit=500", nil, 200, &page)
			out := map[string]comment{}
			for _, ev := range page.Events {
				c := comment{id: ev.Data.Row.ID}
				for _, a := range ev.Data.Attachments {
					c.files = append(c.files, a.File.Name)
				}
				out[ev.Data.Row.Body] = c
			}
			return out
		}
		has := func(body string, want ...string) {
			t.Helper()
			if got := comments()[body].files; !slices.Equal(got, want) {
				t.Errorf("the files of %q: %v, want %v", body, got, want)
			}
		}

		if out, code := s.quadit(t, agent, "reply", "c-none", "Look.", "file=/no/such.png"); code == 0 || !strings.Contains(out, "/no/such.png") {
			t.Fatalf("an unreadable file: %d %s", code, out)
		}

		run("comment", "SVA-1", "Half way.", "file="+f["wip.png"])
		has("Half way.", "wip.png")
		run("result", "SVA-1", "Drew it.", "checked=by eye", "file="+f["done.png"])
		has("Drew it.", "done.png")
		run("reply", comments()["Half way."].id, "A closer look.", "file="+f["closer.png"])
		has("A closer look.", "closer.png")

		run("comment", "page="+page, "The sprite sheet.", "file="+f["sheet.png"])
		has("The sprite sheet.", "sheet.png")
		run("reply", comments()["The sprite sheet."].id, "With the second row.", "file="+f["sheet-2.png"])
		has("With the second row.", "sheet-2.png")
	})
}

// TestUnassign: "none", "nobody", "-" and nothing at all clear the
// assignee, with assign and with update alike.
func TestUnassign(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss arrival"})
		agent := s.agentToken(t, "coder")
		assignee := func() any {
			var d struct{ Task struct{ Assignee any } }
			s.call(t, nil, agent, "GET", "/api/v1/w/-/tasks/SVA-1", nil, 200, &d)
			return d.Task.Assignee
		}
		for _, cmd := range [][]string{{"assign", "SVA-1", "none"}, {"assign", "SVA-1", "nobody"}, {"assign", "SVA-1", "-"},
			{"assign", "SVA-1", ""}, {"update", "SVA-1", "assignee="}, {"update", "SVA-1", "assignee=none"}} {
			if out, code := s.quadit(t, agent, "assign", "SVA-1", "@aram"); code != 0 || assignee() != "@aram" {
				t.Fatalf("assign: %d %s", code, out)
			}
			if out, code := s.quadit(t, agent, cmd...); code != 0 {
				t.Fatalf("%q: %d %s", cmd, code, out)
			}
			if a := assignee(); a != nil && a != "" {
				t.Fatalf("%q left the task with %v", cmd, a)
			}
		}
	})
}

// syncedRepo is a bare repository with a clone to change it from, and a
// source syncing it on the site.
type syncedRepo struct {
	t            *testing.T
	s            *site
	origin, work string
	src          string
}

func newSyncedRepo(t *testing.T, s *site, files map[string]string) *syncedRepo {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	tmp := t.TempDir()
	r := &syncedRepo{t: t, s: s, origin: filepath.Join(tmp, "origin.git"), work: filepath.Join(tmp, "work")}
	gitIn(t, tmp, "init", "--quiet", "--bare", "-b", "main", r.origin)
	gitIn(t, tmp, "clone", "--quiet", r.origin, r.work)
	for rel, text := range files {
		r.write(rel, text)
	}
	r.push("first")
	return r
}

func (r *syncedRepo) write(rel, text string) {
	p := filepath.Join(r.work, rel)
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *syncedRepo) push(msg string) {
	gitIn(r.t, r.work, "add", "--all")
	gitIn(r.t, r.work, "commit", "--quiet", "-m", msg)
	gitIn(r.t, r.work, "push", "--quiet", "origin", "HEAD:main")
}

// read is a file as the repository's branch has it now.
func (r *syncedRepo) read(branch, rel string) string {
	return gitIn(r.t, r.origin, "show", branch+":"+rel) + "\n"
}

type syncAnswer struct {
	PagesCreated int    `json:"pages_created"`
	PagesUpdated int    `json:"pages_updated"`
	FilesWritten int    `json:"files_written"`
	Pushed       string `json:"pushed"`
	Note         string `json:"note"`
}

func (r *syncedRepo) sync() syncAnswer {
	r.t.Helper()
	var res syncAnswer
	r.s.call(r.t, r.s.owner, "", "POST", w+"/sources/"+r.src+"/sync", nil, 200, &res)
	return res
}

// idle checks that a sync finds nothing to do on either side.
func (r *syncedRepo) idle(when string) {
	r.t.Helper()
	if res := r.sync(); res.PagesUpdated != 0 || res.FilesWritten != 0 || res.PagesCreated != 0 {
		r.t.Fatalf("%s, a sync with nothing changed did something: %+v", when, res)
	}
}

// pageID finds a page by its title in the page tree.
func (s *site) pageID(t *testing.T, title string) string {
	t.Helper()
	for line := range strings.SplitSeq(s.call(t, s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), title+"  (") {
			return line[strings.LastIndex(line, "(")+1 : len(line)-1]
		}
	}
	t.Fatalf("no page %q in:\n%s", title, s.call(t, s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil))
	return ""
}

func hashOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

// TestSyncTitleFromHeading: a file is called by its opening heading, which
// its page does not repeat; written back, the heading comes first again,
// and an unchanged file stays unchanged. A page synced before this keeps
// its title until its file changes.
func TestSyncTitleFromHeading(t *testing.T) {
	st := testdb.SQLite(t)
	s := newSite(t, st)
	r := newSyncedRepo(t, s, map[string]string{
		"docs/WEAPON_VFX_PLAN.md": "# Weapon VFX plan\n\nThree phases.\n",
		"docs/notes.md":           "No heading here.\n",
		"docs/front.md":           "---\nowner: aram\n---\n\n# Front matter title\n\nText.\n",
		"docs/OLD_STYLE.md":       "# Old style\n\nBody.\n",
	})
	r.src = s.change(t, s.owner, "", "source.create", M{"title": "Game docs", "repo": r.origin, "subdir": "docs"})["ref"].(string)
	if res := r.sync(); res.PagesCreated != 4 {
		t.Fatalf("first sync: %+v", res)
	}
	plan := s.pageID(t, "Weapon VFX plan")
	s.pageID(t, "notes")
	s.pageID(t, "Front matter title")
	if md := s.call(t, s.owner, "", "GET", w+"/docs/"+plan+"?format=md", nil, 200, nil); strings.Contains(md, "# Weapon VFX plan") || !strings.Contains(md, "Three phases.") {
		t.Fatalf("the page repeats its heading, or lost its text:\n%s", md)
	}
	r.idle("after the first sync")

	// Edited here: the file gets the heading back in front, and nothing else.
	s.change(t, s.owner, "", "doc.write", M{"doc": plan, "markdown": "Four phases.\n"})
	if res := r.sync(); res.FilesWritten != 1 {
		t.Fatalf("page edit: %+v", res)
	}
	if got := r.read("main", "docs/WEAPON_VFX_PLAN.md"); got != "# Weapon VFX plan\n\nFour phases.\n" {
		t.Fatalf("the file after a page edit: %q", got)
	}
	r.idle("after a page edit")

	// Renamed here: the heading follows, the file keeps its name.
	s.change(t, s.owner, "", "doc.update", M{"id": plan, "title": "Weapon plan"})
	if res := r.sync(); res.FilesWritten != 1 {
		t.Fatalf("rename: %+v", res)
	}
	if got := r.read("main", "docs/WEAPON_VFX_PLAN.md"); got != "# Weapon plan\n\nFour phases.\n" {
		t.Fatalf("the file after a rename: %q", got)
	}
	if out := gitIn(t, r.origin, "ls-tree", "--name-only", "main", "docs/"); strings.Contains(out, "weapon-plan") {
		t.Fatalf("a rename made a new file: %s", out)
	}
	r.idle("after a rename")

	// A page synced before titles came from headings: called by its file's
	// name, the heading in its text, and the hashes of then.
	old := s.pageID(t, "Old style")
	s.change(t, s.owner, "", "doc.update", M{"id": old, "title": "OLD_STYLE"})
	s.change(t, s.owner, "", "doc.write", M{"doc": old, "markdown": "# Old style\n\nBody.\n"})
	if _, err := st.Update(context.Background(), "docs", map[string]any{"source_hash": hashOf("# Old style\n\nBody.\n") + ":" + hashOf("# Old style\n\nBody.\n")}, store.Eq("id", old)); err != nil {
		t.Fatal(err)
	}
	r.idle("with a page synced the old way")
	s.pageID(t, "OLD_STYLE")
	// Once its file changes, it is called by the heading too.
	gitIn(t, r.work, "pull", "--quiet", "origin", "main")
	r.write("docs/OLD_STYLE.md", "# Old style\n\nBody two.\n")
	r.push("edit")
	if res := r.sync(); res.PagesUpdated != 1 || res.FilesWritten != 0 {
		t.Fatalf("file edit of an old page: %+v", res)
	}
	if md := s.call(t, s.owner, "", "GET", w+"/docs/"+s.pageID(t, "Old style")+"?format=md", nil, 200, nil); strings.Contains(md, "# Old style") {
		t.Fatalf("the old page still repeats its heading:\n%s", md)
	}
	r.idle("after the old page took its heading")
	if got := r.read("main", "docs/OLD_STYLE.md"); got != "# Old style\n\nBody two.\n" {
		t.Fatalf("the old page's file: %q", got)
	}
}

// TestSyncClonesOnlyWhatItNeeds: a source with a folder gets a working copy
// with the last commit and that folder only, and still commits and proposes
// from it. A working copy made whole before stays whole and keeps working.
func TestSyncClonesOnlyWhatItNeeds(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	r := newSyncedRepo(t, s, map[string]string{"docs/plan.md": "Plan.\n", "assets/big.bin": "pretend this is 420 MB\n", "README.md": "readme\n"})
	r.write("assets/more.bin", "and more\n")
	r.push("second")
	r.src = s.change(t, s.owner, "", "source.create", M{"title": "Game docs", "repo": "file://" + r.origin, "subdir": "docs"})["ref"].(string)
	if res := r.sync(); res.PagesCreated != 1 {
		t.Fatalf("first sync: %+v", res)
	}
	copyDir := filepath.Join(s.dir, "repos", r.src)
	if n := gitIn(t, copyDir, "rev-list", "--count", "HEAD"); n != "1" {
		t.Fatalf("the working copy holds %s commits", n)
	}
	if _, err := os.Stat(filepath.Join(copyDir, "assets", "big.bin")); err == nil {
		t.Fatal("the working copy checked out more than the folder")
	}
	if _, err := os.Stat(filepath.Join(copyDir, "docs", "plan.md")); err != nil {
		t.Fatalf("the folder is not checked out: %v", err)
	}

	// Commits go out from it, and a change there comes in.
	plan := s.pageID(t, "plan")
	s.change(t, s.owner, "", "doc.write", M{"doc": plan, "markdown": "Plan two.\n"})
	if res := r.sync(); res.FilesWritten != 1 || res.Pushed != "main" {
		t.Fatalf("commit: %+v", res)
	}
	if got := r.read("main", "docs/plan.md"); got != "Plan two.\n" || r.read("main", "assets/big.bin") != "pretend this is 420 MB\n" {
		t.Fatalf("after the commit: plan %q", got)
	}
	gitIn(t, r.work, "pull", "--quiet", "origin", "main")
	r.write("docs/plan.md", "Plan three.\n")
	r.push("from there")
	if res := r.sync(); res.PagesUpdated != 1 {
		t.Fatalf("a change there: %+v", res)
	}
	r.idle("after a change there")

	// Proposed, twice: the second goes over the first.
	s.change(t, s.owner, "", "source.update", M{"id": r.src, "write_mode": "propose"})
	for _, text := range []string{"Proposal one.\n", "Proposal two.\n"} {
		s.change(t, s.owner, "", "doc.write", M{"doc": plan, "markdown": text})
		if res := r.sync(); res.Pushed != "quadit/docs" {
			t.Fatalf("propose: %+v", res)
		}
		if got := r.read("quadit/docs", "docs/plan.md"); got != text {
			t.Fatalf("the proposal holds %q", got)
		}
	}

	// A working copy made whole, the way it was before, keeps working.
	whole := s.change(t, s.owner, "", "source.create", M{"title": "Whole", "repo": r.origin, "subdir": "docs"})["ref"].(string)
	gitIn(t, s.dir, "clone", "--quiet", "--no-checkout", r.origin, filepath.Join(s.dir, "repos", whole))
	r.src = whole
	if res := r.sync(); res.PagesCreated != 1 {
		t.Fatalf("the whole working copy: %+v", res)
	}
	if n := gitIn(t, filepath.Join(s.dir, "repos", whole), "rev-list", "--count", "HEAD"); n == "1" {
		t.Fatal("the whole working copy was made shallow")
	}
}
