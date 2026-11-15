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
