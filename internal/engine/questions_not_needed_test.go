package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// questions is a world with an agent, @artist, whose responsible person is
// the owner, a member @bea, and the project SVA.
type questions struct {
	*world
	artist, bea string
}

func newQuestions(t *testing.T, st store.Store) questions {
	t.Helper()
	w := newWorld(t, st)
	q := questions{world: w, artist: w.agent("artist"), bea: w.person("bea")}
	w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	return q
}

// newTask makes a task of SVA assigned to @artist.
func (q questions) newTask(title string) string {
	q.t.Helper()
	return q.do(q.owner.ID, "task.create", M{"project": "SVA", "title": title, "assignee": "@artist"}).Key
}

// ask opens a question on task key, by asker, of whom.
func (q questions) ask(asker, key, whom string) string {
	q.t.Helper()
	return q.do(asker, "decision.open", M{"task": key, "question": "Which one?", "ask": whom, "options": []M{{"label": "A"}, {"label": "B"}}}).Ref
}

// decision is a question as stored.
func (q questions) decision(ref string) core.Decision {
	q.t.Helper()
	var d core.Decision
	if err := q.db().Get(context.Background(), &d, store.Eq("id", ref)); err != nil {
		q.t.Fatal(err)
	}
	return d
}

// notNeededItems are the asker's items saying their question was closed.
func (q questions) notNeededItems(userID string) []core.Notification {
	q.t.Helper()
	var out []core.Notification
	for _, n := range q.inbox(userID) {
		if n.Type == core.NoteNotNeeded {
			out = append(out, n)
		}
	}
	return out
}

// TestAQuestionNoLongerNeededIsClosed: decision.close settles an open or
// sent-back question as not_needed and keeps it: who closed it and when,
// the note, the items that asked it read, the asker told when someone
// else closed it (addressed only with a note), and the task no longer
// waiting on the one asked for it alone. It is for the asker, the one
// asked, the asking agent's responsible person and an admin; an answered
// question is refused, a closed one is closed already, and a closed one
// cannot be answered.
func TestAQuestionNoLongerNeededIsClosed(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		key := q.newTask("Boss")

		t.Run("the one asked closes it with a note: kept, the asker told in words for it", func(t *testing.T) {
			d := q.ask(q.artist, key, "@aram")
			if got := q.world.task(key); got.WaitingOnID != q.owner.ID {
				t.Fatalf("the task waits on %q", got.WaitingOnID)
			}
			res := q.do(q.owner.ID, "decision.close", M{"id": d, "note": "settled in the comments"})
			got := q.decision(d)
			if got.State != core.StateNotNeeded || got.DecidedBy != q.owner.ID || got.DecidedAt == 0 || got.OutcomeNote != "settled in the comments" || got.Outcome != "" || got.DeletedAt != 0 {
				t.Fatalf("the closed question is %+v", got)
			}
			if items := q.notNeededItems(q.artist); len(items) != 1 || !items[0].Addressed || items[0].Snippet != "no longer needed: settled in the comments" {
				t.Fatalf("the asker was told %+v", items)
			}
			if got := q.unreadOf(q.owner.ID, q.world.task(key).ID); len(got) != 0 {
				t.Fatalf("the owner still has %q unread", got)
			}
			if got := q.world.task(key); got.WaitingOnID != "" {
				t.Fatalf("the task still waits on %q", got.WaitingOnID)
			}
			closed := false
			for _, ev := range res.Events {
				closed = closed || ev.Type == "decision.closed" && ev.EntityID == d
			}
			if !closed {
				t.Fatalf("no decision.closed in %+v", res.Events)
			}
			q.refused(engine.CodeConflict, q.owner.ID, "decision.pick", M{"id": d, "option": 1})
			q.refused(engine.CodeConflict, q.artist, "decision.unclear", M{"id": d, "note": "which?"})
			q.do(q.owner.ID, "decision.close", M{"id": d}) // closed already: nothing to do
		})
		t.Run("without a note the asker's item is news, not addressed", func(t *testing.T) {
			before := len(q.notNeededItems(q.artist))
			d := q.ask(q.artist, key, "@aram")
			q.do(q.owner.ID, "decision.close", M{"id": d})
			if items := q.notNeededItems(q.artist); len(items) != before+1 || items[len(items)-1].Addressed {
				t.Fatalf("the asker was told %+v", items)
			}
		})
		t.Run("the asker closes its own: nobody is told", func(t *testing.T) {
			before := len(q.notNeededItems(q.artist))
			d := q.ask(q.artist, key, "@aram")
			q.do(q.artist, "decision.close", M{"id": d})
			if q.decision(d).State != core.StateNotNeeded || len(q.notNeededItems(q.artist)) != before {
				t.Fatal("the asker closing its own question was told of it")
			}
		})
		t.Run("a sent-back question closed without a note keeps what sent it back as the reason", func(t *testing.T) {
			d := q.ask(q.artist, key, "@aram")
			q.do(q.owner.ID, "decision.pick", M{"id": d, "outcome": "none", "note": "let us talk it through"})
			q.do(q.owner.ID, "decision.close", M{"id": d})
			if got := q.decision(d); got.State != core.StateNotNeeded || got.OutcomeNote != "let us talk it through" || got.Outcome != "" {
				t.Fatalf("the closed question is %+v", got)
			}
		})
		t.Run("an answered question is refused", func(t *testing.T) {
			d := q.ask(q.artist, key, "@aram")
			q.do(q.owner.ID, "decision.pick", M{"id": d, "option": 1})
			q.refused(engine.CodeConflict, q.owner.ID, "decision.close", M{"id": d})
		})
		t.Run("who may close it", func(t *testing.T) {
			helper := q.do(q.bea, "agent.create", M{"name": "Helper", "handle": "helper", "task": key}).Ref // bea answers for it
			d := q.ask(helper, key, "@artist")
			other := q.person("cy")
			q.refused(engine.CodeForbidden, other, "decision.close", M{"id": d})
			q.do(q.bea, "decision.close", M{"id": d}) // the asking agent's responsible person
			d = q.ask(helper, key, "@artist")
			q.do(q.artist, "decision.close", M{"id": d}) // the one asked
			d = q.ask(q.bea, key, "@artist")
			q.do(q.owner.ID, "decision.close", M{"id": d}) // an admin
		})
	})
}

// TestClosingATaskSettlesWhatHangsOnIt: a task moved to a done or
// canceled status, by its update or by its status being deleted, has its
// open and sent-back questions closed as not needed by whoever closed it,
// and waits on nobody, outside events included; opening it again brings
// neither back; and a hand-off on a closed task makes it wait on nobody.
func TestClosingATaskSettlesWhatHangsOnIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		key := q.newTask("Boss")
		open := q.ask(q.artist, key, "@aram")
		answered := q.ask(q.artist, key, "@aram")
		q.do(q.owner.ID, "decision.pick", M{"id": answered, "option": 1})
		sentBack := q.ask(q.artist, key, "@aram") // the last asked: asking again would settle it
		q.do(q.owner.ID, "decision.pick", M{"id": sentBack, "outcome": "none", "note": "not yet"})
		q.do(q.owner.ID, "task.update", M{"id": key, "waiting_on": "outside", "waiting_on_note": "the publisher"})

		res := q.do(q.bea, "task.update", M{"id": key, "status": "Done"})
		for _, d := range []string{open, sentBack} {
			if got := q.decision(d); got.State != core.StateNotNeeded || got.DecidedBy != q.bea {
				t.Fatalf("after the task closed the question is %+v", got)
			}
		}
		if got := q.decision(answered); got.State != core.StatePicked {
			t.Fatalf("the answered question is %+v", got)
		}
		if got := q.world.task(key); got.WaitingOnID != "" || got.WaitingOutside || got.WaitingOnNote != "" {
			t.Fatalf("the closed task still waits: %+v", got)
		}
		closed := 0
		for _, ev := range res.Events {
			if ev.Type == "decision.closed" {
				closed++
			}
		}
		if closed != 2 {
			t.Fatalf("%d decision.closed events", closed)
		}
		q.do(q.owner.ID, "comment.create", M{"task": key, "body": "Your turn.", "waiting_on": "@artist"})
		if got := q.world.task(key); got.WaitingOnID != "" {
			t.Fatalf("a hand-off on the closed task made it wait on %q", got.WaitingOnID)
		}
		q.do(q.owner.ID, "task.update", M{"id": key, "status": "In Progress"})
		if got := q.decision(open); got.State != core.StateNotNeeded {
			t.Fatalf("reopening the task brought back %+v", got)
		}

		t.Run("a status deleted, its tasks moved to a done one", func(t *testing.T) {
			q.do(q.owner.ID, "status.create", M{"project": "SVA", "name": "Review", "category": "started"})
			other := q.newTask("Arena")
			q.do(q.owner.ID, "task.update", M{"id": other, "status": "Review"})
			d := q.ask(q.artist, other, "@aram")
			q.do(q.owner.ID, "status.delete", M{"id": "Review", "move_to": "Canceled"})
			if got := q.decision(d); got.State != core.StateNotNeeded {
				t.Fatalf("after its status went to Canceled the question is %+v", got)
			}
		})
	})
}

// TestASentBackQuestionIsSettledWhenItsAskerMovesOn: an answer sent back
// to its asker is settled (not_needed) when the asker opens a new question
// on the task or posts a result there; not by a plain comment, nor by
// someone else.
func TestASentBackQuestionIsSettledWhenItsAskerMovesOn(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		key := q.newTask("Boss")
		sendBack := func() string {
			d := q.ask(q.artist, key, "@aram")
			q.do(q.owner.ID, "decision.pick", M{"id": d, "outcome": "none", "note": "think again"})
			return d
		}
		d := sendBack()
		q.do(q.artist, "comment.create", M{"task": key, "body": "Thinking."})
		q.do(q.owner.ID, "comment.create", M{"task": key, "kind": "result", "body": "Did it myself."})
		if got := q.decision(d); got.State != core.StateSentBack {
			t.Fatalf("a comment, or another's result, settled it: %+v", got)
		}
		q.ask(q.artist, key, "@aram")
		if got := q.decision(d); got.State != core.StateNotNeeded || got.DecidedBy != q.artist {
			t.Fatalf("asking again left it %+v", got)
		}
		d = sendBack()
		q.do(q.artist, "comment.create", M{"task": key, "kind": "result", "body": "Done another way."})
		if got := q.decision(d); got.State != core.StateNotNeeded {
			t.Fatalf("a result left it %+v", got)
		}
	})
}

// TestAResultGoesToWhoAnsweredNotToWhoClosed: a result hands the task to
// the member who last answered a question on it (picked, or sent back),
// not to one who only closed a question.
func TestAResultGoesToWhoAnsweredNotToWhoClosed(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		key := q.newTask("Boss")
		answered := q.ask(q.artist, key, "@aram")
		q.do(q.owner.ID, "decision.pick", M{"id": answered, "option": 1})
		closed := q.ask(q.artist, key, "@bea")
		q.do(q.bea, "decision.close", M{"id": closed})
		q.do(q.artist, "comment.create", M{"task": key, "kind": "result", "body": "Done."})
		if got := q.world.task(key); got.WaitingOnID != q.owner.ID {
			t.Fatalf("the result handed the task to %q, want the owner, who answered", got.WaitingOnID)
		}
	})
}

// TestClosingIsRefusedWithoutAccessBeforeAnythingIsSaid: a caller whose
// access leaves out the task's project is refused, whatever state the
// question is in, before learning anything of it.
func TestClosingIsRefusedWithoutAccessBeforeAnythingIsSaid(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		ops := q.do(q.owner.ID, "project.create", M{"key": "OPS", "name": "Operations"}).Ref
		key := q.newTask("Boss")
		closed := q.ask(q.artist, key, "@aram")
		q.do(q.owner.ID, "decision.close", M{"id": closed})
		answered := q.ask(q.artist, key, "@aram")
		q.do(q.owner.ID, "decision.pick", M{"id": answered, "option": 1})
		for _, d := range []string{closed, answered} {
			raw, _ := json.Marshal(M{"id": d})
			_, err := q.e.Apply(context.Background(), q.ws.ID, engine.Actor{UserID: q.owner.ID, Projects: []string{ops}}, engine.Change{ID: id.New(), Type: "decision.close", Args: raw})
			var e *engine.Error
			if !errors.As(err, &e) || e.Code != engine.CodeForbidden || strings.Contains(e.Message, key) {
				t.Fatalf("closing %s without access to its project: %v", d, err)
			}
		}
	})
}

// TestClosingAQuestionClearsOnlyTheWaitItSet: closing a question takes away
// the wait its own last write set (on the one asked, or on the asker after
// an answer sent back), and no other.
func TestClosingAQuestionClearsOnlyTheWaitItSet(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		t.Run("the wait for its answer goes", func(t *testing.T) {
			key := q.newTask("Boss")
			d := q.ask(q.artist, key, "@aram")
			q.do(q.owner.ID, "decision.close", M{"id": d})
			if got := q.world.task(key); got.WaitingOnID != "" {
				t.Fatalf("the task still waits on %q", got.WaitingOnID)
			}
		})
		t.Run("the wait on the asker after a send-back goes", func(t *testing.T) {
			key := q.newTask("Arena")
			d := q.ask(q.artist, key, "@aram")
			q.do(q.owner.ID, "decision.pick", M{"id": d, "outcome": "none", "note": "let us talk"})
			if got := q.world.task(key); got.WaitingOnID != q.artist {
				t.Fatalf("after the send-back the task waits on %q", got.WaitingOnID)
			}
			q.do(q.owner.ID, "decision.close", M{"id": d})
			if got := q.world.task(key); got.WaitingOnID != "" {
				t.Fatalf("the task still waits on %q", got.WaitingOnID)
			}
		})
		t.Run("a wait another write set stays", func(t *testing.T) {
			key := q.newTask("Sky")
			d := q.ask(q.artist, key, "@aram")
			q.do(q.artist, "comment.create", M{"task": key, "body": "Have a look.", "waiting_on": "@aram"})
			q.do(q.owner.ID, "decision.close", M{"id": d})
			if got := q.world.task(key); got.WaitingOnID != q.owner.ID {
				t.Fatalf("closing the question took away the hand-off: the task waits on %q", got.WaitingOnID)
			}
		})
	})
}

// TestATaskClosingEmitsItsQuestionsWhole: the questions a task's closing
// settles come in its events with their options, as an answer's do.
func TestATaskClosingEmitsItsQuestionsWhole(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := newQuestions(t, st)
		key := q.newTask("Boss")
		q.ask(q.artist, key, "@aram")
		res := q.do(q.owner.ID, "task.update", M{"id": key, "status": "Done"})
		seen := 0
		for _, ev := range res.Events {
			if ev.Type != "decision.closed" {
				continue
			}
			seen++
			var data struct{ Row core.Decision }
			if err := json.Unmarshal(ev.Data, &data); err != nil {
				t.Fatal(err)
			}
			if len(data.Row.Options) != 2 {
				t.Fatalf("the settled question came as %+v", data.Row)
			}
		}
		if seen != 1 {
			t.Fatalf("%d decision.closed events", seen)
		}
	})
}
