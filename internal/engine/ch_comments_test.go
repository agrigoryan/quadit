package engine_test

import (
	"context"
	"maps"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestEditedCommentIsFoundByItsNewText: search knows a comment by the text
// it has now, on a task and on a page alike.
func TestEditedCommentIsFoundByItsNewText(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion effect"})
		page := w.do(w.owner.ID, "doc.create", M{"title": "Art notes"}).Ref

		found := func(text string) map[string]bool {
			t.Helper()
			hits, err := w.db().Search(context.Background(), store.SearchQuery{Text: text, Kinds: []string{"comment"}, Viewer: w.owner.ID})
			if err != nil {
				t.Fatal(err)
			}
			ids := map[string]bool{}
			for _, h := range hits {
				ids[h.EntityID] = true
			}
			return ids
		}
		for _, on := range []struct {
			name string
			args M
		}{
			{"on a task", M{"task": "SVA-1"}},
			{"on a page", M{"doc": page}},
		} {
			t.Run(on.name, func(t *testing.T) {
				args := M{"body": "the ring is too thin"}
				maps.Copy(args, on.args)
				cm := w.do(w.owner.ID, "comment.create", args).Ref
				w.do(w.owner.ID, "comment.update", M{"id": cm, "body": "the burst is too small"})
				if !found("burst")[cm] {
					t.Error("search does not find the comment by its new text")
				}
				if found("ring")[cm] {
					t.Error("search still finds the comment by its old text")
				}
			})
		}
	})
}
