package engine_test

import (
	"context"
	"errors"
	"maps"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
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

// TestAThreadOutlivesItsFirstComment: deleting the comment that started a
// thread leaves the replies as the thread, on what it was on: the first
// reply heads it, with the thread's resolved state, and the rest answer it.
func TestAThreadOutlivesItsFirstComment(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		page := w.do(w.owner.ID, "doc.create", M{"title": "Art notes", "markdown": "The ring is thin.\n"}).Ref
		var block core.Block
		if err := w.db().Get(context.Background(), &block, store.Eq("doc_id", page)); err != nil {
			t.Fatal(err)
		}
		helper := w.agent("helper")
		root := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": block.ID, "body": "Is the ring right?"}).Ref
		first := w.do(helper, "comment.create", M{"parent": root, "body": "It is."}).Ref
		second := w.do(w.owner.ID, "comment.create", M{"parent": root, "body": "Thanks."}).Ref
		w.do(w.owner.ID, "comment.update", M{"id": root, "resolved": true})
		w.do(w.owner.ID, "comment.delete", M{"id": root})

		comment := func(ref string) core.Comment {
			t.Helper()
			var cm core.Comment
			if err := w.db().Get(context.Background(), &cm, store.Eq("id", ref)); err != nil {
				t.Fatal(err)
			}
			return cm
		}
		head, rest := comment(first), comment(second)
		if head.ParentID != "" || head.SubjectID != block.ID || head.ResolvedAt == 0 {
			t.Errorf("the first reply does not head the thread on its block, resolved: %+v", head)
		}
		if rest.ParentID != first {
			t.Errorf("the next reply answers %q, want the new head %q", rest.ParentID, first)
		}
		// The thread goes on: a reply to it joins the new head.
		third := w.do(helper, "comment.create", M{"parent": second, "body": "Anytime."}).Ref
		if got := comment(third).ParentID; got != first {
			t.Errorf("a new reply answers %q, want %q", got, first)
		}
	})
}

// TestAThreadGoesOnAfterItsBlockIsGone: a block taken out of the page keeps
// its threads, and they can still be answered; only a new thread needs the
// block to be there.
func TestAThreadGoesOnAfterItsBlockIsGone(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		page := w.do(w.owner.ID, "doc.create", M{"title": "Draft", "markdown": "Cut this.\n"}).Ref
		var block core.Block
		if err := w.db().Get(context.Background(), &block, store.Eq("doc_id", page)); err != nil {
			t.Fatal(err)
		}
		root := w.do(w.owner.ID, "comment.create", M{"doc": page, "block": block.ID, "body": "Why is this here?"}).Ref
		w.do(w.owner.ID, "doc.edit", M{"doc": page, "ops": []M{{"op": "delete", "id": block.ID}}})

		reply := w.do(w.agent("helper"), "comment.create", M{"parent": root, "body": "It was moved to the plan."}).Ref
		var cm core.Comment
		if err := w.db().Get(context.Background(), &cm, store.Eq("id", reply)); err != nil {
			t.Fatal(err)
		}
		if cm.ParentID != root || cm.SubjectType != "doc_block" || cm.SubjectID != block.ID || cm.DocID != page {
			t.Errorf("the reply is not in the thread on the gone block: %+v", cm)
		}
		w.refused(engine.CodeNotFound, w.owner.ID, "comment.create", M{"doc": page, "block": block.ID, "body": "A new one"})
	})
}

// TestACommentIsOnlyOnThePageItNames: a comment is on the page it names and
// on nothing of another: a block, words or a thread of a page it does not
// name is refused as not found, whether the commenter may see that page or
// not, so that a page one cannot see is never quoted, answered or told of
// through one they can.
func TestACommentIsOnlyOnThePageItNames(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Explosion effect"})
		secret := w.do(w.owner.ID, "doc.create", M{"title": "Salaries", "markdown": "Bea earns a lot.\n", "private": true}).Ref
		var hidden core.Block
		if err := w.db().Get(context.Background(), &hidden, store.Eq("doc_id", secret)); err != nil {
			t.Fatal(err)
		}
		hiddenThread := w.do(w.owner.ID, "comment.create", M{"doc": secret, "block": hidden.ID, "body": "Too much?"}).Ref
		open := w.do(w.owner.ID, "doc.create", M{"title": "Plans", "markdown": "We ship in May.\n"}).Ref
		openThread := w.do(w.owner.ID, "comment.create", M{"doc": open, "body": "Really?"}).Ref
		bea := w.agent("bea")

		for _, c := range []struct {
			name string
			args M
		}{
			{"a block of another page", M{"doc": open, "block": hidden.ID}},
			{"words of another page", M{"doc": open, "block": hidden.ID, "quote": "Bea"}},
			{"a reply to a thread of another page", M{"doc": open, "parent": hiddenThread}},
			{"a reply on a block of another page", M{"parent": openThread, "block": hidden.ID}},
			{"a reply to a page's thread said to be on a task", M{"task": "SVA-1", "parent": openThread}},
		} {
			t.Run(c.name, func(t *testing.T) {
				args := M{"body": "@aram what does it say?"}
				maps.Copy(args, c.args)
				_, err := w.try(bea, "comment.create", args)
				if ee := (*engine.Error)(nil); !errors.As(err, &ee) || ee.Code != engine.CodeNotFound {
					t.Errorf("got %v, want it refused as not found", err)
				}
			})
		}
	})
}
