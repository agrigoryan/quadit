package engine_test

import (
	"context"
	"maps"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
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

// TestAReplyReachesEveryoneInTheThread: whoever wrote in a thread before is
// told of a reply in it as a reply, not only the one who started it, on a
// page and on a task alike. The one who asked in a reply hears the answer.
func TestAReplyReachesEveryoneInTheThread(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion effect"})
		page := w.do(w.owner.ID, "doc.create", M{"title": "Art notes", "markdown": "The ring is thin.\n"}).Ref
		asker, answerer := w.agent("asker"), w.agent("answerer")
		for _, on := range []struct {
			name string
			args M
		}{
			{"on a page", M{"doc": page}},
			{"on a task", M{"task": "SVA-1"}},
		} {
			t.Run(on.name, func(t *testing.T) {
				args := M{"body": "Is the ring right?"}
				maps.Copy(args, on.args)
				root := w.do(w.owner.ID, "comment.create", args).Ref
				w.do(asker, "comment.create", M{"parent": root, "body": "@answerer what do you think?"})
				reply := w.do(answerer, "comment.create", M{"parent": root, "body": "Thicker by two pixels."}).Ref
				for who, id := range map[string]string{"the one who started it": w.owner.ID, "the one who asked in a reply": asker} {
					var got *core.Notification
					for _, n := range w.inbox(id) {
						if n.EntityID == reply {
							got = &n
						}
					}
					if got == nil || got.Type != core.NoteReplied {
						t.Errorf("%s was not told of the reply as a reply: %+v", who, got)
					}
				}
			})
		}
	})
}

// TestAThreadIsResolvedThroughAnyOfItsComments: resolving or opening again
// asked of a reply is done to its thread, which its first comment carries.
func TestAThreadIsResolvedThroughAnyOfItsComments(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		page := w.do(w.owner.ID, "doc.create", M{"title": "Art notes"}).Ref
		root := w.do(w.owner.ID, "comment.create", M{"doc": page, "body": "Is the ring right?"}).Ref
		reply := w.do(w.owner.ID, "comment.create", M{"parent": root, "body": "It is."}).Ref
		resolvedAt := func(ref string) int64 {
			t.Helper()
			var cm core.Comment
			if err := w.db().Get(context.Background(), &cm, store.Eq("id", ref)); err != nil {
				t.Fatal(err)
			}
			return cm.ResolvedAt
		}
		w.do(w.owner.ID, "comment.update", M{"id": reply, "resolved": true})
		if resolvedAt(root) == 0 || resolvedAt(reply) != 0 {
			t.Fatalf("resolved through a reply: thread %d, reply %d; want the thread resolved and the reply untouched", resolvedAt(root), resolvedAt(reply))
		}
		w.do(w.owner.ID, "comment.update", M{"id": reply, "resolved": false})
		if resolvedAt(root) != 0 {
			t.Fatal("opening again through a reply left the thread resolved")
		}
	})
}
