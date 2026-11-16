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
