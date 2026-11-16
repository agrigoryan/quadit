package server_test

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/importer"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// siteSink writes an import through the test site's API as the owner.
type siteSink struct {
	s *site
	t *testing.T
}

// Change counts every change as made: it does not read the answer.
func (k siteSink) Change(changeID, typ string, args any) (bool, error) {
	k.t.Helper()
	k.s.call(k.s.owner, "", "POST", w+"/changes", M{"id": changeID, "type": typ, "args": args}, 200, nil)
	return true, nil
}

func (k siteSink) Get(path string, q url.Values) ([]byte, error) {
	return []byte(k.s.call(k.s.owner, "", "GET", w+path, nil, 200, nil)), nil
}

// Upload stores every file anew, under an id the server makes.
func (k siteSink) Upload(_, path string) (string, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false, err
	}
	var f struct{ URL string }
	k.s.call(k.s.owner, "", "POST", w+"/files?name="+url.QueryEscape(filepath.Base(path)), raw, 201, &f)
	return f.URL, true, nil
}

func (k siteSink) Logf(string, ...any) {}

func TestImports(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		sink := siteSink{s, t}
		dir := t.TempDir()
		write := func(name, body string) string {
			p := filepath.Join(dir, name)
			os.MkdirAll(filepath.Dir(p), 0o755)
			if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
			return p
		}
		run := func(kind, source, project string, opts map[string]string) importer.Summary {
			t.Helper()
			plan, err := importer.Read(kind, source, opts)
			if err != nil {
				t.Fatalf("read %s: %v", kind, err)
			}
			sum, err := importer.Apply(sink, plan, project)
			if err != nil {
				t.Fatalf("import %s: %v", kind, err)
			}
			return sum
		}
		tasks := func(q string) string {
			return s.call(s.owner, "", "GET", w+"/tasks?format=text&sort=key&limit=500&"+q, nil, 200, nil)
		}

		// Linear: a CSV with statuses, priorities, labels, a project and a sub-issue.
		linear := write("linear.csv", "\ufeffID,Team,Title,Description,Status,Estimate,Priority,Project,Assignee,Labels,Due Date,Parent issue,Completed,Canceled\n"+
			"ENG-1,Eng,Login page,\"Build the **login** page\",In Review,3,High,Onboarding,aram,\"bug, frontend\",2026-12-01,,,\n"+
			"ENG-2,Eng,Password field,,Done,1,No priority,Onboarding,someone.else@example.com,,,ENG-1,2026-11-01,\n")
		sum := run("linear", linear, "eng", nil)
		if sum.Tasks != 2 || len(sum.Unmatched) != 1 {
			t.Fatalf("linear: %+v", sum)
		}
		got := tasks("project=ENG")
		if !strings.Contains(got, "ENG-1  [In Review]  !high  @aram  Login page  #bug  #frontend  due 2026-12-01") ||
			!strings.Contains(got, "ENG-2  [Done]  Password field  in ENG-1") {
			t.Fatalf("linear tasks:\n%s", got)
		}
		var d struct {
			Task struct{ Epic, Description string }
		}
		s.call(s.owner, "", "GET", w+"/tasks/ENG-2", nil, 200, &d)
		if d.Task.Epic != "Onboarding" || !strings.Contains(d.Task.Description, "Assigned there to someone.else@example.com") {
			t.Fatalf("linear task detail: %+v", d.Task)
		}
		// Running the same import again adds nothing.
		run("linear", linear, "eng", nil)
		if n := strings.Count(tasks("project=ENG"), "ENG-"); n != 3 { // two tasks, and "in ENG-1"
			t.Fatalf("a second import run changed the count:\n%s", tasks("project=ENG"))
		}

		// Trello: lists become statuses, checklists and comments come along.
		trello := write("board.json", `{"lists":[{"id":"l1","name":"Doing"},{"id":"l2","name":"Shipped"}],
		"cards":[{"id":"c1","name":"Draw sprites","desc":"All of them","idList":"l1","labels":[{"name":"art"}],"idChecklists":["k1"],"shortUrl":"https://trello.example/c/1"},
		         {"id":"c2","name":"Old idea","idList":"l1","closed":true}],
		"checklists":[{"id":"k1","name":"Frames","checkItems":[{"name":"idle","state":"complete"},{"name":"attack","state":"incomplete"}]}],
		"actions":[{"type":"commentCard","date":"2026-10-02T10:00:00Z","memberCreator":{"fullName":"Bea"},"data":{"text":"Looks good","card":{"id":"c1"}}}]}`)
		if sum = run("trello", trello, "ART", nil); sum.Tasks != 2 || sum.Comments != 1 {
			t.Fatalf("trello: %+v", sum)
		}
		card := s.call(s.owner, "", "GET", w+"/tasks/ART-1?format=text", nil, 200, nil)
		for _, want := range []string{"status: Doing", "labels: art", "- [x] idle", "- [ ] attack", "**Bea**, 2026-10-02", "Looks good", "Imported from https://trello.example/c/1"} {
			if !strings.Contains(card, want) {
				t.Errorf("trello card misses %q:\n%s", want, card)
			}
		}
		if !strings.Contains(tasks("project=ART"), "ART-2  [Canceled]  Old idea") {
			t.Fatalf("an archived card should be canceled:\n%s", tasks("project=ART"))
		}

		// Asana.
		asana := write("asana.csv", "Task ID,Created At,Completed At,Name,Section/Column,Assignee Email,Due Date,Tags,Notes,Projects,Parent task ID\n"+
			"900,2026-01-01,2026-02-01,Ship it,Launch,,2026-02-01,release,Go,Website,\n")
		if sum = run("asana", asana, "WEB", nil); sum.Tasks != 1 || !strings.Contains(tasks("project=WEB"), "WEB-1  [Done]  Ship it  #release") {
			t.Fatalf("asana: %+v\n%s", sum, tasks("project=WEB"))
		}

		// GitHub issues, from a stand-in API; pull requests are left out.
		gh := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/comments") {
				json.NewEncoder(rw).Encode([]M{{"body": "me too", "created_at": "2026-03-03T00:00:00Z", "user": M{"login": "octo"}}})
				return
			}
			json.NewEncoder(rw).Encode([]M{
				{"number": 1, "title": "Crash on start", "body": "It crashes", "state": "closed", "state_reason": "completed", "html_url": "https://gh.example/1", "comments": 1, "labels": []M{{"name": "bug"}}, "user": M{"login": "octo"}},
				{"number": 2, "title": "A pull request", "state": "open", "pull_request": M{}, "user": M{"login": "octo"}},
			})
		}))
		t.Cleanup(gh.Close)
		if sum = run("github", "acme/game", "GAME", map[string]string{"api": gh.URL}); sum.Tasks != 1 || sum.Comments != 1 {
			t.Fatalf("github: %+v", sum)
		}

		// An Obsidian vault: folders become pages, [[links]] become page links,
		// an image beside a note is uploaded.
		write("vault/Home.md", "Welcome. See [[Design]] and [[Ideas/Bosses|the bosses]].\n\n![[map.png]]\n")
		write("vault/Design.md", "# Design\n\nNotes.\n")
		write("vault/Ideas/Bosses.md", "Three of them.\n")
		write("vault/map.png", "\x89PNG\r\n\x1a\nnot really a picture")
		if sum = run("obsidian", filepath.Join(dir, "vault"), "", nil); sum.Docs != 4 || sum.Files != 1 {
			t.Fatalf("obsidian: %+v", sum)
		}
		tree := s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil)
		if !strings.Contains(tree, "Ideas  (") || !strings.Contains(tree, "  Bosses  (") {
			t.Fatalf("vault tree:\n%s", tree)
		}
		var home string
		for _, line := range strings.Split(tree, "\n") {
			if strings.HasPrefix(line, "Home  (") {
				home = line[strings.Index(line, "(")+1 : len(line)-1]
			}
		}
		page := s.call(s.owner, "", "GET", w+"/docs/"+home+"?format=md", nil, 200, nil)
		if !strings.Contains(page, "[Design](doc:") || !strings.Contains(page, "[the bosses](doc:") || !strings.Contains(page, "/f/") {
			t.Fatalf("vault home page:\n%s", page)
		}

		// A Notion export: a zip of pages named with ids, and a CSV database.
		zpath := filepath.Join(dir, "notion.zip")
		zf, _ := os.Create(zpath)
		zw := zip.NewWriter(zf)
		for name, body := range map[string]string{
			"Wiki 0123456789abcdef0123456789abcdef.md":                                          "# Wiki\n\nThe team wiki.\n",
			"Wiki 0123456789abcdef0123456789abcdef/Roadmap fedcba9876543210fedcba9876543210.md": "# Roadmap\n\nQ1 and Q2.\n",
			"Wiki 0123456789abcdef0123456789abcdef/Bugs aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv":   "Name,Severity,Owner\nCrash,High,Bea\nTypo,Low,\n",
		} {
			fw, _ := zw.Create(name)
			fmt.Fprint(fw, body)
		}
		zw.Close()
		zf.Close()
		if sum = run("notion", zpath, "", nil); sum.Docs != 3 || sum.Rows != 2 {
			t.Fatalf("notion: %+v", sum)
		}
		tree = s.call(s.owner, "", "GET", w+"/docs?format=text", nil, 200, nil)
		if !strings.Contains(tree, "Wiki  (") || !strings.Contains(tree, "  Roadmap  (") || !strings.Contains(tree, "  Bugs [database]  (") || strings.Contains(tree, "0123456789abcdef") {
			t.Fatalf("notion tree:\n%s", tree)
		}
		var bugs string
		for _, line := range strings.Split(tree, "\n") {
			if strings.Contains(line, "Bugs [database]") {
				bugs = line[strings.Index(line, "(")+1 : len(line)-1]
			}
		}
		rows := s.call(s.owner, "", "GET", w+"/docs/"+bugs+"/rows?format=text", nil, 200, nil)
		if !strings.Contains(rows, "| Crash | High | Bea |") {
			t.Fatalf("notion database:\n%s", rows)
		}

		// Orbit, from a stand-in for its public API.
		orbit := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer orbit-token" {
				rw.WriteHeader(http.StatusUnauthorized)
				return
			}
			p := strings.TrimPrefix(r.URL.Path, "/api/public/v1/workspaces/ws1")
			switch {
			case p == "/projects":
				json.NewEncoder(rw).Encode(M{"items": []M{{"id": "p1", "name": "Samurai vs Alien", "key": "SVA"}}})
			case p == "/projects/p1/statuses":
				json.NewEncoder(rw).Encode(M{"items": []M{{"id": "s1", "name": "In Review", "category": "started"}, {"id": "s2", "name": "Done", "category": "completed"}}})
			case p == "/projects/p1/labels":
				json.NewEncoder(rw).Encode(M{"items": []M{{"id": "lb1", "name": "art"}}})
			case p == "/tasks":
				json.NewEncoder(rw).Encode(M{"items": []M{
					{"id": "t2", "identifier": "SVA-2", "number": 2, "project_id": "p1", "status_id": "s2", "title": "Second", "priority": "none", "parent_task_id": "t9"},
					{"id": "t9", "identifier": "SVA-9", "number": 9, "project_id": "p1", "status_id": "s1", "title": "First", "description": "From Orbit", "priority": "urgent", "label_ids": []string{"lb1"}, "url": "https://orbit.example/tasks/t1", "milestone_id": "m1"},
				}, "next_cursor": nil})
			case p == "/projects/p1/milestones":
				json.NewEncoder(rw).Encode(M{"items": []M{{"id": "m1", "name": "Vertical slice"}}})
			case p == "/tasks/SVA-9/relations":
				json.NewEncoder(rw).Encode(M{"items": []M{{"type": "blocks", "direction": "outgoing", "task": M{"id": "t2"}}}})
			case p == "/tasks/SVA-2/relations":
				json.NewEncoder(rw).Encode(M{"items": []M{{"type": "blocks", "direction": "incoming", "task": M{"id": "t9"}}}})
			case p == "/tasks/SVA-9/comments":
				json.NewEncoder(rw).Encode(M{"items": []M{{"body": "Owner comment", "author_id": "u1", "created_at": "2026-11-01T00:00:00Z"}}})
			case p == "/docs":
				json.NewEncoder(rw).Encode(M{"items": []M{{"id": "d1", "title": "Game design"}}})
			case p == "/docs/d1":
				json.NewEncoder(rw).Encode(M{"markdown": "Design notes from Orbit.\n"})
			default:
				json.NewEncoder(rw).Encode(M{"items": []M{}})
			}
		}))
		t.Cleanup(orbit.Close)
		if sum = run("orbit", orbit.URL, "", map[string]string{"workspace": "ws1", "token": "orbit-token"}); sum.Tasks != 2 || sum.Comments != 1 || sum.Docs != 1 {
			t.Fatalf("orbit: %+v", sum)
		}
		got = tasks("project=SVA")
		if !strings.Contains(got, "SVA-9  [In Review]  !urgent  First  #art") || !strings.Contains(got, "SVA-2  [Done]  Second  in SVA-9") {
			t.Fatalf("orbit tasks (each keeps the number it had there):\n%s", got)
		}
		// Its milestone came along as an epic, and what it blocks as a relation.
		if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-9?format=text", nil, 200, nil); !strings.Contains(out, "Vertical slice") || !strings.Contains(out, "blocks SVA-2") {
			t.Fatalf("an Orbit task's epic and relations:\n%s", out)
		}
	})
}
