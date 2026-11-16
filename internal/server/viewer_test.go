package server_test

import (
	"archive/zip"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// oneProjectOnly makes two projects, SVA and OPS, each with a task, and
// returns the token of an agent that may read SVA alone.
func oneProjectOnly(t *testing.T, s *site) (narrow string) {
	t.Helper()
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
	s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	s.change(s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
	s.change(s.owner, "", "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}})
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@narrow"}, 201, &tok)
	return tok.Token
}

// limitedToSVA makes the workspace of oneProjectOnly and returns the two
// kinds of caller that may read SVA alone, by name: a member whose
// membership is limited to it, and an admin's token made for it.
func limitedToSVA(t *testing.T, s *site) map[string]string {
	t.Helper()
	member := oneProjectOnly(t, s)
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"name": "SVA only", "projects": []string{"SVA"}}, 201, &tok)
	return map[string]string{"a member limited to SVA": member, "an admin's token limited to SVA": tok.Token}
}

// TestContextPackLeavesOutPagesOfOtherProjects: a task's context pack
// names the pages that mention it, and a page of a project the caller may
// not read is not one of them, as it is not in the page tree.
func TestContextPackLeavesOutPagesOfOtherProjects(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		s.change(s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "As in SVA-1."})
		for _, form := range []string{"", "?format=text"} {
			if out := s.call(s.owner, "", "GET", w+"/tasks/SVA-1/context"+form, nil, 200, nil); !strings.Contains(out, "Vault runbook") {
				t.Fatalf("the pack does not name the page to someone who may read it: %s", out)
			}
			if out := s.call(nil, narrow, "GET", w+"/tasks/SVA-1/context"+form, nil, 200, nil); strings.Contains(out, "Vault runbook") {
				t.Fatalf("the pack names a page of a project the caller may not read: %s", out)
			}
		}
	})
}

// TestAViewOfAnotherProjectIsNotThere: a shared view of a project the
// caller may not read is not theirs to open, by slug, by id or by name, and
// is not among the views a wrong name is answered with.
func TestAViewOfAnotherProjectIsNotThere(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		ops := s.change(s.owner, "", "view.create", M{"name": "Ops work", "project": "OPS", "query": M{"open": true}})["ref"].(string)
		s.change(s.owner, "", "view.create", M{"name": "Art work", "project": "SVA", "query": M{"open": true}})
		s.call(s.owner, "", "GET", w+"/tasks?view=ops-work", nil, 200, nil)
		s.call(nil, narrow, "GET", w+"/tasks?view=art-work", nil, 200, nil)
		for _, ref := range []string{"ops-work", ops, "Ops+work"} {
			if out := s.call(nil, narrow, "GET", w+"/tasks?view="+ref, nil, 404, nil); strings.Contains(out, "ops-work") && ref != "ops-work" || strings.Contains(out, "OPS") {
				t.Fatalf("view=%s tells of a view the caller may not see: %s", ref, out)
			}
		}
		if out := s.call(nil, narrow, "GET", w+"/tasks?view=nope", nil, 404, nil); strings.Contains(out, "ops-work") || !strings.Contains(out, "art-work") {
			t.Fatalf("the views a wrong name is answered with: %s", out)
		}
	})
}

// TestARelationRowDoesNotNameATaskTheCallerMayNotRead: a relation is seen
// by whoever may read the task at either end of it, and the end they may
// not read is blank: its id is not in the rows of /list/relations, the
// starting copy or a task, nor in the feed, which leaves out its key too.
// A relation between two tasks the caller may not read is not theirs.
func TestARelationRowDoesNotNameATaskTheCallerMayNotRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		task := func(project, title string) string {
			return s.change(s.owner, "", "task.create", M{"project": project, "title": title})["ref"].(string)
		}
		relate := func(task, typ, other string) string {
			return s.change(s.owner, "", "relation.add", M{"task": task, "type": typ, "other": other})["ref"].(string)
		}
		var sva1, ops1 struct{ Task struct{ ID string } }
		s.call(s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &sva1)
		s.call(s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &ops1)
		task("SVA", "Boss music")
		ops2 := task("OPS", "Back up nightly")
		inside := relate("SVA-1", "blocks", "SVA-2")
		across := []string{relate("SVA-1", "duplicates", "OPS-1"), relate("OPS-1", "blocks", "SVA-1"), relate("SVA-1", "relates", "OPS-1")}
		outside := relate("OPS-1", "blocks", "OPS-2")
		removed := relate("OPS-2", "relates", "SVA-1")
		s.change(s.owner, "", "relation.remove", M{"id": removed})
		s.change(s.owner, "", "label.create", M{"name": "last"})

		type relation struct {
			ID      string `json:"id"`
			Task    string `json:"task_id"`
			Related string `json:"related_task_id"`
		}
		lists := []string{"/list/relations", "/bootstrap", "/bootstrap?part=open", "/tasks/SVA-1?raw=1"}
		for _, path := range lists {
			var got struct{ Relations []relation }
			s.call(s.owner, "", "GET", w+path, nil, 200, &got)
			want := 5
			if strings.Contains(path, "SVA-1") {
				want = 4 // not the one between two tasks of OPS
			}
			if len(got.Relations) != want {
				t.Fatalf("%s gives the owner %d relations, want %d: %+v", path, len(got.Relations), want, got.Relations)
			}
			for _, r := range got.Relations {
				if r.Task == "" || r.Related == "" {
					t.Fatalf("%s gives the owner a relation with a blank end: %+v", path, r)
				}
			}
		}
		for who, token := range callers {
			for _, path := range lists {
				var got struct{ Relations json.RawMessage }
				s.call(nil, token, "GET", w+path, nil, 200, &got)
				if out := string(got.Relations); strings.Contains(out, ops1.Task.ID) || strings.Contains(out, ops2) || strings.Contains(out, outside) {
					t.Errorf("%s gives %s the id of a task of OPS, or a relation between two of them: %s", path, who, out)
				}
				var relations []relation
				if err := json.Unmarshal(got.Relations, &relations); err != nil {
					t.Fatal(err)
				}
				ends := map[string]string{}
				for _, r := range relations {
					ends[r.ID] = r.Task + "|" + r.Related
				}
				if len(ends) != 4 || !strings.Contains(ends[inside], sva1.Task.ID+"|") || strings.HasSuffix(ends[inside], "|") {
					t.Errorf("%s gives %s the relations %v, want four, the one inside SVA whole", path, who, ends)
				}
				for _, id := range across {
					if ends[id] != sva1.Task.ID+"|" && ends[id] != "|"+sva1.Task.ID {
						t.Errorf("%s gives %s the relation across projects as %q, want SVA-1 at one end and nothing at the other", path, who, ends[id])
					}
				}
			}
			feeds := []string{"/events?after=0&limit=2000", "/events?after=0&limit=2000&compact=1", "/events?after=0&limit=2000&format=text", "/tasks/SVA-1?since=0",
				"/list/relations?format=text", "/list/relations?task=SVA-1"}
			for _, path := range feeds {
				out := s.call(nil, token, "GET", w+path, nil, 200, nil)
				for what, hidden := range map[string]string{"id": ops1.Task.ID, "key": "OPS-", "other id": ops2} {
					if strings.Contains(out, hidden) {
						t.Errorf("%s gives %s the %s of a task of OPS: %s", path, who, what, out)
					}
				}
				if !strings.Contains(out, across[0]) && !strings.Contains(out, "relation.created SVA-1") {
					t.Errorf("%s does not tell %s of a relation of SVA-1 at all: %s", path, who, out)
				}
			}
			live := s.stream(t, token)
			for deadline := time.Now().Add(10 * time.Second); !strings.Contains(live.all(), `"type":"label.created"`); time.Sleep(10 * time.Millisecond) {
				if time.Now().After(deadline) {
					t.Fatalf("the live stream of %s did not reach the last event: %s", who, live.all())
				}
			}
			if out := live.all(); strings.Contains(out, ops1.Task.ID) || strings.Contains(out, ops2) || strings.Contains(out, "OPS-") || !strings.Contains(out, across[0]) {
				t.Errorf("the live stream gives %s the id or the key of a task of OPS, or no relation of SVA-1: %s", who, out)
			}
		}
		// Someone who may read both projects is still told both ends.
		if out := s.call(s.owner, "", "GET", w+"/events?after=0&limit=2000", nil, 200, nil); !strings.Contains(out, `"other_key":"OPS-1"`) || !strings.Contains(out, ops1.Task.ID) {
			t.Errorf("the feed does not tell the owner the other end of a relation: %s", out)
		}
	})
}

// TestATaskShowsARelatedTaskTheCallerMayNotReadAsOneTheyCannotSee: a task
// in full, and its context pack, list a relation to a task of a project the
// caller may not read by its kind alone, marked hidden, and in text as "a
// task you can't see": not the task's key, title, status or id.
func TestATaskShowsARelatedTaskTheCallerMayNotReadAsOneTheyCannotSee(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss music"})
		for _, r := range []M{{"task": "SVA-1", "type": "blocks", "other": "SVA-2"}, {"task": "SVA-1", "type": "duplicates", "other": "OPS-1"},
			{"task": "OPS-1", "type": "blocks", "other": "SVA-1"}, {"task": "SVA-1", "type": "relates", "other": "OPS-1"}} {
			s.change(s.owner, "", "relation.add", r)
		}
		var ops1 struct{ Task struct{ ID string } }
		s.call(s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &ops1)
		type related struct {
			ID, Type, Task, Title, Status string
			Hidden                        bool
		}
		hidden := func(r related) bool { return r == related{Type: r.Type, Hidden: true} }

		for _, path := range []string{"/tasks/SVA-1", "/tasks/SVA-1/context"} {
			if out := s.call(s.owner, "", "GET", w+path, nil, 200, nil); strings.Contains(out, "hidden") || strings.Count(out, `"task":"OPS-1","title":"Rotate keys"`) != 3 {
				t.Errorf("%s does not name the three related tasks of OPS to the owner: %s", path, out)
			}
			if out := s.call(s.owner, "", "GET", w+path+"?format=text", nil, 200, nil); strings.Contains(out, "can't see") || strings.Count(out, "OPS-1 [Todo] Rotate keys") != 3 {
				t.Errorf("%s as text does not name the three related tasks of OPS to the owner: %s", path, out)
			}
			for who, token := range callers {
				var detail, pack struct {
					Relations []related
					Task      struct{ Relations []related }
				}
				out := s.call(nil, token, "GET", w+path, nil, 200, &detail)
				if strings.Contains(path, "context") {
					s.call(nil, token, "GET", w+path, nil, 200, &pack)
					detail.Relations = pack.Task.Relations
				}
				text := s.call(nil, token, "GET", w+path+"?format=text", nil, 200, nil)
				for _, answer := range []string{out, text} {
					for what, secret := range map[string]string{"key": "OPS-1", "title": "Rotate keys", "id": ops1.Task.ID} {
						if strings.Contains(answer, secret) {
							t.Errorf("%s gives %s the %s of a related task of OPS: %s", path, who, what, answer)
						}
					}
				}
				kinds := map[string]bool{}
				for _, r := range detail.Relations {
					if r.Task == "SVA-2" && r.Type == "blocks" && r.Title == "Boss music" && r.ID != "" && !r.Hidden {
						kinds["SVA-2"] = true
					} else if hidden(r) {
						kinds[r.Type] = true
					}
				}
				if len(detail.Relations) != 4 || !kinds["SVA-2"] || !kinds["duplicates"] || !kinds["blocked_by"] || !kinds["relates"] {
					t.Errorf("%s gives %s the relations %+v, want SVA-2 whole and three marked hidden with their kind alone", path, who, detail.Relations)
				}
				for _, line := range []string{"blocks SVA-2 [Todo] Boss music\n", "duplicates a task you can't see\n", "blocked by a task you can't see\n", "relates to a task you can't see\n"} {
					if !strings.Contains(text, line) {
						t.Errorf("%s as text does not tell %s %q: %s", path, who, line, text)
					}
				}
			}
		}
	})
}

// TestARelationColumnDoesNotShowRowsOfADatabaseTheCallerMayNotSee: a
// database's relation column may point at a database of another project.
// Someone who may not read that project sees that a row is linked (the
// cell holds the linked row's id, which is the row's own value) and
// nothing of the linked row: a formula does not get its title, a rollup
// not its values. They read as they do for a database that is gone.
func TestARelationColumnDoesNotShowRowsOfADatabaseTheCallerMayNotSee(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		do := func(typ string, args M) string { return s.change(s.owner, "", typ, args)["ref"].(string) }
		servers := do("doc.create", M{"title": "Servers", "kind": "database", "project": "OPS"})
		do("property.create", M{"database": servers, "name": "Rack", "type": "text"})
		cellar := do("doc.create", M{"parent": servers, "title": "cellar-one", "props": M{"Rack": "rack-zebra"}})
		sprites := do("doc.create", M{"title": "Sprites", "kind": "database", "project": "SVA"})
		do("property.create", M{"database": sprites, "name": "Server", "type": "relation", "config": M{"database": servers}})
		do("property.create", M{"database": sprites, "name": "Where", "type": "formula", "config": M{"formula": `prop("Server")`}})
		do("property.create", M{"database": sprites, "name": "Racks", "type": "rollup", "config": M{"relation": "Server", "target": "Rack", "fn": "values"}})
		do("property.create", M{"database": sprites, "name": "Named", "type": "rollup", "config": M{"relation": "Server", "fn": "values"}})
		do("doc.create", M{"parent": sprites, "title": "Boss idle", "props": M{"Server": []string{cellar}}})

		for _, form := range []string{"", "?format=text", "?raw=1"} {
			path := "/docs/" + sprites + "/rows" + form
			if out := s.call(s.owner, "", "GET", w+path, nil, 200, nil); strings.Count(out, "cellar-one") != 2 || !strings.Contains(out, "rack-zebra") {
				t.Fatalf("%s does not give the owner the linked row's title, by the formula and by the rollup, and its value: %s", path, out)
			}
			for who, token := range callers {
				out := s.call(nil, token, "GET", w+path, nil, 200, nil)
				if strings.Contains(out, "cellar-one") || strings.Contains(out, "rack-zebra") {
					t.Errorf("%s gives %s the title or a value of a row of a database of OPS: %s", path, who, out)
				}
				if !strings.Contains(out, "Boss idle") && form != "?raw=1" || !strings.Contains(out, cellar) {
					t.Errorf("%s does not give %s the row with its link: %s", path, who, out)
				}
			}
		}
	})
}

// TestAPageBuiltFromDataShowsEachReaderWhatTheyMayRead: a decision log, a
// changelog or the open questions of the whole workspace lists, to each
// reader, the decisions and tasks of the projects that reader may read.
// The page is built when it is read and never stored: someone else's
// reading leaves nothing for search or the feed to give, and moves nothing.
func TestAPageBuiltFromDataShowsEachReaderWhatTheyMayRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		do := func(typ string, args M) string { return s.change(s.owner, "", typ, args)["ref"].(string) }
		// Someone else asks, so that the owner may answer.
		do("agent.create", M{"name": "Asker", "handle": "asker"})
		var asker struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@asker"}, 201, &asker)
		ask := func(args M) string { return s.change(nil, asker.Token, "decision.open", args)["ref"].(string) }
		for _, key := range []string{"SVA-1", "OPS-1"} {
			picked := ask(M{"task": key, "question": "Which zebra for " + key + "?", "options": []M{{"label": "Plains"}, {"label": "Mountain"}}})
			do("decision.pick", M{"id": picked, "option": 1})
			ask(M{"task": key, "question": "Which quokka for " + key + "?", "options": []M{{"label": "Small"}, {"label": "Large"}}})
			do("task.create", M{"project": key[:3], "title": "Wombat work in " + key[:3]})
			do("task.update", M{"id": key[:3] + "-2", "status": "done"})
		}
		pages := map[string]string{ // what each page says of a project, but for the project's key
			do("doc.create", M{"title": "Decision log", "generated": "decision_log"}):     "Which zebra for ",
			do("doc.create", M{"title": "Open questions", "generated": "open_questions"}): "Which quokka for ",
			do("doc.create", M{"title": "Changelog", "generated": "changelog"}):           "Wombat work in ",
		}
		var before struct{ Seq int64 }
		s.call(s.owner, "", "GET", w+"/events?after=0&limit=1", nil, 200, &before)

		for page, says := range pages {
			for _, form := range []string{"", "?format=md", "?format=text"} {
				path := "/docs/" + page + form
				if out := s.call(s.owner, "", "GET", w+path, nil, 200, nil); !strings.Contains(out, says+"SVA") || !strings.Contains(out, says+"OPS") {
					t.Fatalf("%s does not show the owner both projects: %s", path, out)
				}
				for who, token := range callers {
					if out := s.call(nil, token, "GET", w+path, nil, 200, nil); !strings.Contains(out, says+"SVA") || strings.Contains(out, "OPS") {
						t.Errorf("%s shows %s something of OPS, or not what is of SVA: %s", path, who, out)
					}
				}
			}
		}
		// What the owner was shown is nowhere for the others to find: not by
		// search, not in the feed of the pages.
		paths := []string{"/search?q=zebra", "/search?q=quokka&kind=doc", "/search?q=wombat"}
		for page := range pages {
			paths = append(paths, "/events?after=0&doc="+page, "/docs/"+page+"/versions")
		}
		for who, token := range callers {
			for _, path := range paths {
				if out := s.call(nil, token, "GET", w+path, nil, 200, nil); strings.Contains(out, "for OPS-1") || strings.Contains(out, "work in OPS") {
					t.Errorf("%s gives %s what a page built from data said of OPS: %s", path, who, out)
				}
			}
		}
		var after struct{ Seq int64 }
		s.call(s.owner, "", "GET", w+"/events?after=0&limit=1", nil, 200, &after)
		if after.Seq != before.Seq {
			t.Errorf("reading the pages moved the feed from %d to %d: a read wrote", before.Seq, after.Seq)
		}
	})
}

// TestTheDashboardTellsOnlyAdminsOfTheWholeWorkspaceItsHealth: failing
// webhooks, lost deliveries, the last backup and failing page sources are
// for those who run the workspace. Anyone else's dashboard has no health
// part at all, in neither form: an empty one would read as all well.
func TestTheDashboardTellsOnlyAdminsOfTheWholeWorkspaceItsHealth(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		s.change(s.owner, "", "agent.create", M{"name": "Plain", "handle": "plain"})
		var plain struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@plain"}, 201, &plain)
		callers["a member who is no admin"] = plain.Token

		for _, path := range []string{"/dashboard", "/dashboard?project=SVA"} {
			var board map[string]json.RawMessage
			s.call(s.owner, "", "GET", w+path, nil, 200, &board)
			if text := s.call(s.owner, "", "GET", w+textForm(path), nil, 200, nil); !strings.Contains(string(board["health"]), "webhooks_failing") || !strings.Contains(text, "== health\n{") {
				t.Fatalf("%s does not tell the owner the health: %s\n%s", path, board["health"], text)
			}
			for who, token := range callers {
				board = nil
				s.call(nil, token, "GET", w+path, nil, 200, &board)
				text := s.call(nil, token, "GET", w+textForm(path), nil, 200, nil)
				if _, there := board["health"]; there || strings.Contains(text, "health") || strings.Contains(text, "webhooks_failing") {
					t.Errorf("%s tells %s the health: %s\n%s", path, who, board["health"], text)
				}
				if _, there := board["epics"]; !there || !strings.Contains(text, "== agents") {
					t.Errorf("%s does not give %s the rest of the dashboard: %s", path, who, text)
				}
			}
		}
	})
}

// textForm is a path with format=text added to its query.
func textForm(path string) string {
	if strings.Contains(path, "?") {
		return path + "&format=text"
	}
	return path + "?format=text"
}

// TestListedAttachmentsFollowTheirPage: /list/attachments gives a file on
// a page only to those who may see the page. One on someone's private
// page, or on a page of a project the caller may not read, is not listed.
func TestListedAttachmentsFollowTheirPage(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		attach := func(name string, to M) {
			var f struct{ ID string }
			s.call(s.owner, "", "POST", w+"/files?name="+name, []byte("x"), 201, &f)
			to["file"] = f.ID
			s.change(s.owner, "", "attachment.add", to)
		}
		page := func(args M) string { return s.change(s.owner, "", "doc.create", args)["ref"].(string) }
		attach("handbook.txt", M{"doc": page(M{"title": "Handbook"})})
		attach("design.txt", M{"doc": page(M{"title": "Design", "project": "SVA"})})
		attach("salaries.txt", M{"doc": page(M{"title": "Salaries", "private": true})})
		attach("runbook.txt", M{"doc": page(M{"title": "Runbook", "project": "OPS"})})
		attach("boss.txt", M{"task": "SVA-1"})
		attach("keys.txt", M{"task": "OPS-1"})

		all := s.call(s.owner, "", "GET", w+"/list/attachments", nil, 200, nil)
		for _, name := range []string{"handbook.txt", "design.txt", "salaries.txt", "runbook.txt", "boss.txt", "keys.txt"} {
			if !strings.Contains(all, name) {
				t.Fatalf("the owner's list leaves out %s: %s", name, all)
			}
		}
		out := s.call(nil, narrow, "GET", w+"/list/attachments", nil, 200, nil)
		for name, listed := range map[string]bool{"handbook.txt": true, "design.txt": true, "boss.txt": true, "salaries.txt": false, "runbook.txt": false, "keys.txt": false} {
			if strings.Contains(out, name) != listed {
				t.Errorf("%s listed for a caller limited to SVA: %v, want %v", name, !listed, listed)
			}
		}
	})
}

// TestAnExportIsNotForATokenLimitedToSomeProjects: an export holds the
// whole workspace, so an admin's token made for some projects is refused
// one; the admin's token for every project, and the admin signed in, get it.
func TestAnExportIsNotForATokenLimitedToSomeProjects(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		oneProjectOnly(t, s)
		var whole, part struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"name": "every project"}, 201, &whole)
		s.call(s.owner, "", "POST", w+"/tokens", M{"name": "SVA only", "projects": []string{"SVA"}}, 201, &part)
		s.call(s.owner, "", "GET", w+"/export", nil, 200, nil)
		s.call(nil, whole.Token, "GET", w+"/export", nil, 200, nil)
		if out := s.call(nil, part.Token, "GET", w+"/export", nil, 403, nil); strings.Contains(out, "Rotate keys") || !strings.Contains(out, "every project") {
			t.Fatalf("the refusal: %s", out)
		}
	})
}

// TestAPrivatePagesSubPagesAreNotSeenByOthers: a page made private after
// it had sub-pages takes them along. Another member, an admin even, does
// not get the sub-page or the one under it in the page list, cannot open
// them, does not find them or what is on them by search, in the starting
// copy, the list of files or an export, is not told of what happens to
// them afterwards, and does not see them among what mentions a page or a
// task, or among a page's sub-pages.
func TestAPrivatePagesSubPagesAreNotSeenByOthers(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(s.owner, "", "agent.create", M{"name": "Other", "handle": "other", "role": "admin"})
		var tok struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &tok)
		other := tok.Token
		page := func(args M) string { return s.change(s.owner, "", "doc.create", args)["ref"].(string) }
		handbook := page(M{"title": "Handbook"})
		plans := page(M{"title": "Plans"})
		q1 := page(M{"parent": plans, "title": "Quarter one", "markdown": "quokka\n"})
		week := page(M{"parent": q1, "title": "Week one", "markdown": "quokka, see SVA-1 and [[Handbook]]\n"})
		s.change(s.owner, "", "comment.create", M{"doc": week, "body": "wombat"})
		var f struct{ ID string }
		s.call(s.owner, "", "POST", w+"/files?name=week.txt", []byte("x"), 201, &f)
		s.change(s.owner, "", "attachment.add", M{"doc": week, "file": f.ID})

		s.change(s.owner, "", "doc.update", M{"id": plans, "private": true})
		var at struct{ Seq int64 }
		s.call(nil, other, "GET", w+"/events?after=0&limit=2000", nil, 200, &at)
		s.change(s.owner, "", "doc.write", M{"doc": week, "markdown": "quokka, rewritten; see SVA-1 and [[Handbook]]\n"})

		hidden := []string{plans, q1, week}
		leaks := func(what, answer string) {
			t.Helper()
			for _, id := range hidden {
				if i := strings.Index(answer, id); i >= 0 {
					t.Errorf("%s shows another member the private page %s: …%s…", what, id, answer[max(0, i-300):min(len(answer), i+100)])
				}
			}
		}
		leaks("the page list", s.call(nil, other, "GET", w+"/docs", nil, 200, nil))
		for _, id := range hidden {
			s.call(nil, other, "GET", w+"/docs/"+id, nil, 404, nil)
		}
		leaks("search", s.call(nil, other, "GET", w+"/search?q=quokka", nil, 200, nil))
		leaks("search of comments", s.call(nil, other, "GET", w+"/search?q=wombat", nil, 200, nil))
		leaks("the feed after the page went private", s.call(nil, other, "GET", w+"/events?after="+strconv.FormatInt(at.Seq, 10), nil, 200, nil))
		leaks("the starting copy", s.call(nil, other, "GET", w+"/bootstrap", nil, 200, nil))
		if out := s.call(nil, other, "GET", w+"/list/attachments", nil, 200, nil); strings.Contains(out, f.ID) {
			t.Errorf("the list of files shows the file on a private sub-page: %s", out)
		}
		leaks("what mentions a task", s.call(nil, other, "GET", w+"/tasks/SVA-1", nil, 200, nil))
		leaks("what mentions a page", s.call(nil, other, "GET", w+"/docs/"+handbook, nil, 200, nil))
		// An export's data/ is every row of the workspace, for the admin who
		// keeps it; its docs/ is the pages as the admin may read them.
		if pages := unzipped(t, s.call(nil, other, "GET", w+"/export", nil, 200, nil), "docs/"); strings.Contains(pages, "quokka") || !strings.Contains(pages, "docs/Handbook.md") {
			t.Errorf("an export's pages hold the private sub-pages, or not the page that is everyone's: %s", pages)
		}

		// A sub-page someone keeps private under a page others see is not
		// among that page's sub-pages for them.
		open := page(M{"title": "Open"})
		mine := page(M{"parent": open, "title": "Mine", "private": true})
		if out := s.call(nil, other, "GET", w+"/docs/"+open, nil, 200, nil); strings.Contains(out, mine) {
			t.Errorf("a page's sub-pages show another member a private one: %s", out)
		}

		// The owner still has all of it.
		for _, id := range hidden {
			s.call(s.owner, "", "GET", w+"/docs/"+id, nil, 200, nil)
		}
	})
}

// unzipped is the text of the files in a zip archive whose names start
// with prefix, one after another, each under its name.
func unzipped(t *testing.T, archive, prefix string) string {
	t.Helper()
	zr, err := zip.NewReader(strings.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	var all strings.Builder
	for _, f := range zr.File {
		if !strings.HasPrefix(f.Name, prefix) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		all.WriteString("=== " + f.Name + "\n" + string(body) + "\n")
	}
	return all.String()
}
