package server_test

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// oneProjectOnly makes two projects, SVA and OPS, each with a task, and
// returns the token of an agent that may read SVA alone.
func oneProjectOnly(t *testing.T, s *site) (narrow string) {
	t.Helper()
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
	s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
	s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys"})
	s.change(t, s.owner, "", "agent.create", M{"name": "Narrow", "handle": "narrow", "scope": M{"projects": []string{"SVA"}}})
	var tok struct{ Token string }
	s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@narrow"}, 201, &tok)
	return tok.Token
}

// limitedToSVA makes the workspace of oneProjectOnly and returns the two
// kinds of caller that may read SVA alone, by name: a member whose
// membership is limited to it, and an admin's token made for it.
func limitedToSVA(t *testing.T, s *site) map[string]string {
	t.Helper()
	member := oneProjectOnly(t, s)
	var tok struct{ Token string }
	s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "SVA only", "projects": []string{"SVA"}}, 201, &tok)
	return map[string]string{"a member limited to SVA": member, "an admin's token limited to SVA": tok.Token}
}

// TestContextPackLeavesOutPagesOfOtherProjects: a task's context pack
// names the pages that mention it, and a page of a project the caller may
// not read is not one of them, as it is not in the page tree.
func TestContextPackLeavesOutPagesOfOtherProjects(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		s.change(t, s.owner, "", "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "As in SVA-1."})
		for _, form := range []string{"", "?format=text"} {
			if out := s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1/context"+form, nil, 200, nil); !strings.Contains(out, "Vault runbook") {
				t.Fatalf("the pack does not name the page to someone who may read it: %s", out)
			}
			if out := s.call(t, nil, narrow, "GET", w+"/tasks/SVA-1/context"+form, nil, 200, nil); strings.Contains(out, "Vault runbook") {
				t.Fatalf("the pack names a page of a project the caller may not read: %s", out)
			}
		}
	})
}

// TestAViewOfAnotherProjectIsNotThere: a shared view of a project the
// caller may not read is not theirs to open, by slug, by id or by name, and
// is not among the views a wrong name is answered with.
func TestAViewOfAnotherProjectIsNotThere(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		ops := s.change(t, s.owner, "", "view.create", M{"name": "Ops work", "project": "OPS", "query": M{"open": true}})["ref"].(string)
		s.change(t, s.owner, "", "view.create", M{"name": "Art work", "project": "SVA", "query": M{"open": true}})
		s.call(t, s.owner, "", "GET", w+"/tasks?view=ops-work", nil, 200, nil)
		s.call(t, nil, narrow, "GET", w+"/tasks?view=art-work", nil, 200, nil)
		for _, ref := range []string{"ops-work", ops, "Ops+work"} {
			if out := s.call(t, nil, narrow, "GET", w+"/tasks?view="+ref, nil, 404, nil); strings.Contains(out, "ops-work") && ref != "ops-work" || strings.Contains(out, "OPS") {
				t.Fatalf("view=%s tells of a view the caller may not see: %s", ref, out)
			}
		}
		if out := s.call(t, nil, narrow, "GET", w+"/tasks?view=nope", nil, 404, nil); strings.Contains(out, "ops-work") || !strings.Contains(out, "art-work") {
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		task := func(project, title string) string {
			return s.change(t, s.owner, "", "task.create", M{"project": project, "title": title})["ref"].(string)
		}
		relate := func(task, typ, other string) string {
			return s.change(t, s.owner, "", "relation.add", M{"task": task, "type": typ, "other": other})["ref"].(string)
		}
		var sva1, ops1 struct{ Task struct{ ID string } }
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &sva1)
		s.call(t, s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &ops1)
		task("SVA", "Boss music")
		ops2 := task("OPS", "Back up nightly")
		inside := relate("SVA-1", "blocks", "SVA-2")
		across := []string{relate("SVA-1", "duplicates", "OPS-1"), relate("OPS-1", "blocks", "SVA-1"), relate("SVA-1", "relates", "OPS-1")}
		outside := relate("OPS-1", "blocks", "OPS-2")
		removed := relate("OPS-2", "relates", "SVA-1")
		s.change(t, s.owner, "", "relation.remove", M{"id": removed})
		s.change(t, s.owner, "", "label.create", M{"name": "last"})

		type relation struct {
			ID      string `json:"id"`
			Task    string `json:"task_id"`
			Related string `json:"related_task_id"`
		}
		lists := []string{"/list/relations", "/bootstrap", "/bootstrap?part=open", "/tasks/SVA-1?raw=1"}
		for _, path := range lists {
			var got struct{ Relations []relation }
			s.call(t, s.owner, "", "GET", w+path, nil, 200, &got)
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
				s.call(t, nil, token, "GET", w+path, nil, 200, &got)
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
				out := s.call(t, nil, token, "GET", w+path, nil, 200, nil)
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
		if out := s.call(t, s.owner, "", "GET", w+"/events?after=0&limit=2000", nil, 200, nil); !strings.Contains(out, `"other_key":"OPS-1"`) || !strings.Contains(out, ops1.Task.ID) {
			t.Errorf("the feed does not tell the owner the other end of a relation: %s", out)
		}
	})
}

// TestAReaderOfOneEndIsToldOfTheRelationWithTheFarEndBlank: a relation
// made and taken away from a task the caller may not read reaches them as
// the event about the task they do read (task.related), with the
// relation's id and type, and nothing of the far end: not its id, not its
// key. Someone who may read both ends is told the far end.
func TestAReaderOfOneEndIsToldOfTheRelationWithTheFarEndBlank(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		var sva1, ops1 struct{ Task struct{ ID string } }
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &sva1)
		s.call(t, s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &ops1)
		rid := s.change(t, s.owner, "", "relation.add", M{"task": "OPS-1", "type": "blocks", "other": "SVA-1"})["ref"].(string)
		s.change(t, s.owner, "", "relation.remove", M{"id": rid})

		type related struct {
			ID       string  `json:"id"`
			Relation string  `json:"relation"`
			Type     string  `json:"type"`
			Removed  bool    `json:"removed"`
			OtherID  *string `json:"other_id"`
			OtherKey *string `json:"other_key"`
		}
		told := func(as *http.Client, token string) []related {
			t.Helper()
			var feed struct {
				Events []struct {
					Type string
					Data related
				}
			}
			s.call(t, as, token, "GET", w+"/events?after=0&limit=2000", nil, 200, &feed)
			var out []related
			for _, ev := range feed.Events {
				if ev.Type == "task.related" && ev.Data.Relation == rid {
					out = append(out, ev.Data)
				}
			}
			if len(out) != 2 || out[0].Removed || !out[1].Removed {
				t.Fatalf("the feed tells of the relation added and taken away as %+v, want two events, added then removed", out)
			}
			return out
		}
		for who, token := range callers {
			for _, ev := range told(nil, token) {
				if ev.ID != sva1.Task.ID || ev.Type != "blocks" || ev.OtherID != nil || ev.OtherKey != nil {
					t.Errorf("%s is told %+v, want the relation's id and type on SVA-1 and no far end", who, ev)
				}
			}
		}
		for _, ev := range told(s.owner, "") {
			if ev.OtherID == nil || *ev.OtherID != ops1.Task.ID || ev.OtherKey == nil || *ev.OtherKey != "OPS-1" {
				t.Errorf("the owner is told %+v, want the far end, OPS-1, by id and key", ev)
			}
		}
	})
}

// TestARestoreFromTheTrashCarriesTheRowsEachReaderMaySee: a task or a page
// brought back from the trash reaches a copy that never held it (the trash
// is not copied) as its whole row. A page comes back with the pages under
// it, each told of on its own, so a reader is given the rows they may see
// and nothing of a sub-page of another project or someone else's private
// one.
func TestARestoreFromTheTrashCarriesTheRowsEachReaderMaySee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "project": "SVA"})["ref"].(string)
		other := s.change(t, s.owner, "", "doc.create", M{"title": "Vault runbook", "parent": page, "project": "OPS"})["ref"].(string)
		mine := s.change(t, s.owner, "", "doc.create", M{"title": "My notes", "parent": page, "private": true})["ref"].(string)
		s.change(t, s.owner, "", "task.delete", M{"id": "SVA-1"})
		s.change(t, s.owner, "", "doc.delete", M{"id": page})
		var before struct{ Seq int64 }
		s.call(t, s.owner, "", "GET", w+"/events?after=0&limit=2000", nil, 200, &before)
		s.change(t, s.owner, "", "task.restore", M{"id": "SVA-1"})
		s.change(t, s.owner, "", "doc.restore", M{"id": page})

		type event struct {
			Type string
			Data struct {
				Row map[string]any
			}
		}
		restored := func(as *http.Client, token string) (task map[string]any, pages []string, raw string) {
			t.Helper()
			var feed struct{ Events []event }
			raw = s.call(t, as, token, "GET", w+"/events?after="+strconv.FormatInt(before.Seq, 10)+"&limit=2000", nil, 200, &feed)
			for _, ev := range feed.Events {
				switch ev.Type {
				case "task.updated":
					task = ev.Data.Row
				case "doc.restored":
					if ev.Data.Row != nil {
						pages = append(pages, ev.Data.Row["id"].(string))
					}
				}
			}
			slices.Sort(pages)
			return task, pages, raw
		}
		for who, token := range callers {
			task, pages, raw := restored(nil, token)
			if task == nil || task["key"] != "SVA-1" || task["title"] != "Boss design" {
				t.Errorf("%s is told of the restored task as %v, want its whole row", who, task)
			}
			// The admin's token is the owner's: the private page is theirs.
			want := []string{page}
			if strings.Contains(who, "token") {
				want = append(want, mine)
				slices.Sort(want)
			}
			if !slices.Equal(pages, want) || strings.Contains(raw, other) {
				t.Errorf("%s is told of the restored pages %v, want %v and nothing of the page of OPS: %s", who, pages, want, raw)
			}
			if !strings.Contains(who, "token") && strings.Contains(raw, mine) {
				t.Errorf("%s is told of someone's private page: %s", who, raw)
			}
		}
		_, pages, _ := restored(s.owner, "")
		want := []string{page, other, mine}
		slices.Sort(want)
		if !slices.Equal(pages, want) {
			t.Errorf("the owner is told of the restored pages %v, want all three", pages)
		}
	})
}

// TestTrashingAPageTellsEachReaderOfThePagesTheyMaySee: a page goes to the
// trash with the pages under it, each told of on its own, so neither the
// feed nor the live stream gives a reader the id of a sub-page of another
// project or of someone else's private one.
func TestTrashingAPageTellsEachReaderOfThePagesTheyMaySee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		page := s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "project": "SVA"})["ref"].(string)
		other := s.change(t, s.owner, "", "doc.create", M{"title": "Vault runbook", "parent": page, "project": "OPS"})["ref"].(string)
		mine := s.change(t, s.owner, "", "doc.create", M{"title": "My notes", "parent": page, "private": true})["ref"].(string)
		var before struct{ Seq int64 }
		s.call(t, s.owner, "", "GET", w+"/events?after=0&limit=2000", nil, 200, &before)
		streams := map[string]*stream{}
		for who, token := range callers {
			streams[who] = s.stream(t, token)
		}
		s.change(t, s.owner, "", "doc.delete", M{"id": page})
		// Something every caller is told of after, so a stream that has it
		// has had all the trashing.
		s.change(t, s.owner, "", "comment.create", M{"task": "SVA-1", "body": "after the trashing"})

		type event struct {
			Type     string
			EntityID string `json:"entity_id"`
			Data     struct{ IDs []string }
		}
		trashed := func(as *http.Client, token string) (pages []string, raw string) {
			t.Helper()
			var feed struct{ Events []event }
			raw = s.call(t, as, token, "GET", w+"/events?after="+strconv.FormatInt(before.Seq, 10)+"&limit=2000", nil, 200, &feed)
			for _, ev := range feed.Events {
				if ev.Type == "doc.deleted" {
					pages = append(pages, ev.EntityID)
					pages = append(pages, ev.Data.IDs...)
				}
			}
			slices.Sort(pages)
			return pages, raw
		}
		for who, token := range callers {
			pages, raw := trashed(nil, token)
			// The admin's token is the owner's: the private page is theirs.
			want := []string{page}
			if strings.Contains(who, "token") {
				want = append(want, mine)
				slices.Sort(want)
			}
			if !slices.Equal(pages, want) || strings.Contains(raw, other) {
				t.Errorf("%s is told of the trashed pages %v, want %v and nothing of the page of OPS: %s", who, pages, want, raw)
			}
			if !strings.Contains(who, "token") && strings.Contains(raw, mine) {
				t.Errorf("%s is told of someone's private page: %s", who, raw)
			}
			sm := streams[who]
			eventually(t, who+"'s stream to reach what came after", func() bool { return strings.Contains(sm.all(), "after the trashing") })
			live := sm.all()
			if !strings.Contains(live, page) || strings.Contains(live, other) {
				t.Errorf("%s's live stream does not tell of the trashed page alone, without the page of OPS: %s", who, live)
			}
			if !strings.Contains(who, "token") && strings.Contains(live, mine) {
				t.Errorf("%s's live stream tells of someone's private page: %s", who, live)
			}
		}
		pages, _ := trashed(s.owner, "")
		want := []string{page, other, mine}
		slices.Sort(want)
		if !slices.Equal(pages, want) {
			t.Errorf("the owner is told of the trashed pages %v, want all three", pages)
		}
	})
}

// TestATaskShowsARelatedTaskTheCallerMayNotReadAsOneTheyCannotSee: a task
// in full, and its context pack, list a relation to a task of a project the
// caller may not read by its kind alone, marked hidden, and in text as "a
// task you can't see": not the task's key, title, status or id.
func TestATaskShowsARelatedTaskTheCallerMayNotReadAsOneTheyCannotSee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss music"})
		for _, r := range []M{{"task": "SVA-1", "type": "blocks", "other": "SVA-2"}, {"task": "SVA-1", "type": "duplicates", "other": "OPS-1"},
			{"task": "OPS-1", "type": "blocks", "other": "SVA-1"}, {"task": "SVA-1", "type": "relates", "other": "OPS-1"}} {
			s.change(t, s.owner, "", "relation.add", r)
		}
		var ops1 struct{ Task struct{ ID string } }
		s.call(t, s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &ops1)
		type related struct {
			ID, Type, Task, Title, Status string
			Hidden                        bool
		}
		hidden := func(r related) bool { return r == related{Type: r.Type, Hidden: true} }

		for _, path := range []string{"/tasks/SVA-1", "/tasks/SVA-1/context"} {
			if out := s.call(t, s.owner, "", "GET", w+path, nil, 200, nil); strings.Contains(out, "hidden") || strings.Count(out, `"task":"OPS-1","title":"Rotate keys"`) != 3 {
				t.Errorf("%s does not name the three related tasks of OPS to the owner: %s", path, out)
			}
			if out := s.call(t, s.owner, "", "GET", w+path+"?format=text", nil, 200, nil); strings.Contains(out, "can't see") || strings.Count(out, "OPS-1 [Todo] Rotate keys") != 3 {
				t.Errorf("%s as text does not name the three related tasks of OPS to the owner: %s", path, out)
			}
			for who, token := range callers {
				var detail, pack struct {
					Relations []related
					Task      struct{ Relations []related }
				}
				out := s.call(t, nil, token, "GET", w+path, nil, 200, &detail)
				if strings.Contains(path, "context") {
					s.call(t, nil, token, "GET", w+path, nil, 200, &pack)
					detail.Relations = pack.Task.Relations
				}
				text := s.call(t, nil, token, "GET", w+path+"?format=text", nil, 200, nil)
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		do := func(typ string, args M) string { return s.change(t, s.owner, "", typ, args)["ref"].(string) }
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
			if out := s.call(t, s.owner, "", "GET", w+path, nil, 200, nil); strings.Count(out, "cellar-one") != 2 || !strings.Contains(out, "rack-zebra") {
				t.Fatalf("%s does not give the owner the linked row's title, by the formula and by the rollup, and its value: %s", path, out)
			}
			for who, token := range callers {
				out := s.call(t, nil, token, "GET", w+path, nil, 200, nil)
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		do := func(typ string, args M) string { return s.change(t, s.owner, "", typ, args)["ref"].(string) }
		// Someone else asks, so that the owner may answer.
		do("agent.create", M{"name": "Asker", "handle": "asker"})
		var asker struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@asker"}, 201, &asker)
		ask := func(args M) string { return s.change(t, nil, asker.Token, "decision.open", args)["ref"].(string) }
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
		// The feed's head: where it stands now, as /me reports it.
		var before struct{ Seq int64 }
		s.call(t, s.owner, "", "GET", w+"/me", nil, 200, &before)

		for page, says := range pages {
			for _, form := range []string{"", "?format=md", "?format=text"} {
				path := "/docs/" + page + form
				if out := s.call(t, s.owner, "", "GET", w+path, nil, 200, nil); !strings.Contains(out, says+"SVA") || !strings.Contains(out, says+"OPS") {
					t.Fatalf("%s does not show the owner both projects: %s", path, out)
				}
				for who, token := range callers {
					if out := s.call(t, nil, token, "GET", w+path, nil, 200, nil); !strings.Contains(out, says+"SVA") || strings.Contains(out, "OPS") {
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
				if out := s.call(t, nil, token, "GET", w+path, nil, 200, nil); strings.Contains(out, "for OPS-1") || strings.Contains(out, "work in OPS") {
					t.Errorf("%s gives %s what a page built from data said of OPS: %s", path, who, out)
				}
			}
		}
		var after struct{ Seq int64 }
		s.call(t, s.owner, "", "GET", w+"/me", nil, 200, &after)
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		s.change(t, s.owner, "", "agent.create", M{"name": "Plain", "handle": "plain"})
		var plain struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@plain"}, 201, &plain)
		callers["a member who is no admin"] = plain.Token

		for _, path := range []string{"/dashboard", "/dashboard?project=SVA"} {
			var board map[string]json.RawMessage
			s.call(t, s.owner, "", "GET", w+path, nil, 200, &board)
			if text := s.call(t, s.owner, "", "GET", w+textForm(path), nil, 200, nil); !strings.Contains(string(board["health"]), "webhooks_failing") || !strings.Contains(text, "== health\n{") {
				t.Fatalf("%s does not tell the owner the health: %s\n%s", path, board["health"], text)
			}
			for who, token := range callers {
				board = nil
				s.call(t, nil, token, "GET", w+path, nil, 200, &board)
				text := s.call(t, nil, token, "GET", w+textForm(path), nil, 200, nil)
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		narrow := oneProjectOnly(t, s)
		attach := func(name string, to M) {
			var f struct{ ID string }
			s.call(t, s.owner, "", "POST", w+"/files?name="+name, []byte("x"), 201, &f)
			to["file"] = f.ID
			s.change(t, s.owner, "", "attachment.add", to)
		}
		page := func(args M) string { return s.change(t, s.owner, "", "doc.create", args)["ref"].(string) }
		attach("handbook.txt", M{"doc": page(M{"title": "Handbook"})})
		attach("design.txt", M{"doc": page(M{"title": "Design", "project": "SVA"})})
		attach("salaries.txt", M{"doc": page(M{"title": "Salaries", "private": true})})
		attach("runbook.txt", M{"doc": page(M{"title": "Runbook", "project": "OPS"})})
		attach("boss.txt", M{"task": "SVA-1"})
		attach("keys.txt", M{"task": "OPS-1"})

		all := s.call(t, s.owner, "", "GET", w+"/list/attachments", nil, 200, nil)
		for _, name := range []string{"handbook.txt", "design.txt", "salaries.txt", "runbook.txt", "boss.txt", "keys.txt"} {
			if !strings.Contains(all, name) {
				t.Fatalf("the owner's list leaves out %s: %s", name, all)
			}
		}
		out := s.call(t, nil, narrow, "GET", w+"/list/attachments", nil, 200, nil)
		for name, listed := range map[string]bool{"handbook.txt": true, "design.txt": true, "boss.txt": true, "salaries.txt": false, "runbook.txt": false, "keys.txt": false} {
			if strings.Contains(out, name) != listed {
				t.Errorf("%s listed for a caller limited to SVA: %v, want %v", name, !listed, listed)
			}
		}
	})
}

// TestAFileOnACommentOnAPageFollowsThePage: a file attached to a comment
// on a page is seen by those who may see the page, like a file on the page
// itself: in /list/attachments, as a file and its bytes, and in the feed.
// Someone who may not read the page's project, or whose page it is not,
// gets none of it.
func TestAFileOnACommentOnAPageFollowsThePage(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		// Another admin writes the comments and uploads the files, so that
		// nobody asked below sees a file because it is their own.
		s.change(t, s.owner, "", "agent.create", M{"name": "Other", "handle": "other", "role": "admin"})
		var other struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &other)
		files := map[string]string{}
		commentWithFile := func(name string, page M) {
			doc := s.change(t, nil, other.Token, "doc.create", page)["ref"].(string)
			comment := s.change(t, nil, other.Token, "comment.create", M{"doc": doc, "body": "see the file"})["ref"].(string)
			var f struct{ ID string }
			s.call(t, nil, other.Token, "POST", w+"/files?name="+name, []byte("the bytes of "+name), 201, &f)
			s.change(t, nil, other.Token, "attachment.add", M{"comment": comment, "file": f.ID})
			files[name] = f.ID
		}
		commentWithFile("handbook.txt", M{"title": "Handbook"})
		commentWithFile("design.txt", M{"title": "Design", "project": "SVA"})
		commentWithFile("runbook.txt", M{"title": "Runbook", "project": "OPS"})
		commentWithFile("diary.txt", M{"title": "Diary", "private": true})

		sees := func(who string, hc *http.Client, token string, want map[string]bool) {
			t.Helper()
			listed := s.call(t, hc, token, "GET", w+"/list/attachments", nil, 200, nil)
			feed := s.call(t, hc, token, "GET", w+"/events?after=0&limit=2000", nil, 200, nil)
			for name, seen := range want {
				status := 404
				if seen {
					status = 200
				}
				if strings.Contains(listed, name) != seen {
					t.Errorf("/list/attachments lists %s for %s: %v, want %v", name, who, !seen, seen)
				}
				if strings.Contains(feed, name) != seen {
					t.Errorf("the feed tells %s of %s: %v, want %v", who, name, !seen, seen)
				}
				s.call(t, hc, token, "GET", w+"/files/"+files[name], nil, status, nil)
				if body := s.call(t, hc, token, "GET", "/f/"+files[name]+"/"+name, nil, status, nil); seen && body != "the bytes of "+name {
					t.Errorf("%s is served to %s as %q", name, who, body)
				}
			}
		}
		sees("the one who attached them", nil, other.Token, map[string]bool{"handbook.txt": true, "design.txt": true, "runbook.txt": true, "diary.txt": true})
		sees("an owner, of a page someone keeps private", s.owner, "", map[string]bool{"handbook.txt": true, "design.txt": true, "runbook.txt": true, "diary.txt": false})
		for who, token := range callers {
			sees(who, nil, token, map[string]bool{"handbook.txt": true, "design.txt": true, "runbook.txt": false, "diary.txt": false})
		}
	})
}

// TestAFileIsServedWithinBothTheMembersAndTheTokensProjects: a member
// limited to some projects may make a token for fewer of them. A file is
// served to that token when its task or page is of a project both the
// membership and the token allow; a token made for a project outside the
// membership is served none.
func TestAFileIsServedWithinBothTheMembersAndTheTokensProjects(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		oneProjectOnly(t, s) // SVA and OPS, a task in each
		s.change(t, s.owner, "", "project.create", M{"key": "ART", "name": "Art"})
		s.change(t, s.owner, "", "task.create", M{"project": "ART", "title": "Draw"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Two", "handle": "two", "scope": M{"projects": []string{"SVA", "OPS"}}})
		token := func(body M) string {
			var tok struct{ Token string }
			s.call(t, s.owner, "", "POST", w+"/tokens", body, 201, &tok)
			return tok.Token
		}
		type file struct{ id, name, project string }
		var files []file
		attach := func(project, name string, to M) {
			var f struct{ ID string }
			s.call(t, s.owner, "", "POST", w+"/files?name="+name, []byte("the bytes of "+name), 201, &f)
			to["file"] = f.ID
			s.change(t, s.owner, "", "attachment.add", to)
			files = append(files, file{f.ID, name, project})
		}
		for _, project := range []string{"SVA", "OPS", "ART"} {
			attach(project, "task-"+project+".txt", M{"task": project + "-1"})
			attach(project, "page-"+project+".txt", M{"doc": s.change(t, s.owner, "", "doc.create", M{"title": "Page of " + project, "project": project})["ref"]})
		}
		for _, caller := range []struct {
			name, token string
			projects    []string
		}{
			{"the member's own token", token(M{"user": "@two"}), []string{"SVA", "OPS"}},
			{"the member's token for SVA", token(M{"user": "@two", "projects": []string{"SVA"}}), []string{"SVA"}},
			{"the member's token for a project outside the membership", token(M{"user": "@two", "projects": []string{"ART"}}), nil},
			{"the member's token for SVA and one outside", token(M{"user": "@two", "projects": []string{"SVA", "ART"}}), []string{"SVA"}},
		} {
			for _, f := range files {
				status := 404
				if slices.Contains(caller.projects, f.project) {
					status = 200
				}
				s.call(t, nil, caller.token, "GET", w+"/files/"+f.id, nil, status, nil)
				if body := s.call(t, nil, caller.token, "GET", "/f/"+f.id+"/"+f.name, nil, status, nil); status == 200 && body != "the bytes of "+f.name {
					t.Errorf("%s is served to %s as %q", f.name, caller.name, body)
				}
			}
		}
	})
}

// TestAFileGivenWithACommentOnAPageIsAttachedAndFollowsThePage: the files
// comment.create is given with a comment on a page are attached to the
// comment, as they are on a task, and are seen by those who may see the
// page and by no one else.
func TestAFileGivenWithACommentOnAPageIsAttachedAndFollowsThePage(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		s.change(t, s.owner, "", "agent.create", M{"name": "Other", "handle": "other", "role": "admin"})
		var other struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &other)
		commentWithFile := func(name string, page M) {
			doc := s.change(t, nil, other.Token, "doc.create", page)["ref"].(string)
			var f struct{ ID string }
			s.call(t, nil, other.Token, "POST", w+"/files?name="+name, []byte("the bytes of "+name), 201, &f)
			s.change(t, nil, other.Token, "comment.create", M{"doc": doc, "body": "see the file", "attachments": []M{{"file": f.ID, "caption": "the " + name}}})
		}
		commentWithFile("handbook.txt", M{"title": "Handbook"})
		commentWithFile("runbook.txt", M{"title": "Runbook", "project": "OPS"})
		commentWithFile("diary.txt", M{"title": "Diary", "private": true})

		sees := func(who string, hc *http.Client, token string, want map[string]bool) {
			t.Helper()
			listed := s.call(t, hc, token, "GET", w+"/list/attachments", nil, 200, nil)
			feed := s.call(t, hc, token, "GET", w+"/events?after=0&limit=2000", nil, 200, nil)
			for name, seen := range want {
				if strings.Contains(listed, "the "+name) != seen {
					t.Errorf("/list/attachments lists %s for %s: %v, want %v", name, who, !seen, seen)
				}
				if strings.Contains(feed, "the "+name) != seen {
					t.Errorf("the feed tells %s of %s: %v, want %v", who, name, !seen, seen)
				}
			}
		}
		sees("the one who attached them", nil, other.Token, map[string]bool{"handbook.txt": true, "runbook.txt": true, "diary.txt": true})
		sees("an owner, of a page someone keeps private", s.owner, "", map[string]bool{"handbook.txt": true, "runbook.txt": true, "diary.txt": false})
		for who, token := range callers {
			sees(who, nil, token, map[string]bool{"handbook.txt": true, "runbook.txt": false, "diary.txt": false})
		}
	})
}

// TestAnExportIsNotForATokenLimitedToSomeProjects: an export holds the
// whole workspace, so an admin's token made for some projects is refused
// one; the admin's token for every project, and the admin signed in, get it.
func TestAnExportIsNotForATokenLimitedToSomeProjects(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		oneProjectOnly(t, s)
		var whole, part struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "every project"}, 201, &whole)
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"name": "SVA only", "projects": []string{"SVA"}}, 201, &part)
		s.call(t, s.owner, "", "GET", w+"/export", nil, 200, nil)
		s.call(t, nil, whole.Token, "GET", w+"/export", nil, 200, nil)
		if out := s.call(t, nil, part.Token, "GET", w+"/export", nil, 403, nil); strings.Contains(out, "Rotate keys") || !strings.Contains(out, "every project") {
			t.Fatalf("the refusal: %s", out)
		}
	})
}

// TestAnAdminsExportHoldsEveryMembersPrivatePages: an export is the whole
// workspace, for the admin who keeps it. A page another member keeps
// private, and the page under it, are in it like any other: as rows in
// data/, and written out in docs/. Its README says so.
func TestAnAdminsExportHoldsEveryMembersPrivatePages(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "agent.create", M{"name": "Other", "handle": "other"})
		var other struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &other)
		s.change(t, s.owner, "", "doc.create", M{"title": "Handbook", "markdown": "for everyone\n"})
		diary := s.change(t, nil, other.Token, "doc.create", M{"title": "Diary", "private": true, "markdown": "quokka\n"})["ref"].(string)
		s.change(t, nil, other.Token, "doc.create", M{"parent": diary, "title": "Monday", "markdown": "wombat\n"})
		// The owner, an admin, may not open the page.
		s.call(t, s.owner, "", "GET", w+"/docs/"+diary, nil, 404, nil)

		archive := s.call(t, s.owner, "", "GET", w+"/export", nil, 200, nil)
		pages := unzipped(t, archive, "docs/")
		for _, want := range []string{"=== docs/Handbook.md\nfor everyone", "=== docs/Diary.md\nquokka", "=== docs/Diary/Monday.md\nwombat"} {
			if !strings.Contains(pages, want) {
				t.Errorf("docs/ of an admin's export does not hold %q: %s", want, pages)
			}
		}
		if rows := unzipped(t, archive, "data/docs.json"); !strings.Contains(rows, diary) || !strings.Contains(rows, `"title": "Monday"`) {
			t.Errorf("data/ of an admin's export does not hold the private page and the page under it: %s", rows)
		}
		if blocks := unzipped(t, archive, "data/blocks.json"); !strings.Contains(blocks, "quokka") || !strings.Contains(blocks, "wombat") {
			t.Errorf("data/ of an admin's export does not hold what is written on the private pages: %s", blocks)
		}
		if readme := unzipped(t, archive, "README.txt"); !strings.Contains(readme, "private pages") {
			t.Errorf("the export's README does not say it holds members' private pages: %s", readme)
		}
	})
}

// TestAPrivatePagesSubPagesAreNotSeenByOthers: a page made private after
// it had sub-pages takes them along. Another member, an admin even, does
// not get the sub-page or the one under it in the page list, cannot open
// them, does not find them or what is on them by search, in the starting
// copy or the list of files, is not told of what happens to
// them afterwards, and does not see them among what mentions a page or a
// task, or among a page's sub-pages.
func TestAPrivatePagesSubPagesAreNotSeenByOthers(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(t, s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		s.change(t, s.owner, "", "agent.create", M{"name": "Other", "handle": "other", "role": "admin"})
		var tok struct{ Token string }
		s.call(t, s.owner, "", "POST", w+"/tokens", M{"user": "@other"}, 201, &tok)
		other := tok.Token
		page := func(args M) string { return s.change(t, s.owner, "", "doc.create", args)["ref"].(string) }
		handbook := page(M{"title": "Handbook"})
		plans := page(M{"title": "Plans"})
		q1 := page(M{"parent": plans, "title": "Quarter one", "markdown": "quokka\n"})
		week := page(M{"parent": q1, "title": "Week one", "markdown": "quokka, see SVA-1 and [[Handbook]]\n"})
		s.change(t, s.owner, "", "comment.create", M{"doc": week, "body": "wombat"})
		var f struct{ ID string }
		s.call(t, s.owner, "", "POST", w+"/files?name=week.txt", []byte("x"), 201, &f)
		s.change(t, s.owner, "", "attachment.add", M{"doc": week, "file": f.ID})

		s.change(t, s.owner, "", "doc.update", M{"id": plans, "private": true})
		var at struct{ Seq int64 }
		s.call(t, nil, other, "GET", w+"/events?after=0&limit=2000", nil, 200, &at)
		s.change(t, s.owner, "", "doc.write", M{"doc": week, "markdown": "quokka, rewritten; see SVA-1 and [[Handbook]]\n"})

		hidden := []string{plans, q1, week}
		leaks := func(what, answer string) {
			t.Helper()
			for _, id := range hidden {
				if i := strings.Index(answer, id); i >= 0 {
					t.Errorf("%s shows another member the private page %s: …%s…", what, id, answer[max(0, i-300):min(len(answer), i+100)])
				}
			}
		}
		leaks("the page list", s.call(t, nil, other, "GET", w+"/docs", nil, 200, nil))
		for _, id := range hidden {
			s.call(t, nil, other, "GET", w+"/docs/"+id, nil, 404, nil)
		}
		leaks("search", s.call(t, nil, other, "GET", w+"/search?q=quokka", nil, 200, nil))
		leaks("search of comments", s.call(t, nil, other, "GET", w+"/search?q=wombat", nil, 200, nil))
		leaks("the feed after the page went private", s.call(t, nil, other, "GET", w+"/events?after="+strconv.FormatInt(at.Seq, 10), nil, 200, nil))
		leaks("the starting copy", s.call(t, nil, other, "GET", w+"/bootstrap", nil, 200, nil))
		if out := s.call(t, nil, other, "GET", w+"/list/attachments", nil, 200, nil); strings.Contains(out, f.ID) {
			t.Errorf("the list of files shows the file on a private sub-page: %s", out)
		}
		leaks("what mentions a task", s.call(t, nil, other, "GET", w+"/tasks/SVA-1", nil, 200, nil))
		leaks("what mentions a page", s.call(t, nil, other, "GET", w+"/docs/"+handbook, nil, 200, nil))

		// A sub-page someone keeps private under a page others see is not
		// among that page's sub-pages for them.
		open := page(M{"title": "Open"})
		mine := page(M{"parent": open, "title": "Mine", "private": true})
		if out := s.call(t, nil, other, "GET", w+"/docs/"+open, nil, 200, nil); strings.Contains(out, mine) {
			t.Errorf("a page's sub-pages show another member a private one: %s", out)
		}

		// The owner still has all of it.
		for _, id := range hidden {
			s.call(t, s.owner, "", "GET", w+"/docs/"+id, nil, 200, nil)
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

// TestTheStartingCopyFillsItsLatestWithWhatTheCallerMaySee: the starting
// copy brings the latest inbox items and agent sessions up to a number,
// counted among those the caller may see: newer ones of a project they may
// not read do not crowd out older ones of a project they may.
func TestTheStartingCopyFillsItsLatestWithWhatTheCallerMaySee(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		callers := limitedToSVA(t, s)
		var sva1, ops1 struct{ Task core.Task }
		s.call(t, s.owner, "", "GET", w+"/tasks/SVA-1?raw=1", nil, 200, &sva1)
		s.call(t, s.owner, "", "GET", w+"/tasks/OPS-1?raw=1", nil, 200, &ops1)
		var me struct {
			Workspace core.Workspace
			Me        core.Member
		}
		s.call(t, s.owner, "", "GET", w+"/bootstrap", nil, 200, &me)
		ctx := context.Background()
		db := st.In(me.Workspace.ID)
		agent := s.change(t, s.owner, "", "agent.create", M{"name": "Busy", "handle": "busy"})["ref"].(string)
		// One of SVA, then more of OPS than the copy brings, each newer.
		for i, taskID := range append([]string{sva1.Task.ID}, slices.Repeat([]string{ops1.Task.ID}, 301)...) {
			at := time.Now().UnixMilli() + int64(i)
			for _, row := range []any{
				core.Notification{ID: id.New(), UserID: me.Me.UserID, Seq: int64(1000 + i), Type: core.NoteComment, ActorID: agent, TaskID: taskID, CreatedAt: at},
				core.AgentSession{ID: id.New(), AgentID: agent, TaskID: taskID, State: core.AgentSessionRunning, StartedAt: at},
			} {
				if err := db.Insert(ctx, row); err != nil {
					t.Fatal(err)
				}
			}
		}
		for who, token := range callers {
			var got struct {
				Notifications []core.Notification
				Sessions      []core.AgentSession
			}
			s.call(t, nil, token, "GET", w+"/bootstrap", nil, 200, &got)
			if who == "an admin's token limited to SVA" && !slices.ContainsFunc(got.Notifications, func(n core.Notification) bool { return n.TaskID == sva1.Task.ID }) {
				t.Errorf("%s is not given its inbox item of SVA among the latest it may see (%d given)", who, len(got.Notifications))
			}
			if !slices.ContainsFunc(got.Sessions, func(session core.AgentSession) bool { return session.TaskID == sva1.Task.ID }) {
				t.Errorf("%s is not given the session on SVA-1 among the latest it may see (%d given)", who, len(got.Sessions))
			}
		}
	})
}
