package engine_test

import (
	"context"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func TestALinkSetWithoutAnIDAnswersWithItsID(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss design"})
		args := M{"task": "SVA-1", "kind": "url", "url": "https://example.com/boss", "title": "Sketches"}
		made := w.do(w.owner.ID, "link.set", args).Ref
		var l core.TaskLink
		if err := w.db().Get(context.Background(), &l, store.Eq("id", made)); err != nil {
			t.Fatalf("the answer %q is not the link made: %v", made, err)
		}
		args["title"] = "Final sketches"
		if updated := w.do(w.owner.ID, "link.set", args).Ref; updated != made {
			t.Fatalf("updating the link answered %q, want %q", updated, made)
		}
	})
}

// TestAPageLinkedToATaskIsAReference: link.set of kind doc ties a page to a
// task and records the reference from the task to the page, the one a
// mention in the task's text makes, so the page lists the task and the
// task's context pack lists the page. Removing the link takes the reference
// away. A page the actor may not see cannot be linked.
func TestAPageLinkedToATaskIsAReference(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		me := w.owner.ID
		bea := w.agent("bea")
		w.do(me, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(me, "task.create", M{"project": "SVA", "title": "Boss design"})
		task := w.task("SVA-1")
		page := w.do(me, "doc.create", M{"title": "Art guide", "markdown": "colours\n"}).Ref
		refsTo := func(docID string) []core.Ref {
			var refs []core.Ref
			if err := w.db().List(context.Background(), &refs, store.Where(store.Eq("to_id", docID))); err != nil {
				t.Fatal(err)
			}
			return refs
		}

		made := w.do(me, "link.set", M{"task": "SVA-1", "kind": "doc", "ref": page}).Ref
		refs := refsTo(page)
		if len(refs) != 1 || refs[0].FromScopeType != "task" || refs[0].FromScopeID != task.ID || refs[0].FromID != made || refs[0].ToType != "doc" {
			t.Fatalf("linking the page recorded %+v, want one reference from SVA-1 by the link", refs)
		}
		if again := w.do(me, "link.set", M{"task": "SVA-1", "kind": "doc", "ref": page}).Ref; again != made || len(refsTo(page)) != 1 {
			t.Fatalf("linking the same page again made link %q and %d references, want %q and 1", again, len(refsTo(page)), made)
		}

		w.do(me, "link.remove", M{"id": made})
		if refs := refsTo(page); len(refs) != 0 {
			t.Fatalf("the link is removed and the page is still referenced: %+v", refs)
		}

		w.refused("not_found", me, "link.set", M{"task": "SVA-1", "kind": "doc", "ref": "0b7e1c2a-0000-4000-8000-000000000000"})
		private := w.do(bea, "doc.create", M{"title": "Bea's notes", "markdown": "mine\n", "private": true}).Ref
		w.refused("not_found", me, "link.set", M{"task": "SVA-1", "kind": "doc", "ref": private})
	})
}
