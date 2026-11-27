package engine_test

import (
	"slices"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestNotifyMarksAnItemAddressedUnlessItIsHeardAsAFollower: an item made
// because the change was for its member (assigned, handed the task,
// mentioned, asked, answered, a person's comment on its own task, the asker
// in a thread) is addressed; one heard only because the member follows the
// task is not; one that is both is addressed.
func TestNotifyMarksAnItemAddressedUnlessItIsHeardAsAFollower(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		coder := w.agent("coder")
		w.do(w.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"})
		w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Rotate keys"})
		// item is the last item of the agent's about what (its id), failing
		// when there is none.
		item := func(t *testing.T, what string) core.Notification {
			t.Helper()
			for _, n := range slices.Backward(w.inbox(coder)) {
				if n.EntityID == what {
					return n
				}
			}
			t.Fatalf("no item about %s", what)
			return core.Notification{}
		}
		addressed := func(t *testing.T, what, typ string, want bool) {
			t.Helper()
			if n := item(t, what); n.Type != typ || n.Addressed != want {
				t.Errorf("the item is %s, addressed %v; want %s, addressed %v", n.Type, n.Addressed, typ, want)
			}
		}
		task := w.task("OPS-1").ID

		t.Run("assigned", func(t *testing.T) {
			w.do(w.owner.ID, "task.update", M{"id": "OPS-1", "assignee": "@coder"})
			addressed(t, task, core.NoteAssigned, true)
		})
		t.Run("a person's comment on the agent's own task", func(t *testing.T) {
			addressed(t, w.do(w.owner.ID, "comment.create", M{"task": "OPS-1", "body": "Use the new vault."}).Ref, core.NoteComment, true)
		})
		t.Run("handed the task", func(t *testing.T) {
			w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Renew certificates"})
			addressed(t, w.do(w.owner.ID, "comment.create", M{"task": "OPS-2", "body": "Over to you.", "waiting_on": "@coder"}).Ref, core.NoteComment, true)
		})
		t.Run("mentioned", func(t *testing.T) {
			w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Audit logs"})
			addressed(t, w.do(w.owner.ID, "comment.create", M{"task": "OPS-3", "body": "@coder have a look"}).Ref, core.NoteMentioned, true)
		})
		t.Run("asked", func(t *testing.T) {
			question := w.do(w.owner.ID, "decision.open", M{"task": "OPS-1", "question": "Which vault?", "options": []M{{"label": "Old"}, {"label": "New"}}, "ask": "@coder"}).Ref
			addressed(t, question, core.NoteAsked, true)
		})
		t.Run("answered", func(t *testing.T) {
			question := w.do(coder, "decision.open", M{"task": "OPS-1", "question": "Rotate monthly?", "options": []M{{"label": "Yes"}, {"label": "No"}}}).Ref
			w.do(w.owner.ID, "decision.pick", M{"id": question, "option": 1})
			addressed(t, question, core.NotePicked, true)
		})
		t.Run("the asker in a thread", func(t *testing.T) {
			w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Clean up"})
			root := w.do(coder, "comment.create", M{"task": "OPS-4", "body": "@aram which logs?"}).Ref
			addressed(t, w.do(w.owner.ID, "comment.create", M{"parent": root, "body": "The old ones."}).Ref, core.NoteReplied, true)
		})
		t.Run("a follower", func(t *testing.T) {
			w.do(w.owner.ID, "task.create", M{"project": "OPS", "title": "Write the runbook", "assignee": "@aram"})
			w.do(coder, "watch.set", M{"subject": "OPS-5"})
			addressed(t, w.do(w.owner.ID, "comment.create", M{"task": "OPS-5", "body": "@aram started it."}).Ref, core.NoteComment, false)
		})
		t.Run("a follower who is also mentioned", func(t *testing.T) {
			addressed(t, w.do(w.owner.ID, "comment.create", M{"task": "OPS-5", "body": "@coder can you finish it?"}).Ref, core.NoteMentioned, true)
		})
	})
}

// TestAPageCommentTellsOnlyThoseWhoMaySeeThePage: a comment on a page tells
// a member it mentions, answers or who follows the page only when they may
// see the page; one who may not (a private page not shared with them, a
// page of a project they may not read) is told nothing, not its title nor
// the comment.
func TestAPageCommentTellsOnlyThoseWhoMaySeeThePage(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		w := newWorld(t, st)
		me := w.owner.ID
		bea, coder := w.agent("bea"), w.agent("coder")
		w.do(me, "project.create", M{"key": "OPS", "name": "Operations"})
		w.do(me, "project.create", M{"key": "SVA", "name": "Samurai vs Aliens"})
		w.do(me, "agent.update", M{"id": "@coder", "scope": M{"projects": []string{"SVA"}}})
		salaries := w.do(me, "doc.create", M{"title": "Salaries", "private": true, "shared_with": []string{"@bea"}, "markdown": "who earns what\n"}).Ref
		vault := w.do(me, "doc.create", M{"title": "Vault runbook", "project": "OPS", "markdown": "rotate\n"}).Ref
		plain := w.do(me, "doc.create", M{"title": "Handbook", "markdown": "how we work\n"}).Ref
		told := func(userID, docID string) bool {
			for _, n := range w.inbox(userID) {
				if n.DocID == docID {
					return true
				}
			}
			return false
		}

		w.do(me, "comment.create", M{"doc": salaries, "body": "@bea @coder the raises are in"})
		w.do(me, "comment.create", M{"doc": vault, "body": "@bea @coder rotate on Friday"})
		w.do(me, "comment.create", M{"doc": plain, "body": "@bea @coder read this"})
		for _, c := range []struct {
			who, page, what string
			want            bool
		}{
			{bea, salaries, "a private page shared with them", true},
			{coder, salaries, "a private page not shared with them", false},
			{bea, vault, "a page of a project they may read", true},
			{coder, vault, "a page of a project they may not read", false},
			{coder, plain, "a page of the workspace", true},
		} {
			if got := told(c.who, c.page); got != c.want {
				t.Errorf("mentioned in a comment on %s: told %v, want %v", c.what, got, c.want)
			}
		}
	})
}
