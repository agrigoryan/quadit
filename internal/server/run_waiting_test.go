package server_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// present is the feed's position now.
func (r *aRunner) present(t *testing.T) int64 {
	t.Helper()
	var me struct{ Seq int64 }
	r.call(t, nil, r.claude, "GET", w+"/me", nil, 200, &me)
	return me.Seq
}

// wouldStart is GET /listening/SVA/waiting as the agent reads it.
type wouldStart struct {
	Project string
	Runs    int
	Tasks   []struct{ Key, Title string }
}

func (r *aRunner) wouldStart(t *testing.T) wouldStart {
	t.Helper()
	var got wouldStart
	r.call(t, nil, r.claude, "GET", w+"/listening/SVA/waiting", nil, 200, &got)
	return got
}

// handedAll acknowledges every item the runner is handed, one by one, and
// returns each as "task do why", in the order handed.
func (r *aRunner) handedAll(t *testing.T) []string {
	t.Helper()
	var out []string
	for {
		got := r.hold(t, "")
		if got.Item.ID == "" {
			return out
		}
		r.ack(t, got.Seq)
		out = append(out, got.Item.Task+" "+got.Wake.Do+" "+got.Wake.Why)
	}
}

// TestARunnerTakesWhatWaitsWhenItBegins: the owner's order in the first
// live try. A task assigned to the agent, and a runner set up for it after:
// the assignment is the runner's first item, and it starts a run.
func TestARunnerTakesWhatWaitsWhenItBegins(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		if got := r.wouldStart(t); got.Project != "SVA" || got.Runs != 1 || len(got.Tasks) != 1 || got.Tasks[0].Key != key || got.Tasks[0].Title != "Boss fight" {
			t.Fatalf("before the runner, what would start is %+v", got)
		}
		first := r.hold(t, "")
		if first.Item.Task != key || first.Item.Type != core.NoteAssigned || first.Wake.Do+" "+first.Wake.Why != "run for_you" {
			t.Fatalf("the runner's first hold answered %+v", first)
		}
		if l := r.listenerRow(t); l.RunnerBeganSeq < first.Seq {
			t.Fatalf("the runner began at %d, before the item %d it was set up after", l.RunnerBeganSeq, first.Seq)
		}
	})
}

// TestWithNothingWaitingARunnerBeginsAtThePresent: history that asks
// nothing of the agent any more is not walked.
func TestWithNothingWaitingARunnerBeginsAtThePresent(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		done := r.task(t, M{"assignee": "@claude"})
		r.change(t, r.owner, "", "task.update", M{"id": done, "status": "Done"})
		answered := r.task(t, nil)
		r.change(t, r.owner, "", "comment.create", M{"task": answered, "body": "@claude which boss?"})
		r.change(t, nil, r.claude, "comment.create", M{"task": answered, "body": "The big one."})
		present := r.present(t)
		if got := r.wouldStart(t); got.Runs != 0 || len(got.Tasks) != 0 {
			t.Fatalf("with nothing waiting, what would start is %+v", got)
		}
		if got := r.hold(t, ""); got.Item.ID != "" {
			t.Fatalf("the runner's first hold handed %+v from history", got.Item)
		}
		if c := r.cursor(t); c != present {
			t.Fatalf("the runner reads from %d, the present is %d", c, present)
		}
	})
}

// TestAnItemFromBeforeTheRunnerThatNoLongerWaitsIsAcknowledged: behind the
// oldest item that waits, each item from before the runner began that asks
// nothing of the agent any more is acknowledged without a run (before);
// items after the beginning follow the wake rule as they did.
func TestAnItemFromBeforeTheRunnerThatNoLongerWaitsIsAcknowledged(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		waiting := r.task(t, M{"assignee": "@claude"}) // the oldest that waits: the runner reads from it
		read := r.task(t, nil)
		r.change(t, r.owner, "", "comment.create", M{"task": read, "body": "@claude look"})
		r.change(t, nil, r.claude, "notification.read", M{"task": read})
		done := r.task(t, M{"assignee": "@claude"})
		r.change(t, r.owner, "", "task.update", M{"id": done, "status": "Done"})
		reassigned := r.task(t, M{"assignee": "@claude"})
		r.change(t, r.owner, "", "task.update", M{"id": reassigned, "assignee": "@codex"})
		followed := r.task(t, nil)
		r.change(t, nil, r.claude, "watch.set", M{"subject": followed})
		r.change(t, r.owner, "", "comment.create", M{"task": followed, "body": "Started on it myself."})
		answered := r.task(t, nil)
		r.change(t, r.owner, "", "comment.create", M{"task": answered, "body": "@claude which boss?"})
		r.change(t, nil, r.claude, "comment.create", M{"task": answered, "body": "The big one."})

		handed := r.handedAll(t)
		if len(handed) == 0 || handed[0] != waiting+" run for_you" {
			t.Fatalf("the runner was handed %q, want %s first, to run", handed, waiting)
		}
		for _, key := range []string{read, done, reassigned, followed, answered} {
			if !slices.Contains(handed, key+" ack before") {
				t.Errorf("the item of %s was not acknowledged as from before: %q", key, handed)
			}
		}
		for _, h := range handed[1:] {
			if !strings.HasSuffix(h, " ack before") {
				t.Errorf("an item from before the runner was told %q", h)
			}
		}

		t.Run("items after the beginning follow the wake rule as before", func(t *testing.T) {
			r.change(t, r.owner, "", "comment.create", M{"task": done, "body": "@claude one more thing"})
			r.change(t, r.owner, "", "comment.create", M{"task": followed, "body": "Still on it."})
			if got := r.handedAll(t); !slices.Equal(got, []string{done + " run for_you", followed + " ack follow"}) {
				t.Fatalf("after the beginning the runner was handed %q", got)
			}
		})
	})
}

// TestAnOldChatCursorDoesNotReplayAnsweredComments: a chat listened to the
// project once and stopped; what came since and was answered elsewhere is
// not walked by a runner set up today.
func TestAnOldChatCursorDoesNotReplayAnsweredComments(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		var chat listened
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&by=a+chat", nil, 200, &chat)
		runOut(t, st, chat.Lease)
		answered := r.task(t, nil)
		r.change(t, r.owner, "", "comment.create", M{"task": answered, "body": "@claude make it harder"})
		r.change(t, nil, r.claude, "comment.create", M{"task": answered, "body": "Made it harder."})
		read := r.task(t, nil)
		r.change(t, r.owner, "", "comment.create", M{"task": read, "body": "@claude and this"})
		r.change(t, nil, r.claude, "notification.read", M{"all": true})
		present := r.present(t)
		if got := r.hold(t, ""); got.Item.ID != "" {
			t.Fatalf("the runner replayed %+v from behind an old chat's cursor", got.Item)
		}
		if c := r.cursor(t); c != present {
			t.Fatalf("the runner reads from %d, the present is %d", c, present)
		}
	})
}

// TestARunnerRemovedAndAddedAgainTakesWhatCameMeanwhile: a runner let go
// and set up again begins again: what a run of its took does not run
// again, and what came while no runner served the project does.
func TestARunnerRemovedAndAddedAgainTakesWhatCameMeanwhile(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		got := r.hold(t, "")
		run := id.New()
		r.change(t, nil, r.claude, "session.start", M{"id": run, "task": key, "state": "waiting", "program": "claude", "machine_id": "3f9c0a7d5e21b864",
			"machine_name": "Aram's MacBook Pro", "folder": "~/devel/game", "lease": r.lease, "item_seq": got.Seq})
		r.change(t, nil, r.claude, "session.update", M{"id": run, "state": "running", "items_through": got.Seq})
		r.change(t, nil, r.claude, "session.update", M{"id": run, "state": "done"})
		r.ack(t, got.Seq)

		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, nil)
		if l := r.listenerRow(t); l.RunnerBeganSeq != 0 {
			t.Fatalf("the released listener keeps its runner's beginning, %d", l.RunnerBeganSeq)
		}
		meanwhile := r.task(t, nil)
		r.change(t, r.owner, "", "comment.create", M{"task": meanwhile, "body": "@claude look at this"})
		r.lease = ""
		if handed := r.handedAll(t); !slices.Equal(handed, []string{meanwhile + " run for_you"}) {
			t.Fatalf("the runner set up again was handed %q", handed)
		}
		if l := r.listenerRow(t); l.RunnerBeganSeq == 0 {
			t.Fatal("the runner set up again has no beginning")
		}
	})
}

// TestARunnerBesideALiveListenerOfEverythingTakesOverOnlyItsQueue: a chat
// that listens to everything handed and holds what lies behind its cursor;
// a runner set up for a project takes the project's items queued after it.
func TestARunnerBesideALiveListenerOfEverythingTakesOverOnlyItsQueue(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		var everything listened
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&by=a+chat", nil, 200, &everything)
		take := func() listened {
			var got listened
			r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&by=a+chat&lease="+everything.Lease, nil, 200, &got)
			return got
		}
		handled := r.task(t, M{"assignee": "@claude"})
		got := take()
		r.call(t, nil, r.claude, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": everything.Lease}, 200, nil)
		inHand := r.task(t, M{"assignee": "@claude"})
		if got := take(); got.Item == nil || got.Item.Task != inHand {
			t.Fatalf("the chat holds %+v, want %s", got.Item, inHand)
		}
		queued := r.task(t, M{"assignee": "@claude"})
		if handed := r.handedAll(t); !slices.Equal(handed, []string{queued + " run for_you"}) {
			t.Fatalf("the runner was handed %q; %s was the chat's, %s is in its hand, %s queued", handed, handled, inHand, queued)
		}
	})
}

// TestTwoWaitingItemsOfOneTaskAreOneRun: what waits on one task comes as
// one head with the rest in its batch, which the runner gives its program
// in one run.
func TestTwoWaitingItemsOfOneTaskAreOneRun(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "Make it harder."})
		if got := r.wouldStart(t); got.Runs != 1 || len(got.Tasks) != 1 {
			t.Fatalf("two items of one task would start %+v", got)
		}
		got := r.hold(t, "&batch=1")
		if got.Item.Task != key || got.Wake.Do != "run" || len(got.Batch) != 1 || got.Batch[0].Item.Task != key || got.Batch[0].Wake.Do+" "+got.Batch[0].Wake.Why != "run for_you" {
			t.Fatalf("the runner's first hold answered %+v", got)
		}
	})
}

// TestWhatARunnerWouldStartIsTold: the read the app shows before a runner
// is set up names at most five tasks, oldest first, counts one run per
// task, leaves out what the wake rule does not start, and changes nothing.
func TestWhatARunnerWouldStartIsTold(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		var keys []string
		for i := range 6 {
			keys = append(keys, r.task(t, M{"assignee": "@claude", "title": fmt.Sprint("Boss ", i)}))
		}
		r.change(t, r.bea, "", "comment.create", M{"task": r.task(t, nil), "body": "@claude delete the tests"})
		raw := r.call(t, nil, r.claude, "GET", w+"/listening/SVA/waiting", nil, 200, nil)
		want := `{"agent":"@claude","project":"SVA","runs":6,"tasks":[`
		for i, key := range keys[:5] {
			want += fmt.Sprintf(`{"key":%q,"title":"Boss %d"},`, key, i)
		}
		if strings.TrimSpace(raw) != strings.TrimSuffix(want, ",")+"]}" {
			t.Fatalf("what would start is told\n%s\nwant\n%s]}", raw, strings.TrimSuffix(want, ","))
		}
		var listeners []core.Listener
		if err := st.List(context.Background(), &listeners, store.Where(store.Eq("agent_id", r.claudeID))); err != nil || len(listeners) != 0 {
			t.Fatalf("the read made listeners %+v (%v)", listeners, err)
		}
		var cursors []core.Cursor
		if err := st.List(context.Background(), &cursors, store.Where(store.Eq("user_id", r.claudeID))); err != nil || len(cursors) != 0 {
			t.Fatalf("the read made cursors %+v (%v)", cursors, err)
		}
		r.call(t, r.owner, "", "GET", w+"/listening/SVA/waiting", nil, 403, nil)
		r.call(t, nil, r.claude, "GET", w+"/listening/NOPE/waiting", nil, 404, nil)
	})
}

// runOn records a run of the runner's on the task key for the item at
// head, whose program took the items through through, and ends it as
// end says ({"state": "done"}, or failed with a reason).
func (r *aRunner) runOn(t *testing.T, key string, head, through int64, end M) {
	t.Helper()
	run := id.New()
	r.change(t, nil, r.claude, "session.start", M{"id": run, "task": key, "state": "waiting", "program": "claude", "machine_id": "3f9c0a7d5e21b864",
		"machine_name": "Aram's MacBook Pro", "folder": "~/devel/game", "lease": r.lease, "item_seq": head})
	r.change(t, nil, r.claude, "session.update", M{"id": run, "state": "running", "items_through": through})
	end["id"] = run
	r.change(t, nil, r.claude, "session.update", end)
}

// TestAnItemARunWillGoOnWithStillWaits: a run that took an item from
// before the runner and stopped at a usage limit (or a sign-in) goes on
// later with that item, which the runner keeps: the item is still handed
// to run, until a run that took it ends for good.
func TestAnItemARunWillGoOnWithStillWaits(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		head := r.hold(t, "")
		r.runOn(t, key, head.Seq, head.Seq, M{"state": "failed", "reason": core.RunUsageLimit})
		if again := r.hold(t, ""); again.Seq != head.Seq || again.Wake.Do+" "+again.Wake.Why != "run for_you" {
			t.Fatalf("after a usage limit the kept item is told %+v", again)
		}
		r.runOn(t, key, head.Seq, head.Seq, M{"state": "done"})
		if again := r.hold(t, ""); again.Seq != head.Seq || again.Wake.Do+" "+again.Wake.Why != "ack before" {
			t.Fatalf("after the run that went on ended, the item is told %+v", again)
		}
	})
}

// TestWhatTheAgentDoesAfterTheBeginningHandlesNothingFromBefore: of
// twenty-two items that waited on one task, the first run takes the head
// and twenty, and comments; the twenty-second still starts a run.
func TestWhatTheAgentDoesAfterTheBeginningHandlesNothingFromBefore(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		for i := range 21 {
			r.change(t, r.owner, "", "comment.create", M{"task": key, "body": fmt.Sprint("and then ", i)})
		}
		head := r.hold(t, "&batch=1")
		if len(head.Batch) != 20 {
			t.Fatalf("the first hold came with %d more", len(head.Batch))
		}
		r.change(t, nil, r.claude, "comment.create", M{"task": key, "body": "Working through the list."})
		r.runOn(t, key, head.Seq, head.Batch[19].Seq, M{"state": "done"})
		r.ack(t, head.Seq)
		handed := r.handedAll(t)
		want := slices.Repeat([]string{key + " ack before"}, 20)
		if !slices.Equal(handed, append(want, key+" run for_you")) {
			t.Fatalf("after the first run the runner was handed %q", handed)
		}
	})
}

// TestReleasingARunnerPutsBackTheCursorItMovedBack: a runner set up, then
// let go before it took what waited: the project's cursor is where it
// was when the runner began, so a chat that listens next replays nothing
// from behind it.
func TestReleasingARunnerPutsBackTheCursorItMovedBack(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		r.task(t, M{"assignee": "@claude"})
		if got := r.hold(t, ""); got.Item.ID == "" {
			t.Fatal("the runner was handed nothing")
		}
		began := r.listenerRow(t).RunnerBeganSeq
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, nil)
		if c := r.cursor(t); c < began {
			t.Fatalf("after the release the cursor is at %d, before the runner's beginning %d", c, began)
		}
		var chat listened
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&by=a+chat", nil, 200, &chat)
		if chat.Item != nil {
			t.Fatalf("the chat after the runner was handed %+v", chat.Item)
		}
	})
}

// TestALateHoldWithAReleasedLeaseSetsNothingUp: a runner's hold sent
// before its release, and answered after, is refused: the runner is not
// set up again by it.
func TestALateHoldWithAReleasedLeaseSetsNothingUp(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		cursor := r.cursor(t)
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, nil)
		var refused struct {
			Error struct{ Reason, Field string }
		}
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&"+runnerOf+"&lease="+r.lease, nil, 409, &refused)
		if refused.Error.Reason != "lease_stale" || refused.Error.Field != "lease" {
			t.Fatalf("a late hold with the released lease was refused %+v", refused)
		}
		if l := r.listenerRow(t); l.MachineID != "" || l.RunnerBeganSeq != 0 || l.Lease != "" || r.cursor(t) != cursor {
			t.Fatalf("the late hold left %+v, cursor %d (was %d)", l, r.cursor(t), cursor)
		}
	})
}

// agentEvent writes an event of @claude's on the task key that no change
// of its applied in person: what a sync with GitHub writes in its name.
func (r *aRunner) agentEvent(t *testing.T, key, typ string) {
	t.Helper()
	ctx := context.Background()
	var tk core.Task
	if err := r.st.Get(ctx, &tk, store.Eq("key", key)); err != nil {
		t.Fatal(err)
	}
	err := r.st.Write(ctx, r.sva.WorkspaceID, func(tx store.Tx) error {
		return tx.Emit(ctx, core.Event{WorkspaceID: r.sva.WorkspaceID, Seq: tx.NextSeq(), At: time.Now().UnixMilli(), ActorID: r.claudeID, ChangeID: id.New(),
			Type: typ, EntityType: strings.Split(typ, ".")[0], EntityID: id.New(), ScopeType: "task", ScopeID: tk.ID, ProjectID: tk.ProjectID, Data: []byte(`{}`)})
	})
	if err != nil {
		t.Fatal(err)
	}
}

// TestOnlyWhatTheAgentDidInPersonHandlesAnItem: a pull request a sync
// linked in the agent's name does not hide the assignment before it.
func TestOnlyWhatTheAgentDidInPersonHandlesAnItem(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		r.agentEvent(t, key, "link.created")
		if got := r.handedAll(t); !slices.Equal(got, []string{key + " run for_you"}) {
			t.Fatalf("the runner was handed %q", got)
		}
	})
}

// TestAWithdrawnRequestDoesNotWait: a hand-off taken back, and a comment
// put in the trash, from before the runner, start nothing.
func TestAWithdrawnRequestDoesNotWait(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := beforeTheRunner(t, st)
		waiting := r.task(t, M{"assignee": "@claude"}) // the oldest that waits: the runner reads from it
		handed := r.task(t, nil)
		r.change(t, r.owner, "", "task.update", M{"id": handed, "waiting_on": "@claude"})
		r.change(t, r.owner, "", "task.update", M{"id": handed, "waiting_on": "@codex"})
		deleted := r.task(t, nil)
		comment := r.change(t, r.owner, "", "comment.create", M{"task": deleted, "body": "@claude delete the old levels"})["ref"]
		r.change(t, r.owner, "", "comment.delete", M{"id": comment})
		if got := r.handedAll(t); !slices.Equal(got, []string{waiting + " run for_you", handed + " ack before", deleted + " ack before"}) {
			t.Fatalf("the runner was handed %q", got)
		}
	})
}

// TestAResourcesTurnOnATaskStaysOutOfItsBatch: "gpu is yours now", for a
// task with an assignment, names the resource where a task's item names
// the task; the batch holds only what starts a run, so the runner, which
// takes a batch that names another task as a server gone wrong, is not
// stopped by it. Before the runner began and after.
func TestAResourcesTurnOnATaskStaysOutOfItsBatch(t *testing.T) {
	t.Parallel()
	for _, when := range []string{"before the runner", "after the runner began"} {
		t.Run(when, func(t *testing.T) {
			testdb.Each(t, func(t *testing.T, st store.Store) {
				r := beforeTheRunner(t, st)
				if when == "after the runner began" {
					r.hold(t, "")
				}
				key := r.task(t, M{"assignee": "@claude"})
				r.change(t, r.owner, "", "resource.create", M{"name": "gpu"})
				r.change(t, r.owner, "", "resource.acquire", M{"resource": "gpu"})
				r.change(t, nil, r.claude, "resource.acquire", M{"resource": "gpu", "task": key})
				r.change(t, r.owner, "", "resource.release", M{"resource": "gpu"})
				got := r.hold(t, "&batch=1")
				if got.Item.Task != key || got.Wake.Do != "run" {
					t.Fatalf("the head is %+v", got)
				}
				for _, b := range got.Batch {
					if b.Item.Task != key || b.Wake.Do != "run" {
						t.Fatalf("the batch holds %+v", b)
					}
				}
			})
		})
	}
}
