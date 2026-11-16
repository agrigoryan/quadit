package engine_test

import (
	"context"
	"maps"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func (w *world) doc(id string) core.Doc {
	w.t.Helper()
	var d core.Doc
	if err := w.db().Get(context.Background(), &d, store.Eq("id", id)); err != nil {
		w.t.Fatalf("doc %s: %v", id, err)
	}
	return d
}

// found reports whether search finds a page for someone limited to one project.
func (w *world) found(text, projectID, docID string) bool {
	w.t.Helper()
	hits, err := w.db().Search(context.Background(), store.SearchQuery{Text: text, ProjectIDs: []string{projectID}, Viewer: w.owner.ID})
	if err != nil {
		w.t.Fatal(err)
	}
	for _, h := range hits {
		if h.ScopeID == docID {
			return true
		}
	}
	return false
}

// TestPageProjectTakesItsSubPages: a page's project is its sub-pages' too,
// as it is when they are made. Changing it takes along those that are in
// the project because the page is; one tied elsewhere on purpose stays.
func TestPageProjectTakesItsSubPages(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		me := w.owner.ID
		sva := w.do(me, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
		ops := w.do(me, "project.create", M{"key": "OPS", "name": "Operations"}).Ref
		page := func(title, parent string, more M) string {
			args := M{"title": title, "markdown": title + " zanzibar\n"}
			if parent != "" {
				args["parent"] = parent
			}
			maps.Copy(args, more)
			return w.do(me, "doc.create", args).Ref
		}
		root := page("Handbook", "", nil)
		child := page("Art", root, nil)
		grand := page("Palette", child, nil)
		table := page("Sprites", root, M{"kind": "database"})
		row := page("Idle", table, nil)
		apart := page("Runbook", root, M{"project": "OPS"})
		under := page("On call", apart, nil)
		gone := page("Old notes", root, nil)
		w.do(me, "doc.delete", M{"id": gone})

		res := w.do(me, "doc.update", M{"id": root, "project": "SVA"})
		for _, id := range []string{root, child, grand, table, row, gone} {
			if got := w.doc(id).ProjectID; got != sva {
				t.Fatalf("%s is in project %q after its top page moved, want SVA", w.doc(id).Title, got)
			}
		}
		for _, id := range []string{apart, under} {
			if got := w.doc(id).ProjectID; got != ops {
				t.Fatalf("%s was tied to OPS on purpose and is now in %q", w.doc(id).Title, got)
			}
		}
		// Every page that moved says so in the feed, once.
		told := map[string]int{}
		for _, ev := range res.Events {
			if ev.Type == "doc.updated" {
				told[ev.EntityID]++
			}
		}
		if len(told) != 6 || told[root] != 1 || told[grand] != 1 || told[row] != 1 || told[apart] != 0 {
			t.Fatalf("the feed tells of %v, want one event for each of the six pages that moved", told)
		}
		// Search keeps each page to those who may see its project now; the
		// one in the trash stays out of it.
		if !w.found("zanzibar", sva, grand) || w.found("zanzibar", ops, grand) {
			t.Fatal("search did not follow a sub-page into its new project")
		}
		if w.found("zanzibar", sva, gone) {
			t.Fatal("a page in the trash came back into search when its project changed")
		}
		// Restored, it is where its parent is.
		w.do(me, "doc.restore", M{"id": gone})
		if got := w.doc(gone).ProjectID; got != sva {
			t.Fatalf("the restored page is in %q, want SVA", got)
		}

		// Asking for the project it has changes nothing and says nothing.
		if again := w.do(me, "doc.update", M{"id": root, "project": sva}); len(again.Events) != 0 {
			t.Fatalf("setting the same project wrote %d events", len(again.Events))
		}

		// Cleared, the same pages go back to no project; the ones apart stay.
		res = w.do(me, "doc.update", M{"id": root, "project": nil})
		// Leaving a project is told twice: the change to those who see the
		// project, and the whole page to those who now see it and did not.
		var toOld, toNew int
		for _, ev := range res.Events {
			if ev.EntityID != grand {
				continue
			}
			if ev.ProjectID == sva && strings.Contains(string(ev.Data), `"changes"`) {
				toOld++
			}
			if ev.ProjectID == "" && strings.Contains(string(ev.Data), `"row"`) {
				toNew++
			}
		}
		if toOld != 1 || toNew != 1 {
			t.Fatalf("a sub-page that left SVA was told %d times to SVA and %d times, whole, to everyone; want once each", toOld, toNew)
		}
		for _, id := range []string{root, child, grand, table, row, gone} {
			if got := w.doc(id).ProjectID; got != "" {
				t.Fatalf("%s is still in project %q after its top page left it", w.doc(id).Title, got)
			}
		}
		if w.doc(apart).ProjectID != ops || w.doc(under).ProjectID != ops {
			t.Fatal("clearing the top page's project took a page tied elsewhere with it")
		}
		if w.found("zanzibar", sva, grand) {
			t.Fatal("search still files a sub-page under the project its top page left")
		}

		// A sub-page moved alone leaves its own sub-pages with it, and its parent where it was.
		w.do(me, "doc.update", M{"id": child, "project": "OPS"})
		if w.doc(grand).ProjectID != ops || w.doc(root).ProjectID != "" || w.doc(table).ProjectID != "" {
			t.Fatal("moving a sub-page did not take just its own sub-tree")
		}

		// Someone limited to one project cannot move a page into another.
		narrow := w.agent("narrow")
		w.do(me, "agent.update", M{"id": "@narrow", "scope": M{"projects": []string{"OPS"}}})
		w.refused(engine.CodeForbidden, narrow, "doc.update", M{"id": root, "project": "SVA"})
		w.do(narrow, "doc.update", M{"id": root, "project": "OPS"})
		if w.doc(table).ProjectID != ops || w.doc(row).ProjectID != ops {
			t.Fatal("a database's rows did not follow it into the project")
		}
	})
}
