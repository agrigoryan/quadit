package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// runs is a world where Quadit's runner runs @claude for the project SVA on
// one machine, holding the agent's listener of SVA with the lease
// runnerLease; SVA-1 is a task there.
type runs struct {
	*world
	claude  string // the agent's user id
	project string
}

const (
	runnerLease   = "KQ7MX4PA"
	runnerMachine = "3f9c0a7d5e21b864"
)

func newRuns(t *testing.T, st store.Store) runs {
	t.Helper()
	w := newWorld(t, st)
	r := runs{world: w, claude: w.agent("claude")}
	r.project = w.do(w.owner.ID, "project.create", M{"key": "SVA", "name": "Samurai vs Alien"}).Ref
	w.do(w.owner.ID, "task.create", M{"project": "SVA", "title": "Boss fight"})
	l := core.Listener{WorkspaceID: w.ws.ID, AgentID: r.claude, ProjectID: r.project, Lease: runnerLease, LeaseUntil: time.Now().Add(time.Hour).UnixMilli(),
		HeardAt: time.Now().UnixMilli(), MachineID: runnerMachine, MachineName: "Aram's MacBook Pro", RunnerFolder: "~/devel/game", RunnerProgram: core.ProgramClaude,
		RunnerSeenAt: time.Now().UnixMilli(), RunnerHolds: true}
	if err := st.Insert(context.Background(), l); err != nil {
		t.Fatal(err)
	}
	return r
}

// start is the runner's session.start for a run on task, with what is
// added or changed in more.
func start(task string, more M) M {
	args := M{"id": id.New(), "task": task, "state": "waiting", "program": "claude", "machine_id": runnerMachine, "machine_name": "Aram's MacBook Pro",
		"folder": "~/devel/game", "lease": runnerLease, "item_seq": 1}
	maps.Copy(args, more)
	return args
}

// session is a session's row as stored.
func (r runs) session(sessionID string) core.AgentSession {
	r.t.Helper()
	var s core.AgentSession
	if err := r.db().Get(context.Background(), &s, store.Eq("id", sessionID)); err != nil {
		r.t.Fatal(err)
	}
	return s
}

// running starts a run on SVA-1 and moves it to running.
func (r runs) running() string {
	r.t.Helper()
	run := r.do(r.claude, "session.start", start("SVA-1", nil)).Ref
	r.do(r.claude, "session.update", M{"id": run, "state": "running", "items_through": 1})
	return run
}

// refusedFor checks a refusal's code, field and, when given, reason.
func refusedFor(t *testing.T, err error, code, field, reason string) {
	t.Helper()
	var e *engine.Error
	if !errors.As(err, &e) || e.Code != code || e.Field != field || e.Reason != reason {
		t.Fatalf("refused with %v; want %s, field %s, reason %q", err, code, field, reason)
	}
}

func TestARunIsRecordedOnlyByTheAgentsOwnLogin(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		_, err := r.try(r.owner.ID, "session.start", start("SVA-1", nil))
		refusedFor(t, err, engine.CodeForbidden, "", "")
		_, err = r.try(r.claude, "session.start", start("SVA-1", M{"lease": ""}))
		refusedFor(t, err, engine.CodeInvalid, "machine_id", "")
		_, err = r.try(r.claude, "session.start", start("", nil))
		refusedFor(t, err, engine.CodeInvalid, "task", "")
		_, err = r.try(r.claude, "session.start", M{"task": "SVA-1", "state": "waiting"})
		refusedFor(t, err, engine.CodeInvalid, "state", "")
	})
}

func TestARunStartsOnlyWithTheCurrentLease(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		_, err := r.try(r.claude, "session.start", start("SVA-1", M{"lease": "ZZZZZZZZ"}))
		refusedFor(t, err, engine.CodeConflict, "lease", engine.ReasonLeaseStale)
		// A lease that only ran out, which nobody took, is still the runner's.
		if _, err := st.Update(context.Background(), "listeners", map[string]any{"lease_until": time.Now().Add(-time.Minute).UnixMilli()}, store.Eq("lease", runnerLease)); err != nil {
			t.Fatal(err)
		}
		r.do(r.claude, "session.start", start("SVA-1", nil))
		// The lease of another project's listener is not this one's.
		r.do(r.owner.ID, "project.create", M{"key": "ART", "name": "Art"})
		r.do(r.owner.ID, "task.create", M{"project": "ART", "title": "Sky"})
		_, err = r.try(r.claude, "session.start", start("ART-1", nil))
		refusedFor(t, err, engine.CodeConflict, "lease", engine.ReasonLeaseStale)
	})
}

// TestARunStartsOnlyWithTheRunnersOwnLease: the lease must be the one the
// runner on the machine named holds, not a chat's that took the project
// over, nor one another machine's runner marked.
func TestARunStartsOnlyWithTheRunnersOwnLease(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		for _, held := range []struct {
			name string
			set  map[string]any
		}{
			{"a chat's lease", map[string]any{"runner_holds": false}},
			{"another machine's", map[string]any{"machine_id": "0000000000000000"}},
			{"a lease no runner marked", map[string]any{"machine_id": "", "runner_holds": false}},
		} {
			t.Run(held.name, func(t *testing.T) {
				r := newRuns(t, st)
				if _, err := st.Update(context.Background(), "listeners", held.set, store.Eq("lease", runnerLease)); err != nil {
					t.Fatal(err)
				}
				_, err := r.try(r.claude, "session.start", start("SVA-1", nil))
				refusedFor(t, err, engine.CodeConflict, "lease", engine.ReasonLeaseStale)
			})
		}
	})
}

// TestARunsRefusalsNameNoTaskTheCallerMayNotReach: a start or a stop made
// with a credential kept to other projects is refused for that, before
// anything that would name the task; a stop finds its run by id only.
func TestARunsRefusalsNameNoTaskTheCallerMayNotReach(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		mia := r.person("mia")
		other := r.do(r.owner.ID, "project.create", M{"key": "ART", "name": "Art"}).Ref
		run := r.running()
		apply := func(actor engine.Actor, typ string, args M) error {
			raw, _ := json.Marshal(args)
			_, err := r.e.Apply(context.Background(), r.ws.ID, actor, engine.Change{ID: id.New(), Type: typ, Args: raw})
			return err
		}
		kept := engine.Actor{UserID: r.claude, Projects: []string{other}}
		err := apply(kept, "session.start", start("SVA-1", M{"lease": "ZZZZZZZZ"}))
		refusedFor(t, err, engine.CodeForbidden, "", "")
		r.do(r.owner.ID, "task.delete", M{"id": "SVA-1"})
		err = apply(engine.Actor{UserID: mia, Projects: []string{other}}, "session.stop", M{"id": run})
		refusedFor(t, err, engine.CodeForbidden, "", "")
		if strings.Contains(err.Error(), "SVA") {
			t.Errorf("the refusal names the task: %v", err)
		}
		var e *engine.Error
		err = apply(engine.Actor{UserID: mia}, "session.stop", M{"id": "Boss fight"})
		if !errors.As(err, &e) || e.Code != engine.CodeNotFound || e.Field != "id" || len(e.Allowed) != 0 {
			t.Errorf("a stop by name was refused %v (allowed %v)", err, e)
		}
	})
}

func TestASecondOpenRunOfAnAgentOnATaskIsRefused(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		first := r.do(r.claude, "session.start", start("SVA-1", nil)).Ref
		_, err := r.try(r.claude, "session.start", start("SVA-1", nil))
		refusedFor(t, err, engine.CodeConflict, "task", engine.ReasonRunOpen)
		if !strings.Contains(err.Error(), "on Aram's MacBook Pro (run "+first+")") {
			t.Errorf("the refusal does not name the open run and its machine: %v", err)
		}
		// One that will not start is recorded beside it, and a session the
		// agent records by hand is not a run.
		r.do(r.claude, "session.start", start("SVA-1", M{"state": "not_started", "reason": "run_open"}))
		r.do(r.claude, "session.start", M{"task": "SVA-1", "title": "By hand"})
		r.do(r.claude, "session.update", M{"id": first, "state": "failed", "reason": "interrupted"})
		r.do(r.claude, "session.start", start("SVA-1", nil))
	})
}

func TestAResentStartAnswersAsTheFirst(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		raw, _ := json.Marshal(start("SVA-1", nil))
		ch := engine.Change{ID: id.New(), Type: "session.start", Args: raw}
		first, err := r.e.Apply(context.Background(), r.ws.ID, engine.Actor{UserID: r.claude}, ch)
		if err != nil {
			t.Fatal(err)
		}
		// Its answer was lost on the way: the runner sends it again.
		again, err := r.e.Apply(context.Background(), r.ws.ID, engine.Actor{UserID: r.claude}, ch)
		if err != nil {
			t.Fatalf("the resent start was refused: %v", err)
		}
		if !again.Duplicate || again.Ref != first.Ref || again.Seq != first.Seq {
			t.Fatalf("the resent start answered %+v; the first %+v", again, first)
		}
	})
}

func TestARunStartsWaitingOrNotStarted(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		for _, state := range []string{"running", "done", ""} {
			_, err := r.try(r.claude, "session.start", start("SVA-1", M{"state": state}))
			refusedFor(t, err, engine.CodeInvalid, "state", "")
		}
		s := r.session(r.do(r.claude, "session.start", start("SVA-1", M{"program_session": id.New()})).Ref)
		if s.State != core.AgentSessionWaiting || s.MachineID != runnerMachine || s.MachineName != "Aram's MacBook Pro" || s.Folder != "~/devel/game" ||
			s.Program != core.ProgramClaude || s.ProgramSession == "" || s.ItemSeq != 1 || s.EndedAt != 0 || s.AcceptedAt != 0 || s.ItemsThrough != 0 {
			t.Fatalf("a waiting run is stored as %+v", s)
		}
	})
}

func TestANotStartedRunEndsAtOnce(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		s := r.session(r.do(r.claude, "session.start", start("SVA-1", M{"state": "not_started", "reason": "not_responsible"})).Ref)
		if s.State != core.AgentSessionNotStarted || s.Reason != core.RunNotResponsible || s.EndedAt == 0 || s.EndedAt != s.StartedAt {
			t.Fatalf("a run that did not start is stored as %+v", s)
		}
		_, err := r.try(r.claude, "session.update", M{"id": s.ID, "state": "running"})
		refusedFor(t, err, engine.CodeInvalid, "state", "")
	})
}

func TestTheServerStampsWhenTheProgramTookThePrompt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		if s := r.session(run); s.State != core.AgentSessionRunning || s.AcceptedAt == 0 || s.AcceptedAt < s.StartedAt {
			t.Fatalf("a run its program took is stored as %+v", s)
		}
	})
}

func TestCoverageIsTheRunsOwnItemWhenNotSaid(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.do(r.claude, "session.start", start("SVA-1", M{"item_seq": 40})).Ref
		r.do(r.claude, "session.update", M{"id": run, "state": "running"})
		if s := r.session(run); s.ItemsThrough != 40 {
			t.Fatalf("coverage is %d", s.ItemsThrough)
		}
	})
}

func TestARunIsStoppedOnlyWhenAStopWasAsked(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		_, err := r.try(r.claude, "session.update", M{"id": run, "state": "stopped"})
		refusedFor(t, err, engine.CodeInvalid, "state", "")
		r.do(r.owner.ID, "session.stop", M{"id": run})
		r.do(r.claude, "session.update", M{"id": run, "state": "stopped"})
	})
}

func TestARunIDInUseIsRefusedAsInUse(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.do(r.claude, "session.start", start("SVA-1", nil)).Ref
		_, err := r.try(r.claude, "session.start", start("SVA-1", M{"id": run}))
		refusedFor(t, err, engine.CodeConflict, "", engine.ReasonInUse)
	})
}

func TestCoverageIsWrittenOnlyWithTheMoveToRunning(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.do(r.claude, "session.start", start("SVA-1", M{"item_seq": 40})).Ref
		_, err := r.try(r.claude, "session.update", M{"id": run, "items_through": 45})
		refusedFor(t, err, engine.CodeInvalid, "items_through", "")
		_, err = r.try(r.claude, "session.update", M{"id": run, "state": "running", "items_through": 39})
		refusedFor(t, err, engine.CodeInvalid, "items_through", "")
		r.do(r.claude, "session.update", M{"id": run, "state": "running", "items_through": 45})
		if s := r.session(run); s.ItemsThrough != 45 {
			t.Fatalf("coverage is %d", s.ItemsThrough)
		}
		_, err = r.try(r.claude, "session.update", M{"id": run, "state": "running", "items_through": 50})
		refusedFor(t, err, engine.CodeInvalid, "items_through", "")
	})
}

func TestAnEndedRunDoesNotChangeStateAgain(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		r.do(r.claude, "session.update", M{"id": run, "state": "done", "summary": "Fought."})
		for _, state := range []string{"running", "failed", "stopped", "waiting"} {
			_, err := r.try(r.claude, "session.update", M{"id": run, "state": state, "reason": map[string]string{"failed": "interrupted"}[state]})
			refusedFor(t, err, engine.CodeInvalid, "state", "")
			if !strings.Contains(err.Error(), "this run ended: it cannot become "+state) {
				t.Errorf("the refusal says %v", err)
			}
		}
		_, err := r.try(r.claude, "session.update", M{"id": run, "add_steps": []M{{"tool": "Bash"}}})
		refusedFor(t, err, engine.CodeInvalid, "add_steps", "")
		// Links and a summary still come.
		r.do(r.claude, "session.update", M{"id": run, "add_links": []string{"https://example.com/pr/1"}, "summary": "Fought well."})
		if s := r.session(run); s.State != core.AgentSessionDone || s.Summary != "Fought well." {
			t.Fatalf("the ended run is %+v", s)
		}
	})
}

func TestARunIsDoneOnlyAfterRunning(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.do(r.claude, "session.start", start("SVA-1", nil)).Ref
		_, err := r.try(r.claude, "session.update", M{"id": run, "state": "done"})
		refusedFor(t, err, engine.CodeInvalid, "state", "")
		r.do(r.claude, "session.update", M{"id": run, "state": "running", "items_through": 1})
		_, err = r.try(r.claude, "session.update", M{"id": run, "state": "waiting"})
		refusedFor(t, err, engine.CodeInvalid, "state", "")
		r.do(r.claude, "session.update", M{"id": run, "state": "done"})
		if s := r.session(run); s.State != core.AgentSessionDone || s.EndedAt == 0 {
			t.Fatalf("the run is %+v", s)
		}
	})
}

func TestAReasonMustFitItsState(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		_, err := r.try(r.claude, "session.start", start("SVA-1", M{"state": "not_started"}))
		refusedFor(t, err, engine.CodeInvalid, "reason", "")
		_, err = r.try(r.claude, "session.start", start("SVA-1", M{"reason": "idle"}))
		refusedFor(t, err, engine.CodeInvalid, "reason", "")
		run := r.do(r.claude, "session.start", start("SVA-1", M{"reason": "folder_busy"})).Ref
		r.do(r.claude, "session.update", M{"id": run, "reason": "session_open"})
		r.do(r.claude, "session.update", M{"id": run, "reason": ""})
		_, err = r.try(r.claude, "session.update", M{"id": run, "state": "failed"})
		refusedFor(t, err, engine.CodeInvalid, "reason", "")
		_, err = r.try(r.claude, "session.update", M{"id": run, "state": "running", "reason": "folder_busy"})
		refusedFor(t, err, engine.CodeInvalid, "reason", "")
		_, err = r.try(r.claude, "session.update", M{"id": run, "state": "failed", "reason": "start_failed", "resets_at": 1})
		refusedFor(t, err, engine.CodeInvalid, "resets_at", "")
		r.do(r.claude, "session.update", M{"id": run, "state": "failed", "reason": "usage_limit", "resets_at": 1732471200000})
		if s := r.session(run); s.State != core.AgentSessionFailed || s.Reason != core.RunUsageLimit || s.ResetsAt != 1732471200000 {
			t.Fatalf("the run is %+v", s)
		}
		// A session the agent records by hand has no reasons.
		byHand := r.do(r.claude, "session.start", M{"task": "SVA-1"}).Ref
		_, err = r.try(r.claude, "session.update", M{"id": byHand, "state": "failed", "reason": "idle"})
		refusedFor(t, err, engine.CodeInvalid, "reason", "")
	})
}

// updated is the session.updated event a change made.
func updated(t *testing.T, res *engine.Result) core.EventData {
	t.Helper()
	for _, ev := range res.Events {
		if ev.Type == "session.updated" {
			data, err := ev.Payload()
			if err != nil {
				t.Fatal(err)
			}
			return data
		}
	}
	t.Fatalf("no session.updated in %+v", res.Events)
	return core.EventData{}
}

// changes runs a change as userID, keeping the events it made.
func (r runs) changes(userID, typ string, args any) *engine.Result {
	r.t.Helper()
	raw, _ := json.Marshal(args)
	res, err := r.e.Batch(context.Background(), r.ws.ID, engine.Actor{UserID: userID}, []engine.Change{{ID: id.New(), Type: typ, Args: raw}}, false)
	if err != nil {
		r.t.Fatal(err)
	}
	return res[0]
}

func TestAnUpdateThatOnlyAppendsIsAnUpdate(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		before := r.session(run).UpdatedSeq
		res := r.changes(r.claude, "session.update", M{"id": run, "add_steps": []M{{"tool": "Bash", "text": "Run the tests", "at": 1732460400000}}})
		data := updated(t, res)
		if len(data.Appended["steps"]) != 1 || len(data.Changes) != 0 {
			t.Fatalf("an update that only appends emitted %+v", data)
		}
		if s := r.session(run); s.UpdatedSeq <= before || s.UpdatedSeq != res.Seq {
			t.Fatalf("the row's seq is %d, the event's %d, before %d", s.UpdatedSeq, res.Seq, before)
		}
	})
}

func TestStepsAreAppendedNotResent(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		r.do(r.claude, "session.update", M{"id": run, "add_steps": []M{{"tool": "Read", "text": "src/boss.go"}}})
		long := strings.Repeat("é", 250)
		data := updated(t, r.changes(r.claude, "session.update", M{"id": run, "add_steps": []M{{"tool": "Bash", "text": long, "at": 5}}, "add_links": []string{"https://example.com"}}))
		if _, whole := data.Changes["steps"]; whole || len(data.Appended["steps"]) != 1 || len(data.Appended["links"]) != 1 {
			t.Fatalf("the event carries %+v", data)
		}
		var step struct {
			Tool, Text string
			At         int64
		}
		if err := json.Unmarshal(data.Appended["steps"][0], &step); err != nil {
			t.Fatal(err)
		}
		if step.Tool != "Bash" || step.At != 5 || len([]rune(step.Text)) != 200 || !strings.HasSuffix(step.Text, "…") {
			t.Fatalf("the step kept is %+v (%d characters)", step, len([]rune(step.Text)))
		}
		var steps []json.RawMessage
		if err := json.Unmarshal(r.session(run).Steps, &steps); err != nil || len(steps) != 2 {
			t.Fatalf("the row keeps %d steps: %v", len(steps), err)
		}
		_, err := r.try(r.claude, "session.update", M{"id": run, "add_steps": []string{"a string"}})
		refusedFor(t, err, engine.CodeInvalid, "add_steps", "")
		var many []M
		for i := range 51 {
			many = append(many, M{"tool": fmt.Sprint("t", i)})
		}
		_, err = r.try(r.claude, "session.update", M{"id": run, "add_steps": many})
		refusedFor(t, err, engine.CodeInvalid, "add_steps", "")
	})
}

func TestStepsPastTheCapDropTheOldest(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		n := 0
		var last core.EventData
		for range 5 {
			var batch []M
			for range 45 {
				batch = append(batch, M{"tool": fmt.Sprint("step ", n)})
				n++
			}
			last = updated(t, r.changes(r.claude, "session.update", M{"id": run, "add_steps": batch}))
		}
		s := r.session(run)
		var steps []struct{ Tool string }
		if err := json.Unmarshal(s.Steps, &steps); err != nil {
			t.Fatal(err)
		}
		if len(steps) != 200 || s.StepsDropped != 25 || steps[0].Tool != "step 25" || steps[199].Tool != "step 224" {
			t.Fatalf("kept %d steps from %q, dropped %d", len(steps), steps[0].Tool, s.StepsDropped)
		}
		if ch := last.Changes["steps_dropped"]; ch.To != float64(25) || len(last.Appended["steps"]) != 45 {
			t.Fatalf("the last event carries %+v", last)
		}
	})
}

func TestAHandRecordedSessionKeepsItsStepForms(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		byHand := r.do(r.claude, "session.start", M{"task": "SVA-1", "title": "Drawing"}).Ref
		var steps []any
		for range 210 {
			steps = append(steps, "drew a line")
		}
		steps = append(steps, M{"anything": []int{1, 2}}, 7)
		data := updated(t, r.changes(r.claude, "session.update", M{"id": byHand, "add_steps": steps}))
		if len(data.Appended["steps"]) != 212 {
			t.Fatalf("the event carries %d steps", len(data.Appended["steps"]))
		}
		var kept []json.RawMessage
		if err := json.Unmarshal(r.session(byHand).Steps, &kept); err != nil || len(kept) != 212 || string(kept[211]) != "7" {
			t.Fatalf("the row keeps %d steps: %v", len(kept), err)
		}
		r.do(r.claude, "session.update", M{"id": byHand, "state": "done"})
		r.do(r.claude, "session.update", M{"id": byHand, "state": "running"})
	})
}

func TestAStopIsAskedByAnyMemberWhoMayChangeTheTask(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		mia := r.person("mia")
		run := r.running()
		data := updated(t, r.changes(mia, "session.stop", M{"id": run}))
		s := r.session(run)
		if s.State != core.AgentSessionRunning || s.StopRequestedBy != mia || s.StopRequestedAt == 0 || len(data.Changes) != 2 {
			t.Fatalf("a stop asked made %+v; the event %+v", s, data)
		}
		// The runner ends it.
		r.do(r.claude, "session.update", M{"id": run, "state": "stopped"})
		if s := r.session(run); s.State != core.AgentSessionStopped || s.EndedAt == 0 {
			t.Fatalf("the run is %+v", s)
		}
	})
}

func TestAStopIsAskedNotByAMemberWhoMayOnlyRead(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		mia := r.person("mia")
		other := r.do(r.owner.ID, "project.create", M{"key": "ART", "name": "Art"}).Ref
		run := r.running()
		raw, _ := json.Marshal(M{"id": run})
		try := func(actor engine.Actor) error {
			_, err := r.e.Apply(context.Background(), r.ws.ID, actor, engine.Change{ID: id.New(), Type: "session.stop", Args: raw})
			return err
		}
		for _, when := range []string{"while it runs", "when it would change nothing"} {
			t.Run(when, func(t *testing.T) {
				refusedFor(t, try(engine.Actor{UserID: mia, ReadOnly: true}), engine.CodeForbidden, "", "")
				refusedFor(t, try(engine.Actor{UserID: mia, Projects: []string{other}}), engine.CodeForbidden, "", "")
				if s := r.session(run); s.StopRequestedAt != 0 {
					t.Fatalf("a refused stop was recorded: %+v", s)
				}
			})
			r.do(r.claude, "session.update", M{"id": run, "state": "done"})
		}
	})
}

// TestAStopThatChangesNothingIsCheckedAsOneThatDoes: an agent's stop on a
// task given to agents by someone who lost their access is refused, even
// when the run ended already.
func TestAStopThatChangesNothingIsCheckedAsOneThatDoes(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		mia := r.person("mia")
		codex := r.agent("codex")
		key := r.do(mia, "task.create", M{"project": "SVA", "title": "Menu", "assignee": "@claude"}).Key
		run := r.do(r.claude, "session.start", start(key, nil)).Ref
		r.do(r.claude, "session.update", M{"id": run, "state": "failed", "reason": "interrupted"})
		r.do(r.owner.ID, "member.update", M{"id": mia, "suspended": true})
		r.refused(engine.CodeForbidden, codex, "session.stop", M{"id": run})
	})
}

func TestAStopAskedTwiceIsOnce(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		r.do(r.owner.ID, "session.stop", M{"id": run})
		first := r.session(run)
		if res := r.changes(r.person("mia"), "session.stop", M{"id": run}); len(res.Events) != 0 || res.Ref != run {
			t.Fatalf("a second stop made %+v", res)
		}
		if s := r.session(run); s.StopRequestedBy != first.StopRequestedBy || s.UpdatedSeq != first.UpdatedSeq {
			t.Fatalf("a second stop changed %+v to %+v", first, s)
		}
	})
}

func TestAStopOfAnEndedRunChangesNothing(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		r.do(r.claude, "session.update", M{"id": run, "state": "done"})
		if res := r.changes(r.owner.ID, "session.stop", M{"id": run}); len(res.Events) != 0 {
			t.Fatalf("a stop of an ended run made %+v", res.Events)
		}
		if s := r.session(run); s.State != core.AgentSessionDone || s.StopRequestedAt != 0 {
			t.Fatalf("the run is %+v", s)
		}
	})
}

func TestAStopOfASessionQuaditDidNotStartIsRefused(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		byHand := r.do(r.claude, "session.start", M{"task": "SVA-1"}).Ref
		e := r.refused(engine.CodeInvalid, r.owner.ID, "session.stop", M{"id": byHand})
		if e.Field != "id" || !strings.Contains(e.Message, "not started by Quadit") {
			t.Fatalf("refused with %v", e)
		}
	})
}

func TestAStopOfARunWhoseMachineIsAwayEndsItAtOnce(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		for _, away := range []struct {
			name string
			set  map[string]any
		}{
			{"its lease ran out", map[string]any{"lease_until": time.Now().Add(-time.Second).UnixMilli()}},
			{"a chat holds the project", map[string]any{"runner_holds": false}},
			{"another machine holds it", map[string]any{"machine_id": "0000000000000000"}},
		} {
			t.Run(away.name, func(t *testing.T) {
				r := newRuns(t, st)
				run := r.running()
				if _, err := st.Update(context.Background(), "listeners", away.set, store.Eq("lease", runnerLease)); err != nil {
					t.Fatal(err)
				}
				r.do(r.owner.ID, "session.stop", M{"id": run})
				s := r.session(run)
				if s.State != core.AgentSessionStopped || s.EndedAt == 0 || s.StopRequestedBy != r.owner.ID {
					t.Fatalf("the run is %+v", s)
				}
				// The runner, back, cannot end it otherwise.
				_, err := r.try(r.claude, "session.update", M{"id": run, "state": "done"})
				refusedFor(t, err, engine.CodeInvalid, "state", "")
			})
		}
	})
}

func TestTheProgramSessionIsAUUIDSetOnceOrFreshAfterALostOne(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		_, err := r.try(r.claude, "session.start", start("SVA-1", M{"program_session": "not-a-uuid"}))
		refusedFor(t, err, engine.CodeInvalid, "program_session", "")
		run := r.do(r.claude, "session.start", start("SVA-1", M{"program": "codex"})).Ref
		first, second := id.New(), id.New()
		_, err = r.try(r.claude, "session.update", M{"id": run, "program_session": strings.ToUpper(first)})
		refusedFor(t, err, engine.CodeInvalid, "program_session", "")
		r.do(r.claude, "session.update", M{"id": run, "program_session": first})
		r.do(r.claude, "session.update", M{"id": run, "program_session": first})
		_, err = r.try(r.claude, "session.update", M{"id": run, "program_session": second})
		refusedFor(t, err, engine.CodeInvalid, "program_session", "")
		_, err = r.try(r.claude, "session.update", M{"id": run, "fresh": true})
		refusedFor(t, err, engine.CodeInvalid, "fresh", "")
		r.do(r.claude, "session.update", M{"id": run, "program_session": second, "fresh": true})
		if s := r.session(run); s.ProgramSession != second {
			t.Fatalf("the program session is %q", s.ProgramSession)
		}
	})
}

func TestACommentFromARunIsMarkedWithItsSession(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		comment := r.do(r.claude, "comment.create", M{"task": "SVA-1", "body": "The boss fight works.", "session": run}).Ref
		if cm := r.comment(comment); cm.SessionID != run {
			t.Fatalf("the comment is %+v", cm)
		}
		if cm := r.comment(r.do(r.claude, "comment.create", M{"task": "SVA-1", "body": "And more."}).Ref); cm.SessionID != "" {
			t.Fatalf("a comment of the agent's own is marked %q", cm.SessionID)
		}
	})
}

func TestACommentFromARunIsMarkedOnlyByTheAgentOfThatSession(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		run := r.running()
		r.do(r.owner.ID, "task.create", M{"project": "SVA", "title": "Menu"})
		codex := r.agent("codex")
		page := r.do(r.owner.ID, "doc.create", M{"title": "Notes"}).Ref
		for _, refused := range []struct {
			name  string
			actor string
			args  M
		}{
			{"another agent", codex, M{"task": "SVA-1"}},
			{"a person", r.owner.ID, M{"task": "SVA-1"}},
			{"on another task", r.claude, M{"task": "SVA-2"}},
			{"on a page", r.claude, M{"doc": page}},
			{"a run that is not there", r.claude, M{"task": "SVA-1", "session": id.New()}},
			{"not an id", r.claude, M{"task": "SVA-1", "session": "run-1"}},
			{"a session recorded by hand", r.claude, M{"task": "SVA-1", "session": r.do(r.claude, "session.start", M{"task": "SVA-1"}).Ref}},
		} {
			t.Run(refused.name, func(t *testing.T) {
				args := M{"body": "Done.", "session": run}
				maps.Copy(args, refused.args)
				if e := r.refused(engine.CodeInvalid, refused.actor, "comment.create", args); e.Field != "session" {
					t.Fatalf("refused with %v", e)
				}
			})
		}
	})
}

func TestACommentFromARunMakesNoMentionItems(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRuns(t, st)
		mia := r.person("mia")
		r.do(r.owner.ID, "watch.set", M{"subject": "SVA-1"})
		run := r.running()
		comment := r.do(r.claude, "comment.create", M{"task": "SVA-1", "body": "@mia and @aram: the fight works.", "session": run}).Ref
		for _, n := range r.inbox(mia) {
			if n.EntityID == comment {
				t.Fatalf("a run's last message put %+v in a mentioned member's inbox", n)
			}
		}
		var told []core.Notification
		for _, n := range r.inbox(r.owner.ID) {
			if n.EntityID == comment {
				told = append(told, n)
			}
		}
		if len(told) != 1 || told[0].Type != core.NoteComment || told[0].Addressed {
			t.Fatalf("a follower was told %+v", told)
		}
	})
}
