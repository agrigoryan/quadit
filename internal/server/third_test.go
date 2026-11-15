package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestThirdAuditFindings holds what a third independent check of the build
// found, each as the smallest case that showed it.
func TestThirdAuditFindings(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate the keys"})
		for _, h := range []string{"wide", "narrow"} {
			s.change(s.owner, "", "agent.create", M{"name": h, "handle": h})
		}
		tok := func(h string) string {
			var out struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@" + h}, 201, &out)
			return out.Token
		}
		do := func(token, typ string, args any, want int) string {
			return s.call(nil, token, "POST", "/api/v1/w/-/changes", M{"id": id.New(), "type": typ, "args": args}, want, nil)
		}
		wide := tok("wide")

		// A part of an agent's limits that an update leaves out stays.
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"projects": []string{"OPS"}, "read_only": true, "needs_approval": []string{"task.delete"}}})
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"needs_approval": []string{"task.move"}}})
		out := s.call(s.owner, "", "GET", w+"/list/members", nil, 200, nil)
		if !strings.Contains(out, `"read_only":true`) || !strings.Contains(out, `"needs_approval":["task.move"]`) || strings.Contains(out, "task.delete") {
			t.Fatalf("a partial update of limits did not keep the rest: %s", out)
		}
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"read_only": false}})
		narrow := tok("narrow")
		if out := s.call(nil, narrow, "GET", "/api/v1/w/-/list/projects", nil, 200, nil); strings.Contains(out, "Samurai") {
			t.Fatalf("lifting read-only lifted the project limit too: %s", out)
		}
		// A person's limits with nothing in them is no limit, not a crash.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		mia := browser()
		s.call(mia, "", "POST", "/api/v1/auth/register", M{"name": "Mia", "email": "mia@example.com", "password": "another-long-password"}, 201, nil)
		s.change(s.owner, "", "member.add", M{"user": "mia@example.com"})
		s.change(s.owner, "", "member.update", M{"id": "@mia", "scope": M{}})
		s.call(mia, "", "GET", w+"/tasks/OPS-1", nil, 200, nil)

		// Limited to one project: nothing of another's shows through.
		s.change(s.owner, "", "epic.create", M{"project": "SVA", "name": "Boss fight"})
		s.change(s.owner, "", "milestone.create", M{"epic": "Boss fight", "name": "Alpha"})
		var f struct{ ID string }
		s.call(s.owner, "", "POST", w+"/files?name=secret.txt", []byte("for SVA eyes"), 201, &f)
		s.change(s.owner, "", "attachment.add", M{"task": "SVA-1", "file": f.ID})
		do(wide, "session.start", M{"task": "SVA-1", "title": "Drawing the secret boss"}, 200)
		do(wide, "comment.create", M{"task": "SVA-1", "body": "On it."}, 200)
		s.call(nil, narrow, "GET", "/api/v1/w/-/files/"+f.ID, nil, 404, nil)
		for _, path := range []string{"/bootstrap", "/list/milestones", "/list/members", "/agents", "/dashboard", "/list/sessions"} {
			out := s.call(nil, narrow, "GET", "/api/v1/w/-"+path, nil, 200, nil)
			for _, leak := range []string{"secret boss", "Alpha", "SVA-1"} {
				if strings.Contains(out, leak) {
					t.Fatalf("%s shows %q to an agent limited to OPS: %s", path, leak, out)
				}
			}
		}

		// A helper does not make helpers; a suspended one is not "idle".
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": nil})
		do(wide, "agent.create", M{"name": "Helper", "handle": "helper", "task": "OPS-1"}, 200)
		helper := tok("helper")
		if out := do(helper, "agent.create", M{"name": "Nested", "handle": "nested", "task": "OPS-1"}, 403); !strings.Contains(out, "cannot make helpers") {
			t.Fatalf("a helper made a helper: %s", out)
		}
		s.change(s.owner, "", "task.update", M{"id": "OPS-1", "status": "Done"})
		if out := s.call(s.owner, "", "GET", w+"/agents", nil, 200, nil); strings.Contains(out, "@helper") {
			t.Fatalf("a suspended helper is listed among the agents at work: %s", out)
		}

		// The text line of a standing preference carries its text.
		s.change(s.owner, "", "preference.create", M{"body": "Explosions are always ring-shaped"})
		if out := s.call(s.owner, "", "GET", w+"/list/preferences?format=text", nil, 200, nil); !strings.Contains(out, "ring-shaped") {
			t.Fatalf("a preference's line has no text: %s", out)
		}

		// A moved task is still found under the key it had.
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Moves away"})
		moved := s.change(s.owner, "", "task.move", M{"id": "SVA-2", "project": "OPS"})["key"].(string)
		if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-2", nil, 200, nil); !strings.Contains(out, moved) {
			t.Fatalf("SVA-2 does not lead to %s: %s", moved, out)
		}
		do(wide, "comment.create", M{"task": "SVA-2", "body": "Found by the old key."}, 200)

		// An import keeps a task's number; the next task made goes past it.
		do(wide, "task.create", M{"project": "SVA", "title": "Not for a member", "number": 40}, 403)
		if key := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "From elsewhere", "number": 40})["key"]; key != "SVA-40" {
			t.Fatalf("number 40 gave %v", key)
		}
		s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Twice", "number": 40}}, 409, nil)
		s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "task.create", "args": M{"project": "SVA", "title": "Was moved", "number": 2}}, 409, nil)
		if key := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "The next one"})["key"]; key != "SVA-41" {
			t.Fatalf("the task after number 40 is %v", key)
		}
		if key := s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Into a gap", "number": 7})["key"]; key != "SVA-7" {
			t.Fatalf("number 7 gave %v", key)
		}

		// A saved view names only what exists; one whose label was deleted
		// since is read without that part, and says so.
		s.change(s.owner, "", "label.create", M{"project": "SVA", "name": "zed"})
		for _, q := range []M{{"label": []string{"nope"}}, {"status": []string{"Nope"}}, {"sort": "bogus"}} {
			if out := s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Bad", "query": q}}, 400, nil); strings.Contains(out, "Go ") {
				t.Fatalf("a view with %v: %s", q, out)
			}
		}
		s.change(s.owner, "", "view.create", M{"name": "Zed things", "project": "SVA", "query": M{"label": []string{"zed"}}})
		res := s.change(s.owner, "", "label.delete", M{"id": "zed"})
		if key, _ := res["key"].(string); strings.HasPrefix(key, "SVA-") {
			t.Fatalf("label.delete answered with a task key: %v", res)
		}
		if out := s.call(s.owner, "", "GET", w+"/tasks?view=zed-things&format=text", nil, 200, nil); !strings.Contains(out, "no longer exists") || !strings.Contains(out, "SVA-1") {
			t.Fatalf("a view whose label is gone: %s", out)
		}

		// A list read page by page while a task's place in it changes: none is missed.
		for i := 0; i < 6; i++ {
			s.change(s.owner, "", "task.create", M{"project": "OPS", "title": fmt.Sprintf("Ordered %d", i), "priority": 3})
		}
		type page struct {
			Tasks      []struct{ Key string }
			NextCursor string `json:"next_cursor"`
			NextOffset *int   `json:"next_offset"`
		}
		var p page
		s.call(s.owner, "", "GET", w+"/tasks?project=OPS&open=1&sort=priority&limit=3", nil, 200, &p)
		seen := map[string]bool{}
		for _, tk := range p.Tasks {
			seen[tk.Key] = true
		}
		var all page
		s.call(s.owner, "", "GET", w+"/tasks?project=OPS&open=1&sort=priority&limit=50", nil, 200, &all)
		last := all.Tasks[len(all.Tasks)-1].Key
		s.change(s.owner, "", "task.update", M{"id": last, "priority": "urgent"}) // jumps behind the reader
		for p.NextCursor != "" {
			cur := p.NextCursor
			p = page{}
			s.call(s.owner, "", "GET", w+"/tasks?project=OPS&open=1&sort=priority&limit=3&cursor="+cur, nil, 200, &p)
			if p.NextOffset != nil {
				t.Fatal("a page read by cursor still offers an offset")
			}
			for _, tk := range p.Tasks {
				seen[tk.Key] = true
			}
		}
		for _, tk := range all.Tasks {
			if !seen[tk.Key] {
				t.Fatalf("%s was never returned (raised: %s)", tk.Key, last)
			}
		}

		// Settings: a cleared limit applies at once, a tiny one is refused,
		// and null on a sign-in setting means its default.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/limits.api_per_minute", json.RawMessage("-5"), 400, nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/limits.api_per_minute", json.RawMessage("30"), 200, nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/limits.api_per_minute", json.RawMessage("null"), 200, nil)
		if f := s.srv.LimitFactor(); f != 1 {
			t.Fatalf("after clearing the limit the factor is %v", f)
		}
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.password", json.RawMessage("null"), 200, nil)

		// Messages speak of fields, not of the decoder.
		for _, c := range []struct {
			typ  string
			args any
		}{{"task.update", M{"id": "SVA-1", "priority": 1.5}}, {"task.update", []string{"SVA-1"}}, {"view.create", M{"name": "V", "query": M{"label": "art"}}}} {
			out := do(wide, c.typ, c.args, 400)
			if strings.Contains(out, "Go ") || strings.Contains(out, "unmarshal") || strings.Contains(out, ":  takes") {
				t.Fatalf("%s %v: %s", c.typ, c.args, out)
			}
		}
		if out := s.call(nil, wide, "PUT", "/api/v1/w/-/cursors/x", M{"seq": "a"}, 400, nil); strings.Contains(out, "Go ") {
			t.Fatalf("a cursor of the wrong kind: %s", out)
		}
		if out := s.call(nil, wide, "GET", "/api/v1/w/-/me?format=text", nil, 200, nil); strings.Contains(out, "map[") {
			t.Fatalf("me prints a Go map: %s", out)
		}

		// What a change wrote for someone else alone does not come back to its sender.
		out = s.call(s.owner, "", "POST", w+"/changes?events=1", M{"id": id.New(), "type": "comment.create", "args": M{"task": "SVA-1", "body": "@wide look"}}, 200, nil)
		if strings.Contains(out, "notification.created") {
			t.Fatalf("the sender got the other member's notice: %s", out)
		}

		// A push subscription is taken as browsers send it, with its
		// (empty) expiry: a real phone's was refused for that field.
		s.call(s.owner, "", "POST", "/api/v1/push/subscriptions", json.RawMessage(`{"endpoint":"https://fcm.googleapis.com/fcm/send/abc","expirationTime":null,"keys":{"p256dh":"BPk","auth":"x1"}}`), 201, nil)

		// What a fourth check found. A claim made for another project's
		// task does not reach a limited member through the feed.
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": M{"projects": []string{"OPS"}}})
		s.change(s.owner, "", "resource.create", M{"name": "minipc"})
		s.change(s.owner, "", "resource.acquire", M{"resource": "minipc", "task": "SVA-1", "note": "secret playtest"})
		if out := s.call(nil, narrow, "GET", "/api/v1/w/-/events?after=0&limit=2000", nil, 200, nil); strings.Contains(out, "secret playtest") {
			t.Fatalf("a claim on an SVA task reached an agent limited to OPS: %s", out)
		}
		s.change(s.owner, "", "agent.update", M{"id": "@narrow", "scope": nil})
		// A misspelt part of the limits is refused, not dropped.
		s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "agent.update", "args": M{"id": "@narrow", "scope": M{"projcts": []string{"OPS"}}}}, 400, nil)
		// More values a saved view cannot name.
		for _, q := range []M{{"assignee": []string{"@nobody"}}, {"epic": []string{"Nope epic"}}, {"priority": []int{9}}} {
			s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Bad", "query": q}}, 400, nil)
		}
		s.change(s.owner, "", "view.create", M{"name": "Mine", "query": M{"assignee": []string{"me", "@wide", "none"}, "epic": []string{"Boss fight", "none"}, "priority": []int{1, 2}}})
		// Numbers and yes/no parameters of another kind are refused.
		for _, q := range []string{"/events?after=abc", "/events?wait=abc", "/events?limit=abc", "/tasks?offset=-1", "/tasks?has_open_decision=maybe", "/tasks?count=maybe", "/events?after=99999999"} {
			if out := s.call(nil, wide, "GET", "/api/v1/w/-"+q, nil, 400, nil); strings.Contains(out, "Go ") {
				t.Fatalf("%s: %s", q, out)
			}
		}
		// An archived task says so.
		s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Put away"})
		var made struct{ Tasks []struct{ Key string } }
		s.call(s.owner, "", "GET", w+"/tasks?q=Put+away", nil, 200, &made)
		s.change(s.owner, "", "task.update", M{"id": made.Tasks[0].Key, "archived": true})
		if out := s.call(s.owner, "", "GET", w+"/tasks/"+made.Tasks[0].Key+"?format=text", nil, 200, nil); !strings.Contains(out, "archived") {
			t.Fatalf("an archived task does not say so: %s", out)
		}
		if out := s.call(s.owner, "", "GET", w+"/events?format=text&after=0&limit=2000", nil, 200, nil); !strings.Contains(out, made.Tasks[0].Key+" archived") {
			t.Fatalf("archiving has no words in the feed: %s", out[max(0, len(out)-400):])
		}

		// What a fifth check found. Someone limited after taking a shared
		// resource can still let go of it.
		do(wide, "resource.acquire", M{"resource": "minipc", "task": "SVA-1"}, 200)
		s.change(s.owner, "", "agent.update", M{"id": "@wide", "scope": M{"projects": []string{"OPS"}}})
		do(wide, "resource.release", M{"resource": "minipc"}, 200)
		s.change(s.owner, "", "agent.update", M{"id": "@wide", "scope": nil})
		// More that a saved view cannot name, and parameters of the wrong kind.
		for _, q := range []M{{"creator": "@nobody"}, {"parent": "SVA-999"}} {
			s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Bad", "query": q}}, 400, nil)
		}
		for _, q := range []string{"/events?after=-5", "/tasks?due_before=notadate", "/events?compact=maybe", "/render?task=SVA-1&height=10"} {
			s.call(nil, wide, "GET", "/api/v1/w/-"+q, nil, 400, nil)
		}
		// A sixth check: whatever a view names is looked up as opening it will.
		for _, q := range []M{{"waiting_on": "@nobody"}, {"held_by": "@nobody"}, {"due_before": "notadate"}, {"due_after": "2026-13-45"}, {"changed_since": -4}, {"keys": []string{"SVA-999"}}} {
			if out := s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "view.create", "args": M{"name": "Bad", "query": q}}, 400, nil); strings.Contains(out, "Go ") {
				t.Fatalf("%v: %s", q, out)
			}
		}
		s.change(s.owner, "", "view.create", M{"name": "Good", "project": "SVA", "query": M{"waiting_on": "me", "held_by": "@wide", "due_before": "2026-12-31", "keys": []string{"SVA-1"}, "status": []string{"Todo"}, "open": true}})
		s.call(s.owner, "", "GET", w+"/tasks?view=good", nil, 200, nil)
		s.call(nil, wide, "GET", "/api/v1/w/-/render?task=SVA-1&width=5", nil, 400, nil)

		// A seventh check. "Nobody, or one of these" means either.
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "In the fight", "epic": "Boss fight", "assignee": "@wide"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Loose end"})
		for _, q := range []string{"epic=none,Boss+fight", "assignee=none,@wide"} {
			out := s.call(s.owner, "", "GET", w+"/tasks?project=SVA&format=text&limit=200&"+q, nil, 200, nil)
			if !strings.Contains(out, "In the fight") || !strings.Contains(out, "Loose end") {
				t.Fatalf("%s lost one side of the list: %s", q, out)
			}
		}
		// "The current cycle" on a day with none running is nothing, not an error.
		if out := s.call(s.owner, "", "GET", w+"/tasks?project=OPS&cycle=current&format=text", nil, 200, nil); !strings.Contains(out, "no tasks match") {
			t.Fatalf("cycle=current with no cycle running: %s", out)
		}
		// A source's folder cannot lead out of its repository.
		for _, dir := range []string{"../../outside", "docs/../../x", ".git/hooks"} {
			s.call(s.owner, "", "POST", w+"/changes", M{"id": id.New(), "type": "source.create", "args": M{"title": "Out", "repo": "/tmp/nowhere.git", "subdir": dir}}, 400, nil)
		}

		// A failed press of "Test" is in the log, not among the lost.
		hook := s.change(s.owner, "", "webhook.create", M{"name": "nowhere", "url": "http://127.0.0.1:9/x"})["ref"].(string)
		s.call(s.owner, "", "POST", w+"/webhooks/"+hook+"/test", nil, 200, nil)
		if out := s.call(s.owner, "", "GET", w+"/dashboard", nil, 200, nil); !strings.Contains(out, `"deliveries_dead":0`) {
			t.Fatalf("a failed test send counts as a lost delivery: %s", out[max(0, len(out)-300):])
		}
		s.change(s.owner, "", "webhook.delete", M{"id": hook})

		// A call to MCP with no token at all is counted like a wrong one.
		limited := false
		for i := 0; i < 140 && !limited; i++ {
			resp, err := http.Post(s.url+"/mcp", "application/json", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			limited = resp.StatusCode == 429
			resp.Body.Close()
		}
		if !limited {
			t.Fatal("140 calls with no token were never slowed down")
		}
	})
}

// TestSyncDoesNotFollowLinks: a repository may hold symbolic links to
// anywhere on the server. Sync reads none of them as pages, takes no folder
// through one, and writes nothing through one.
func TestSyncDoesNotFollowLinks(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	s := newSite(t, testdb.SQLite(t))
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "secret.md"), []byte("the server's own secret"), 0o600)
	os.MkdirAll(filepath.Join(outside, "sub"), 0o700)
	os.WriteFile(filepath.Join(outside, "sub", "deep.md"), []byte("deep outside text"), 0o600)
	work := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = work
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	os.MkdirAll(filepath.Join(work, "docs"), 0o755)
	os.WriteFile(filepath.Join(work, "docs", "real.md"), []byte("# Real\n\nA real page.\n"), 0o644)
	os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(work, "docs", "leak.md"))
	os.Symlink(outside, filepath.Join(work, "link"))
	run("add", "-A")
	run("commit", "-q", "-m", "docs")
	// What is synced is a bare repository, which can be pushed to.
	bare := filepath.Join(t.TempDir(), "origin.git")
	run("init", "-q", "--bare", "-b", "main", bare)
	run("remote", "add", "origin", bare)
	run("push", "-q", "origin", "main")

	src := s.change(s.owner, "", "source.create", M{"title": "Handbook", "repo": bare, "subdir": "docs"})["ref"].(string)
	s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, nil)
	pages := func() string {
		return strings.ToLower(s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil))
	}
	if out := pages(); strings.Contains(out, "leak") || !strings.Contains(out, "real") {
		t.Fatalf("after a sync the pages are (the linked file must not be one, the real one must):\n%s", out)
	}
	// A page made here whose name a link already has gets a file of its
	// own beside it, is written once, and is still there after the next sync.
	var docs struct{ Docs []struct{ ID, Title string } }
	s.call(s.owner, "", "GET", w+"/docs", nil, 200, &docs)
	root := ""
	for _, d := range docs.Docs {
		if d.Title == "Handbook" {
			root = d.ID
		}
	}
	s.change(s.owner, "", "doc.create", M{"title": "leak", "parent": root, "markdown": "Written in the app.\n"})
	var first struct {
		FilesWritten int `json:"files_written"`
	}
	s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, &first)
	var second struct {
		PagesTrashed int `json:"pages_trashed"`
	}
	s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 200, &second)
	if first.FilesWritten != 1 || second.PagesTrashed != 0 || !strings.Contains(pages(), "leak") {
		t.Fatalf("a page named like a link: wrote %d files, then trashed %d pages; pages:\n%s", first.FilesWritten, second.PagesTrashed, pages())
	}
	if raw, _ := os.ReadFile(filepath.Join(outside, "secret.md")); string(raw) != "the server's own secret" {
		t.Fatalf("the file outside was changed: %q", raw)
	}
	// A folder reached through a link is refused when syncing.
	s.change(s.owner, "", "source.update", M{"id": src, "subdir": "link/sub"})
	if out := s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, 409, nil); !strings.Contains(out, "leads out of its repository") {
		t.Fatalf("a folder through a link: %s", out)
	}
	if out := pages(); strings.Contains(out, "deep") {
		t.Fatalf("a folder outside the repository was read through a link:\n%s", out)
	}
	if raw, _ := os.ReadFile(filepath.Join(outside, "secret.md")); string(raw) != "the server's own secret" {
		t.Fatalf("the file outside was changed: %q", raw)
	}
}

// TestSyncAwkwardRepositories: an empty file still owns its name, and a
// plain file standing where a page's folder would be holds back only that
// page: the sync goes on, says so, and loses nobody's edit.
func TestSyncAwkwardRepositories(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	s := newSite(t, testdb.SQLite(t))
	work := t.TempDir()
	bare := filepath.Join(t.TempDir(), "origin.git")
	git := func(dir string, args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	git(work, "init", "-q", "-b", "main")
	os.MkdirAll(filepath.Join(work, "docs", "inl"), 0o755)
	os.WriteFile(filepath.Join(work, "docs", "empty.md"), nil, 0o644)
	os.WriteFile(filepath.Join(work, "docs", "inl", "b.md"), []byte("b\n"), 0o644)
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "docs")
	git(work, "init", "-q", "--bare", "-b", "main", bare)
	git(work, "remote", "add", "origin", bare)
	git(work, "push", "-q", "origin", "main")

	src := s.change(s.owner, "", "source.create", M{"title": "Handbook", "repo": bare, "subdir": "docs"})["ref"].(string)
	sync := func(want int) string { return s.call(s.owner, "", "POST", w+"/sources/"+src+"/sync", nil, want, nil) }
	sync(200)
	page := func(title string) string {
		var docs struct{ Docs []struct{ ID, Title string } }
		s.call(s.owner, "", "GET", w+"/docs", nil, 200, &docs)
		for _, d := range docs.Docs {
			if d.Title == title {
				return d.ID
			}
		}
		t.Fatalf("no page %q", title)
		return ""
	}
	root, folder := page("Handbook"), page("inl")

	// A second page called "empty" gets a file of its own.
	s.change(s.owner, "", "doc.create", M{"title": "empty", "parent": root, "markdown": "Not so empty.\n"})
	if out := sync(200); !strings.Contains(out, "was written as empty-2.md") {
		t.Fatalf("a page given another file name is not said: %s", out)
	}
	if got := git(bare, "show", "main:docs/empty.md"); got != "" {
		t.Fatalf("the empty file was written over: %q", got)
	}
	if got := git(bare, "show", "main:docs/empty-2.md"); !strings.Contains(got, "Not so empty") {
		t.Fatalf("the second page's own file: %q", got)
	}

	// The folder becomes a plain file there. A page under it cannot be
	// written; everything else still is, and a later edit is kept.
	git(work, "pull", "-q", "origin", "main")
	git(work, "rm", "-rq", "docs/inl")
	os.WriteFile(filepath.Join(work, "docs", "inl"), []byte("now a file\n"), 0o644)
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "a file where a folder was")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	s.change(s.owner, "", "doc.create", M{"title": "under", "parent": folder, "markdown": "Cannot land.\n"})
	za := s.change(s.owner, "", "doc.create", M{"title": "za", "parent": root, "markdown": "za v1\n"})["ref"].(string)
	if out := sync(200); !strings.Contains(out, "stands in the way") || strings.Contains(out, s.dir) {
		t.Fatalf("a file where a folder would be: %s", out)
	}
	if got := git(bare, "show", "main:docs/za.md"); !strings.Contains(got, "za v1") {
		t.Fatalf("the page beside it was not written: %q", got)
	}
	s.change(s.owner, "", "doc.write", M{"doc": za, "markdown": "za v2 edited\n"})
	sync(200)
	sync(200)
	if got := git(bare, "show", "main:docs/za.md"); !strings.Contains(got, "za v2 edited") {
		t.Fatalf("an edit after the trouble was lost: %q", got)
	}
	if got := git(bare, "show", "main:docs/inl"); got != "now a file\n" {
		t.Fatalf("the file in the way was changed: %q", got)
	}

	// A folder with the very name a page's file would have: the page gets
	// another name and the sync goes on.
	git(work, "pull", "-q", "origin", "main")
	os.MkdirAll(filepath.Join(work, "docs", "yy.md"), 0o755)
	os.WriteFile(filepath.Join(work, "docs", "yy.md", "keep.txt"), []byte("k\n"), 0o644)
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "a folder named like a file")
	git(work, "push", "-q", "origin", "main")
	s.change(s.owner, "", "doc.create", M{"title": "yy", "parent": root, "markdown": "yy text\n"})
	s.change(s.owner, "", "doc.write", M{"doc": za, "markdown": "za v3\n"})
	sync(200)
	if got := git(bare, "show", "main:docs/za.md"); !strings.Contains(got, "za v3") {
		t.Fatalf("a folder named like a page's file stopped the sync: %q", got)
	}
	if got := git(bare, "show", "main:docs/yy-2.md"); !strings.Contains(got, "yy text") {
		t.Fatalf("the page beside the folder: %q", got)
	}

	// A page trashed because its file was deleted there, then brought
	// back here, is written again and stays.
	git(work, "pull", "-q", "origin", "main")
	git(work, "rm", "-q", "docs/za.md")
	git(work, "commit", "-q", "-m", "za deleted there")
	git(work, "push", "-q", "origin", "main")
	if out := sync(200); !strings.Contains(out, `"pages_trashed":1`) {
		t.Fatalf("a file deleted in the repository: %s", out)
	}
	s.change(s.owner, "", "doc.restore", M{"id": za})
	sync(200)
	if out := sync(200); strings.Contains(out, `"pages_trashed":1`) {
		t.Fatalf("a restored page was trashed again: %s", out)
	}
	if got := git(bare, "show", "main:docs/za.md"); !strings.Contains(got, "za v3") {
		t.Fatalf("a restored page was not written back: %q", got)
	}

	// A file deleted there and then put back there (a reverted commit) is
	// a file again here: it gets its page, and is not deleted once more.
	git(work, "pull", "-q", "origin", "main")
	os.WriteFile(filepath.Join(work, "docs", "plain.md"), []byte("plain text\n"), 0o644)
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "plain")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	git(work, "pull", "-q", "origin", "main")
	git(work, "rm", "-q", "docs/plain.md")
	git(work, "commit", "-q", "-m", "plain deleted")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	git(work, "pull", "-q", "origin", "main")
	git(work, "revert", "--no-edit", "HEAD")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	sync(200)
	if got := git(bare, "show", "main:docs/plain.md"); got != "plain text\n" {
		t.Fatalf("a file put back in the repository: %q", got)
	}
	// The page that went to the trash when the file was deleted, brought
	// back now: it says what plain.md says, so no second file is made of
	// it, and the answer says why. Once it says something else, it is written.
	var trashed struct{ Docs []struct{ ID, Title string } }
	s.call(s.owner, "", "GET", w+"/docs?trash=1", nil, 200, &trashed)
	old := ""
	for _, d := range trashed.Docs {
		if d.Title == "plain" {
			old = d.ID
		}
	}
	if old != "" {
		s.change(s.owner, "", "doc.restore", M{"id": old})
		if out := sync(200); !strings.Contains(out, "already says the same") || strings.Contains(git(bare, "ls-tree", "-r", "--name-only", "main"), "plain-2.md") {
			t.Fatalf("a restored page saying what its file says: %s\n%s", out, git(bare, "ls-tree", "-r", "--name-only", "main"))
		}
		// Said again on a sync that has nothing at all to write.
		if out := sync(200); !strings.Contains(out, "already says the same") || !strings.Contains(out, `"files_written":0`) {
			t.Fatalf("a sync with nothing to write lost the note: %s", out)
		}
		s.change(s.owner, "", "doc.write", M{"doc": old, "markdown": "plain, but different now\n"})
		if out := sync(200); !strings.Contains(out, "was written as plain-2.md") {
			t.Fatalf("a restored page that now differs: %s", out)
		}
	} else {
		t.Fatal("the page trashed with its file is not in the trash")
	}
	// Two pages saying the same, one of them unwritten: throwing away the
	// one that has the file hands the file to the other. The repository
	// never sees the file go and come back.
	twin := func(title, id string) string {
		var docs struct{ Docs []struct{ ID, Title string } }
		s.call(s.owner, "", "GET", w+"/docs", nil, 200, &docs)
		for _, d := range docs.Docs {
			if d.Title == title && d.ID != id {
				return d.ID
			}
		}
		t.Fatalf("no other page %q", title)
		return ""
	}
	git(work, "pull", "-q", "origin", "main")
	os.WriteFile(filepath.Join(work, "docs", "solo.md"), []byte("solo text\n"), 0o644)
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "solo")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	first := page("solo")
	git(work, "rm", "-q", "docs/solo.md")
	git(work, "commit", "-q", "-m", "solo deleted")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	git(work, "revert", "--no-edit", "HEAD")
	git(work, "push", "-q", "origin", "main")
	sync(200)
	s.change(s.owner, "", "doc.restore", M{"id": first})
	sync(200)
	s.change(s.owner, "", "doc.delete", M{"id": twin("solo", first)})
	out1 := sync(200)
	sync(200)
	if n := strings.Count(strings.TrimSpace(git(bare, "log", "--oneline", "main", "--", "docs/solo.md")), "\n") + 1; n != 3 {
		t.Fatalf("the file was removed and written again: %d commits touch it (want the 3 made in the repository); first sync said %s\n%s", n, out1, git(bare, "log", "--oneline", "main", "--", "docs/solo.md"))
	}
	if got := git(bare, "show", "main:docs/solo.md"); got != "solo text\n" {
		t.Fatalf("the file after its page changed hands: %q", got)
	}
	s.change(s.owner, "", "doc.write", M{"doc": first, "markdown": "solo, edited by its new owner\n"})
	sync(200)
	if got := git(bare, "show", "main:docs/solo.md"); !strings.Contains(got, "edited by its new owner") {
		t.Fatalf("the page that took the file over does not write to it: %q", got)
	}
	var live struct{ Docs []struct{ Title string } }
	s.call(s.owner, "", "GET", w+"/docs", nil, 200, &live)
	found := false
	for _, d := range live.Docs {
		found = found || d.Title == "plain"
	}
	if !found {
		t.Fatal("the file that came back has no page")
	}
}
