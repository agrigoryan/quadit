//go:build unix

package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/fakeagent"
)

func TestAnAnswerWithoutWakeOrOfAnotherProjectPausesTheEntry(t *testing.T) {
	for _, old := range []string{"no_wake", "bad_wake", "other_project"} {
		t.Run(old, func(t *testing.T) {
			rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
			rt.f.set(func(f *fakeQuadit) { f.oldServer = old })
			rt.f.addItem(fakeItem{Task: "SVA-12"})
			rt.serve()
			rt.eventually("the entry paused", func() bool {
				st := readStatus(rt.files.status()).Entries[rt.entry.ID]
				return st.State == statusPaused && st.Pause == core.PauseServerOld
			})
			rt.eventually("a hold saying the pause", func() bool {
				for _, q := range rt.f.holdList() {
					if q.Get("paused") == core.PauseServerOld && q.Get("wait") == "1" {
						return true
					}
				}
				return false
			})
			if len(rt.f.allRuns()) != 0 || len(rt.records()) != 0 || len(rt.f.ackList()) != 0 {
				t.Fatal("an answer the runner does not understand was acted on")
			}
			if !strings.Contains(rt.out.String(), "paused: this Quadit server cannot run agents yet: update it") {
				t.Fatalf("said:\n%s", rt.out)
			}
		})
	}
}

func TestNoProgramStartsBeforeTheServerConfirmedTheRun(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.set(func(f *fakeQuadit) { f.changesAway = true })
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.eventually("the item received", func() bool { return strings.Contains(rt.out.String(), "received #") })
	time.Sleep(100 * time.Millisecond)
	if len(rt.records()) != 0 {
		t.Fatal("the program started before the server confirmed the run")
	}
	rt.f.set(func(f *fakeQuadit) { f.changesAway = false })
	rt.ended(0)
	if len(rt.records()) != 1 || len(rt.changesOf("session.start")) != 1 {
		t.Fatalf("starts %d, session.start %d", len(rt.records()), len(rt.changesOf("session.start")))
	}
}

func TestALostAnswerToSessionStartIsResentWithTheSameID(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.set(func(f *fakeQuadit) { f.lose["session.start"] = 1 })
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.ended(0)
	starts := rt.changesOf("session.start")
	if len(starts) != 1 || rt.f.sentCount(starts[0].ID) != 2 || starts[0].ID != changeID(row["id"].(string), writeStart, 0) {
		t.Fatalf("session.start applied %d times, its id sent %d times", len(starts), rt.f.sentCount(starts[0].ID))
	}
	if len(rt.f.allRuns()) != 1 || len(rt.records()) != 1 {
		t.Fatalf("%d rows, %d starts", len(rt.f.allRuns()), len(rt.records()))
	}
}

func TestAStaleLeaseAtStartStartsNothing(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.set(func(f *fakeQuadit) { f.staleStart = true })
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.eventually("two starts refused", func() bool { return rt.f.count(func(f *fakeQuadit) int { return f.staleStarts }) >= 2 })
	// A chat takes the project: no hold succeeds, so no new start is
	// queued; the one in flight is refused too. The outbox then empties,
	// or a refused start stayed in it.
	rt.f.set(func(f *fakeQuadit) { f.chat = true })
	outbox := filepath.Join(rt.files.entry(rt.entry.ID), "outbox")
	rt.eventually("every refused start taken out of the outbox", func() bool {
		files, _ := filepath.Glob(filepath.Join(outbox, "*.json"))
		return len(files) == 0 && readStatus(rt.files.status()).Entries[rt.entry.ID].State == statusAside
	})
	if len(rt.f.allRuns()) != 0 || len(rt.records()) != 0 || len(rt.f.ackList()) != 0 {
		t.Fatal("a run refused its lease started something, made a row or acknowledged its head")
	}
}

func TestAnOpenRunOfThisMachineWithNoJournalIsClosed(t *testing.T) {
	open := func(machineID string) map[string]any {
		return map[string]any{"id": "0199dddd-0000-7000-8000-000000000001", "task": "SVA-12", "agent_id": fakeAgentID, "state": "waiting", "machine_id": machineID, "machine_name": "Old"}
	}
	t.Run("this machine's is closed and the run goes on", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.set(func(f *fakeQuadit) { f.runs = append(f.runs, open(testMachine.ID)) })
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.eventually("the new run done", func() bool { return rt.runState(1) == core.AgentSessionDone })
		if old := rt.f.allRuns()[0]; old["state"] != core.AgentSessionFailed || old["reason"] != core.RunInterrupted {
			t.Fatalf("the orphan reads %v", old)
		}
	})
	t.Run("another machine's makes the item not started", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.set(func(f *fakeQuadit) { f.runs = append(f.runs, open("aaaaaaaaaaaaaaaa")) })
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.acked(head)
		row := rt.ended(1)
		if row["state"] != core.AgentSessionNotStarted || row["reason"] != core.RunOpenElsewhere || len(rt.records()) != 0 {
			t.Fatalf("the item's row %v, %d starts", row, len(rt.records()))
		}
	})
}

func TestCoverageIsWhatTheProgramTook(t *testing.T) {
	t.Run("the head and the items its prompt carried are covered once it ran", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"), claudeDone("again"))
		rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Through: 900} }) // what the task covers is known
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		second := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.acked(second)
		if len(rt.records()) != 1 || len(rt.f.allRuns()) != 1 {
			t.Fatalf("%d starts, %d rows: the second item was covered", len(rt.records()), len(rt.f.allRuns()))
		}
		if p := rt.records()[0].Stdin; !strings.Contains(p, "#1001") || !strings.Contains(p, "#1002") {
			t.Fatalf("the prompt does not carry both items:\n%s", p)
		}
		if rt.f.allRuns()[0]["items_through"] != float64(second) {
			t.Fatalf("items_through %v", rt.f.allRuns()[0]["items_through"])
		}
	})
	t.Run("an item of the batch refused comes up and gets its row", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		refused := rt.f.addItem(fakeItem{Task: "SVA-12", By: "@mia", Do: wakeRefuse, Why: core.RunNotResponsible})
		rt.serve()
		rt.acked(refused)
		row := rt.ended(1)
		if row["state"] != core.AgentSessionNotStarted || strings.Contains(rt.records()[0].Stdin, "#1002") {
			t.Fatalf("the refused item: %v; prompt:\n%s", row, rt.records()[0].Stdin)
		}
	})
	t.Run("a run stopped before its program took the prompt covers nothing", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, []fakeagent.Step{claudeInit(), {UntilSignal: []string{"{}"}}}, claudeDone("done"))
		rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Through: 900} })
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		carried := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		// The barrier: the program has the prompt with both items, and has
		// not taken it.
		rt.eventually("the program started", func() bool { return len(rt.records()) == 1 })
		if !strings.Contains(rt.records()[0].Stdin, "#"+strconv.FormatInt(carried, 10)) {
			t.Fatalf("the first prompt does not carry the second item:\n%s", rt.records()[0].Stdin)
		}
		rt.f.stopRun(rt.f.allRuns()[0]["id"].(string))
		if row := rt.ended(0); row["state"] != core.AgentSessionStopped {
			t.Fatalf("the run ended %v", row)
		}
		rt.ended(1)
		if !strings.Contains(rt.records()[1].Stdin, "#"+strconv.FormatInt(carried, 10)) {
			t.Fatalf("an item the stopped run carried was taken as covered:\n%s", rt.records()[1].Stdin)
		}
	})
	t.Run("the server's record covers when the entry has none", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.f.set(func(f *fakeQuadit) {
			f.runs = append(f.runs, map[string]any{"id": "0199dddd-0000-7000-8000-000000000002", "task": "SVA-12", "agent_id": fakeAgentID,
				"state": "done", "accepted_at": 1, "items_through": head})
		})
		rt.serve()
		rt.acked(head)
		time.Sleep(50 * time.Millisecond)
		if len(rt.records()) != 0 {
			t.Fatal("an item the server says a program took was run again")
		}
	})
}

func TestAnItemFromSomeoneElseIsRecordedAsNotStartedAndAcknowledged(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	head := rt.f.addItem(fakeItem{Task: "SVA-12", By: "@mia", Do: wakeRefuse, Why: core.RunNotResponsible})
	rt.serve()
	rt.acked(head)
	row := rt.ended(0)
	id := row["id"].(string)
	if row["state"] != core.AgentSessionNotStarted || row["reason"] != core.RunNotResponsible || id != itemRunID(rt.f.itemList()[0].ID) {
		t.Fatalf("the row %v", row)
	}
	if rt.changesOf("session.start")[0].ID != id || len(rt.records()) != 0 {
		t.Fatal("a refused item's row is made under the item's id, and nothing starts")
	}
	if !strings.Contains(rt.out.String(), "SVA-12 @claude: not started: @mia is not the person responsible for @claude") {
		t.Fatalf("said:\n%s", rt.out)
	}
}

// pauseUntil gives the entry a usage-limit pause in its state.json, as a
// runner that stopped kept it.
func (rt *runTest) pauseUntil(until time.Time) {
	rt.t.Helper()
	dir := rt.files.entry(rt.entry.ID)
	_ = os.MkdirAll(dir, 0o700)
	writeJSON(rt.t, filepath.Join(dir, "state.json"), entryState{Server: rt.entry.Server, WorkspaceID: rt.entry.WorkspaceID, AgentID: rt.entry.AgentID,
		Program: rt.entry.Program, Folder: rt.entry.Folder, Tasks: map[string]*taskState{},
		Pause: &pauseState{Reason: core.PauseUsageLimit, Until: until.UnixMilli(), BackoffMinutes: 30}})
}

func TestAPausedEntryKeepsItsLeaseAndActsOnNothing(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	until := rt.clock.Now().Add(time.Hour)
	rt.pauseUntil(until)
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.eventually("holds saying the pause", func() bool {
		n := 0
		for _, q := range rt.f.holdList() {
			if q.Get("paused") == core.PauseUsageLimit && q.Get("paused_until") == strconv.FormatInt(until.UnixMilli(), 10) && q.Get("wait") == "1" {
				n++
			}
		}
		return n >= 3
	})
	if len(rt.f.allRuns()) != 0 || len(rt.f.ackList()) != 0 || len(rt.records()) != 0 {
		t.Fatal("a paused entry acted on its head")
	}
	rt.clock.jump(61 * time.Minute)
	rt.ended(0)
}

func TestAPauseSurvivesARestart(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.pauseUntil(rt.clock.Now().Add(time.Hour))
	rt.serve()
	rt.eventually("paused", func() bool { return readStatus(rt.files.status()).Entries[rt.entry.ID].State == statusPaused })
	rt.stop()
	rt.serve()
	rt.eventually("paused again, until the same time", func() bool {
		st := readStatus(rt.files.status()).Entries[rt.entry.ID]
		return strings.Count(rt.out.String(), "serving 1 entry") == 2 && st.State == statusPaused && st.Until != ""
	})
	time.Sleep(100 * time.Millisecond)
	if len(rt.records()) != 0 || len(rt.f.allRuns()) != 0 {
		t.Fatalf("after a restart a paused entry ran its head: %d starts", len(rt.records()))
	}
}

func TestNotSignedInPausesTheEntryAndKeepsTheHead(t *testing.T) {
	t.Run("found at the entry's start", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		signIn := filepath.Join(rt.dir, "signed-in")
		t.Setenv("FAKEAGENT_SIGNIN", signIn)
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.eventually("paused", func() bool {
			return readStatus(rt.files.status()).Entries[rt.entry.ID].Pause == core.PauseNotSignedIn
		})
		if !strings.Contains(rt.out.String(), "paused: Claude Code is not signed in (claude auth login)") {
			t.Fatalf("said:\n%s", rt.out)
		}
		_ = os.WriteFile(signIn, nil, 0o600)
		rt.acked(head)
		rt.ended(0)
	})
	t.Run("met during a run", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, []fakeagent.Step{claudeInit(), {Out: `{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Invalid API key"}]}}`}, exit(1)})
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		row := rt.ended(0)
		if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunNotSignedIn || len(rt.f.ackList()) != 0 {
			t.Fatalf("the run %v, acks %v", row, rt.f.ackList())
		}
		rt.eventually("paused", func() bool { return readStatus(rt.files.status()).Entries[rt.entry.ID].Pause == core.PauseNotSignedIn })
	})
}

// seedState writes the entry's state.json.
func (rt *runTest) seedState(change func(s *entryState)) {
	rt.t.Helper()
	dir := rt.files.entry(rt.entry.ID)
	_ = os.MkdirAll(dir, 0o700)
	s := entryState{Server: rt.entry.Server, WorkspaceID: rt.entry.WorkspaceID, AgentID: rt.entry.AgentID, Program: rt.entry.Program,
		Folder: rt.entry.Folder, Tasks: map[string]*taskState{}}
	change(&s)
	writeJSON(rt.t, filepath.Join(dir, "state.json"), s)
}

// starts are n start times within the last hour.
func starts(n int, now time.Time) []int64 {
	out := make([]int64, n)
	for i := range out {
		out[i] = now.Add(-time.Duration(i+1) * time.Minute).UnixMilli()
	}
	return out
}

func TestAutomaticRunsAreCappedPerEntryAndTask(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Automatic: starts(4, rt.clock.Now())} })
	head := rt.f.addItem(fakeItem{Task: "SVA-12", By: "@codex", ByAgent: true})
	rt.serve()
	rt.acked(head)
	if row := rt.ended(0); row["state"] != core.AgentSessionNotStarted || row["reason"] != core.RunCapped || len(rt.records()) != 0 {
		t.Fatalf("the fifth automatic run in an hour: %v", row)
	}
}

func TestAutomaticRunsAreCappedPerEntry(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.seedState(func(s *entryState) { s.Automatic = starts(12, rt.clock.Now()) })
	head := rt.f.addItem(fakeItem{Task: "SVA-40", By: "@codex", ByAgent: true})
	rt.serve()
	rt.acked(head)
	if row := rt.ended(0); row["reason"] != core.RunCapped {
		t.Fatalf("the thirteenth automatic run in an hour: %v", row)
	}
}

func TestTwoRunsThatChangedNothingHoldAutomaticRuns(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	for range 3 {
		head := rt.f.addItem(fakeItem{Task: "SVA-12", By: "@codex", ByAgent: true})
		if rt.cancel == nil {
			rt.serve()
		}
		rt.acked(head)
	}
	runs := rt.f.allRuns()
	if len(runs) != 3 || runs[2]["state"] != core.AgentSessionNotStarted || runs[2]["reason"] != core.RunNoProgress || len(rt.records()) != 2 {
		t.Fatalf("after two quiet runs: %d starts, rows %v", len(rt.records()), runs)
	}
}

func TestAPersonsItemBehindAGuardedHeadRuns(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Quiet: []bool{true, true}} })
	rt.f.addItem(fakeItem{Task: "SVA-12", By: "@codex", ByAgent: true, Do: wakeRun, Why: "for_you"})
	rt.f.addItem(fakeItem{Task: "SVA-13", By: "@aram"})
	rt.serve()
	rt.eventually("the person's item done", func() bool { return rt.runState(1) == core.AgentSessionDone })
	if rt.f.allRuns()[0]["reason"] != core.RunNoProgress {
		t.Fatalf("the guarded head: %v", rt.f.allRuns()[0])
	}
}

func TestTwoAgentsOfOnePersonCannotKeepEachOtherGoingAcrossTasks(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.seedState(func(s *entryState) { s.Automatic = starts(11, rt.clock.Now()) })
	rt.f.addItem(fakeItem{Task: "SVA-20", By: "@codex", ByAgent: true})
	last := rt.f.addItem(fakeItem{Task: "SVA-21", By: "@codex", ByAgent: true})
	rt.serve()
	rt.acked(last)
	runs := rt.f.allRuns()
	if len(runs) != 2 || runs[0]["state"] != core.AgentSessionDone || runs[1]["reason"] != core.RunCapped {
		t.Fatalf("the twelfth automatic run runs, the thirteenth on another task does not: %v", runs)
	}
}

func TestAJournalAndAnOutboxBothPresentKeepTheOutboxsOutcome(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	run := "0199eeee-0000-7000-8000-000000000001"
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.f.set(func(f *fakeQuadit) {
		f.runs = append(f.runs, map[string]any{"id": run, "task": "SVA-12", "agent_id": fakeAgentID, "state": "running", "machine_id": testMachine.ID})
	})
	dir := rt.files.entry(rt.entry.ID)
	_ = os.MkdirAll(dir, 0o700)
	if err := writeJournal(dir, journal{Run: run, Task: "SVA-12", Head: journalHead{Seq: head}, Lease: testLease, Phase: phaseAccepted, StartSeq: 1}); err != nil {
		t.Fatal(err)
	}
	out, _ := openOutbox(filepath.Join(dir, "outbox"))
	_, _ = out.add(outboxWrite{Run: run, Task: "SVA-12", Head: head, Write: writeEnd, Terminal: &terminalRecord{State: core.AgentSessionDone, Final: "Done.",
		Fallback: fallbackNone, SendEnd: true, Head: head, Ack: true, Cursor: core.ListenCursorOf(fakeProjectID), Lease: testLease, AgentID: fakeAgentID, Machine: "Test Mac"}})
	rt.serve()
	rt.acked(head)
	if row := rt.f.run(run); row["state"] != core.AgentSessionDone {
		t.Fatalf("recovery turned the outbox's done into %v", row)
	}
	if j, _ := readJournal(dir); j != nil {
		t.Fatal("the journal stayed")
	}
}

func TestAProgramMaybeLaunchedIsInterruptedAndNotStartedAgain(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	run := "0199eeee-0000-7000-8000-000000000002"
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.f.set(func(f *fakeQuadit) {
		f.runs = append(f.runs, map[string]any{"id": run, "task": "SVA-12", "agent_id": fakeAgentID, "state": "waiting", "machine_id": testMachine.ID})
	})
	dir := rt.files.entry(rt.entry.ID)
	_ = os.MkdirAll(dir, 0o700)
	_ = writeJournal(dir, journal{Run: run, Task: "SVA-12", Head: journalHead{Seq: head}, Lease: testLease, Phase: phaseLaunching, Attempt: 1, StartSeq: 1})
	rt.serve()
	rt.acked(head)
	row := rt.f.run(run)
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunInterrupted || row["summary"] != "Quadit stopped on Test Mac while this run worked." {
		t.Fatalf("the run left launching reads %v", row)
	}
	time.Sleep(100 * time.Millisecond)
	if len(rt.records()) != 0 || len(rt.f.allRuns()) != 1 {
		t.Fatal("a run that may have been launched was started again")
	}
}

func TestAProcessIsOursOnlyByGroupAndStartTime(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	start := func() *exec.Cmd {
		cmd := exec.Command("sleep", "600")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}
	srv := newServing(rt.files, rt.host(), testMachine, &syncBuffer{}, "")
	e, err := newEntry(srv, rt.entry)
	if err != nil {
		t.Fatal(err)
	}
	other := start()
	e.recoverRun(context.Background(), journal{Run: "0199eeee-0000-7000-8000-000000000003", Task: "SVA-1", Phase: phaseLaunched, PGID: other.Process.Pid, ProcStart: "Mon Jan  1 00:00:00 2001"})
	if !alive(other.Process.Pid) {
		t.Fatal("a process with the group id but another start time was stopped")
	}
	ours := start()
	started, _ := processStart(context.Background(), ours.Process.Pid)
	exited := make(chan struct{})
	go func() { _ = ours.Wait(); close(exited) }()
	e.recoverRun(context.Background(), journal{Run: "0199eeee-0000-7000-8000-000000000004", Task: "SVA-1", Phase: phaseLaunched, PGID: ours.Process.Pid, ProcStart: started})
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("the program recognized by its group and start time was not stopped")
	}
}

func TestAWriteRefusedForGoodIsKeptAndShown(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.set(func(f *fakeQuadit) { f.refuseEnds = true })
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.acked(head) // the writes after the refused one still go
	rt.eventually("the blocked write in status.json", func() bool {
		b := readStatus(rt.files.status()).Entries[rt.entry.ID].Blocked
		return len(b) == 1 && b[0].Write == writeEnd && b[0].Task == "SVA-12" && strings.HasPrefix(b[0].Error, "forbidden")
	})
	if failed, _ := filepath.Glob(filepath.Join(rt.files.entry(rt.entry.ID), "outbox", "failed", "*.json")); len(failed) != 1 {
		t.Fatalf("failed/ holds %v", failed)
	}
	if !strings.Contains(rt.out.String(), "the server refused how run") || !strings.Contains(rt.out.String(), "(forbidden); kept in the outbox's failed folder") {
		t.Fatalf("said:\n%s", rt.out)
	}
}

func TestRecoveryIsPerEntry(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	away := newFakeQuadit()
	away.unreachable = true
	awayURL := serveFake(t, away)
	awayLogin := filepath.Join(rt.dir, "away", "claude.json")
	_ = os.MkdirAll(filepath.Dir(awayLogin), 0o700)
	writeJSON(t, awayLogin, map[string]string{"url": awayURL, "token": agentToken})
	other := rt.entry
	other.ID, other.Server, other.Login = "0000cccc", awayURL, awayLogin
	rt.writeRegistry(other, rt.entry)
	dir := rt.files.entry(other.ID)
	_ = os.MkdirAll(dir, 0o700)
	_ = writeJournal(dir, journal{Run: "0199eeee-0000-7000-8000-000000000005", Task: "SVA-1", Head: journalHead{Seq: 5}, Lease: testLease, Phase: phaseAccepted, StartSeq: 1})
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.ended(0)
	if files, _ := filepath.Glob(filepath.Join(dir, "outbox", "*.json")); len(files) == 0 {
		t.Fatal("the entry whose server is away kept nothing to send")
	}
}

func TestTheProgramsSettingsNamingAnotherLoginPauseTheEntry(t *testing.T) {
	for _, c := range []struct{ program, file, setting string }{
		{core.ProgramClaude, ".claude/settings.json", `{"env":{"QUADIT_CONFIG":"%s"}}`},
		{core.ProgramCodex, ".codex/config.toml", "[shell_environment_policy]\nset = { QUADIT_CONFIG = \"%s\" }\n"},
	} {
		t.Run(c.program, func(t *testing.T) {
			rt := newRunTest(t, c.program)
			path := filepath.Join(rt.home, c.file)
			_ = os.MkdirAll(filepath.Dir(path), 0o700)
			_ = os.WriteFile(path, []byte(strings.Replace(c.setting, "%s", "~/other.json", 1)), 0o600)
			rt.serve()
			rt.eventually("paused", func() bool {
				return readStatus(rt.files.status()).Entries[rt.entry.ID].Pause == core.PauseLoginMismatch
			})
			_ = os.WriteFile(path, []byte(strings.Replace(c.setting, "%s", rt.login, 1)), 0o600)
			rt.eventually("ready once the setting names the entry's login", func() bool {
				return readStatus(rt.files.status()).Entries[rt.entry.ID].State == statusReady
			})
		})
	}
}

func TestAnAcknowledgmentOfAnyWhyIsPlain(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.addItem(fakeItem{Task: "SVA-12", Do: wakeAck, Why: "background"})
	last := rt.f.addItem(fakeItem{Task: "SVA-13", Do: wakeAck, Why: "a why from a newer server"})
	rt.serve()
	rt.acked(last)
	if len(rt.f.allRuns()) != 0 || len(rt.records()) != 0 || readStatus(rt.files.status()).Entries[rt.entry.ID].Pause != "" {
		t.Fatal("an acknowledgment started something or paused the entry")
	}
}

func TestNothingIsSentBeforeTheLoginIsVerified(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	other := rt.entry
	other.WorkspaceID = "0199aaaa-0000-7000-8000-00000000ffff" // the login at the path is of another workspace now
	rt.writeRegistry(other)
	out, _ := openOutbox(filepath.Join(rt.files.entry(other.ID), "outbox"))
	_, _ = out.add(stepsWrite("0199eeee-0000-7000-8000-0000000000f1", 0))
	rt.serve()
	rt.eventually("the entry's error", func() bool { return readStatus(rt.files.status()).Entries[other.ID].Message == string(errLoginRefused) })
	if calls := rt.f.callList(); len(calls) != 0 || rt.f.sentCount(changeID("0199eeee-0000-7000-8000-0000000000f1", writeSteps, 0)) != 0 {
		t.Fatalf("sent with a login not verified: %v", calls)
	}
}

func TestARecordedProgramIsStoppedWithoutTheLoginFile(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	cmd := exec.Command("sleep", "600")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })
	started, _ := processStart(context.Background(), cmd.Process.Pid)
	dir := rt.files.entry(rt.entry.ID)
	_ = os.MkdirAll(dir, 0o700)
	_ = writeJournal(dir, journal{Run: "0199eeee-0000-7000-8000-0000000000f2", Task: "SVA-12", Head: journalHead{Seq: 5}, Lease: testLease,
		Phase: phaseLaunched, PGID: cmd.Process.Pid, ProcStart: started, StartSeq: 3})
	_ = os.Remove(rt.login)
	rt.serve()
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("the program recorded in the journal still runs while the login file is gone")
	}
	rt.eventually("its end kept in the outbox", func() bool {
		out, _ := openOutbox(filepath.Join(dir, "outbox"))
		return out.hasEnd("0199eeee-0000-7000-8000-0000000000f2")
	})
}

func TestTheProgramStartsOnlyWithTheLoginThatWasVerified(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	srv := newServing(rt.files, rt.host(), testMachine, &syncBuffer{}, "")
	lock, err := srv.takeFolder(rt.folder, "@someone")
	if err != nil {
		t.Fatal(err)
	}
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.eventually("waiting for the folder", func() bool { return len(rt.f.allRuns()) > 0 && rt.f.allRuns()[0]["reason"] == core.RunFolderBusy })
	writeJSON(t, rt.login, map[string]string{"url": rt.url, "token": codexToken}) // another login at the path
	srv.releaseFolder(rt.folder, lock)
	rt.eventually("the entry's error", func() bool {
		return readStatus(rt.files.status()).Entries[rt.entry.ID].Message == string(errLoginRefused)
	})
	if len(rt.records()) != 0 {
		t.Fatal("the program started with a login that was not the one verified")
	}
}

func TestAnEntryThatStartsPausedHoldsItsProjectWithItsLease(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	if err := os.Rename(rt.folder, rt.folder+".gone"); err != nil {
		t.Fatal(err)
	}
	rt.serve()
	rt.eventually("a paused hold", func() bool {
		for _, q := range rt.f.holdList() {
			if q.Get("paused") == core.PauseFolderMissing {
				return q.Get("project") == "SVA"
			}
		}
		return false
	})
	if files, _ := filepath.Glob(filepath.Join(filepath.Dir(rt.login), "listen-*.lease")); len(files) != 1 {
		t.Fatalf("lease files %v", files)
	}
}

func TestAStaleLeaseIsDiscardedAndAskedAgain(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	c, _ := loginClient(rt.login)
	lf, err := openLeaseFile(filepath.Dir(rt.login), c, "SVA")
	if err != nil {
		t.Fatal(err)
	}
	lf.keep("ZZZZ3333") // a lease that ended while the runner was away
	lf.close()
	rt.serve()
	rt.eventually("ready with the listener's lease", func() bool {
		return readStatus(rt.files.status()).Entries[rt.entry.ID].State == statusReady
	})
	for _, q := range rt.f.holdList() {
		if q.Has("take") {
			t.Fatal("a hold asked to take the lease")
		}
	}
}

func TestAPausedEntrySendsWhatWaitsInItsOutbox(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	rt.pauseUntil(rt.clock.Now().Add(time.Hour))
	const run = "0199eeee-0000-7000-8000-0000000000f3"
	rt.f.set(func(f *fakeQuadit) {
		f.runs = append(f.runs, map[string]any{"id": run, "task": "SVA-12", "agent_id": fakeAgentID, "state": "running", "machine_id": testMachine.ID})
	})
	out, _ := openOutbox(filepath.Join(rt.files.entry(rt.entry.ID), "outbox"))
	w := stepsWrite(run, 0)
	w.Change.Args["add_steps"] = []any{map[string]any{"tool": "Bash"}}
	_, _ = out.add(w)
	rt.serve()
	rt.eventually("the waiting write sent", func() bool { return rt.f.sentCount(w.ChangeID) == 1 })
}

func TestAContinuationCarriesNoNewItems(t *testing.T) {
	resets := time.Now().Add(time.Hour).Truncate(time.Second)
	limited := []fakeagent.Step{claudeInit(), claudeSays("Working."),
		{Out: `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":` + strconv.FormatInt(resets.Unix(), 10) + `}}`}, exit(1)}
	rt := newRunTest(t, core.ProgramClaude, limited, claudeDone("continued"), claudeDone("the later one"))
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.ended(0)
	rt.eventually("paused", func() bool { return readStatus(rt.files.status()).Entries[rt.entry.ID].Pause == core.PauseUsageLimit })
	later := rt.f.addItem(fakeItem{Task: "SVA-12"}) // came during the pause
	rt.clock.jump(61 * time.Minute)
	rt.acked(later)
	recs := rt.records()
	if len(recs) != 3 || strings.Contains(recs[1].Stdin, "QUADIT-ITEMS") || !strings.Contains(recs[2].Stdin, "#"+strconv.FormatInt(later, 10)) {
		t.Fatalf("%d starts; the continuation's prompt:\n%s", len(recs), recs[len(recs)-1].Stdin)
	}
	if rt.f.allRuns()[1]["items_through"] != float64(head) {
		t.Fatalf("the continuation covers %v, not the run it continues (%d)", rt.f.allRuns()[1]["items_through"], head)
	}
}

func TestAFailedCoverageReadIsRetriedNeverTakenAsNothingCovered(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.f.set(func(f *fakeQuadit) {
		f.runsAway = true
		f.runs = append(f.runs, map[string]any{"id": "0199dddd-0000-7000-8000-0000000000a1", "task": "SVA-12", "agent_id": fakeAgentID,
			"state": "done", "accepted_at": 1, "items_through": head})
	})
	rt.serve()
	rt.eventually("the head handed out a few times", func() bool { return len(rt.f.holdList()) >= 4 })
	if len(rt.records()) != 0 || len(rt.f.allRuns()) != 1 {
		t.Fatal("a head whose coverage could not be read was run")
	}
	rt.f.set(func(f *fakeQuadit) { f.runsAway = false })
	rt.acked(head)
	if len(rt.records()) != 0 {
		t.Fatal("a head the server says a program took was run")
	}
}

// TestTheItemsOfATaskNoProgramTookAreOneRun: with no record of the entry's
// and no run on the server whose program took an item of the task (what
// waited when the runner was set up), the head and the other items of its
// task that would start a run are one run.
func TestTheItemsOfATaskNoProgramTookAreOneRun(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("one"), claudeDone("two"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	second := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.acked(second)
	recs := rt.records()
	if len(recs) != 1 || !strings.Contains(recs[0].Stdin, "#"+strconv.FormatInt(second, 10)) || len(rt.f.allRuns()) != 1 {
		t.Fatalf("%d starts, %d rows; the first prompt:\n%s", len(recs), len(rt.f.allRuns()), recs[0].Stdin)
	}
	if rt.f.allRuns()[0]["items_through"] != float64(second) {
		t.Fatalf("items_through %v", rt.f.allRuns()[0]["items_through"])
	}
}

func TestAnAnswerThatDoesNotHoldTogetherIsNotActedOn(t *testing.T) {
	t.Run("a task of another project", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.addItem(fakeItem{Task: "OPS-12"})
		rt.serve()
		rt.eventually("the entry's error", func() bool {
			return readStatus(rt.files.status()).Entries[rt.entry.ID].Message == string(errServerWrong)
		})
		if len(rt.f.allRuns()) != 0 || len(rt.f.ackList()) != 0 || len(rt.records()) != 0 {
			t.Fatal("an item of another project was acted on")
		}
	})
	t.Run("an item whose own seq is not the answer's", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.addItem(fakeItem{Task: "SVA-12", Inner: 99999})
		rt.serve()
		rt.eventually("the entry's error", func() bool {
			return readStatus(rt.files.status()).Entries[rt.entry.ID].Message == string(errServerWrong)
		})
		if len(rt.f.allRuns()) != 0 || len(rt.f.ackList()) != 0 {
			t.Fatal("an item whose seqs disagree was acted on")
		}
	})
	item := func(seq int64) *listenItem { return &listenItem{Seq: seq, Task: "SVA-1", Type: "comment"} }
	run := &wake{Do: wakeRun, Why: "for_you"}
	for name, ans := range map[string]held{
		"a seq of zero":                {Seq: 0, Item: item(0), Wake: run, Project: "SVA"},
		"a batch item behind the head": {Seq: 5, Item: item(5), Wake: run, Project: "SVA", Batch: []heldItem{{Seq: 4, Item: item(4), Wake: run}}},
		"a batch out of order":         {Seq: 5, Item: item(5), Wake: run, Project: "SVA", Batch: []heldItem{{Seq: 7, Item: item(7), Wake: run}, {Seq: 6, Item: item(6), Wake: run}}},
		"a batch item's seqs disagree": {Seq: 5, Item: item(5), Wake: run, Project: "SVA", Batch: []heldItem{{Seq: 6, Item: item(60), Wake: run}}},
		"a refusal of another project": {Seq: 5, Item: &listenItem{Seq: 5, Task: "OPS-1"}, Wake: &wake{Do: wakeRefuse, Why: "not_responsible"}, Project: "SVA"},
	} {
		t.Run(name, func(t *testing.T) {
			if consistent(ans, "SVA") {
				t.Fatalf("%+v taken as holding together", ans)
			}
		})
	}
}

func TestARunSaysWhatStartedItAsAPersonWould(t *testing.T) {
	item := func(typ, snippet string) listenItem {
		return listenItem{Seq: 2343, Type: typ, By: "@aram-grigoryan", Task: "SVA-53", Title: "SVA-53 Boss fight", Snippet: snippet}
	}
	for _, c := range []struct {
		item listenItem
		want string
	}{
		{item(core.NoteComment, "check this out"), `@aram-grigoryan commented: "check this out"`},
		{item(core.NoteReplied, "yes"), `@aram-grigoryan replied: "yes"`},
		{item(core.NoteMentioned, "@codex look"), `@aram-grigoryan mentioned it: "@codex look"`},
		{item(core.NoteResult, "Shipped"), `@aram-grigoryan posted a result: "Shipped"`},
		{item(core.NoteAssigned, ""), `@aram-grigoryan assigned SVA-53.`},
		{item(core.NoteWaitingOn, "the numbers"), `@aram-grigoryan is waiting on it: "the numbers"`},
		{item(core.NoteWaitingOn, ""), `@aram-grigoryan is waiting on it.`},
		{item(core.NoteAsked, "Which one?"), `@aram-grigoryan asked it a question: "Which one?"`},
		{item(core.NotePicked, "The second"), `@aram-grigoryan answered its question: "The second"`},
		{item(core.NoteUnclear, "Say more"), `@aram-grigoryan found its answer unclear: "Say more"`},
		{item("something_new", "hi"), `@aram-grigoryan: "hi"`},
		// The same care as the line an agent reads: no handle or key not of its form, one line, its quotes made single, 200 characters.
		{listenItem{Type: core.NoteComment, By: "@Not A Handle\n", Snippet: "two\nlines \"quoted\"\x07"}, `Someone commented: "two lines 'quoted'"`},
		{listenItem{Type: core.NoteAssigned, By: "@ann", Task: "SVA-53; rm -rf"}, `@ann assigned a task to it.`},
		{listenItem{Type: core.NoteComment, By: "@ann", Snippet: strings.Repeat("é", 300)}, `@ann commented: "` + strings.Repeat("é", 200) + `"`},
	} {
		if got := runInstructions([]listenItem{c.item}); got != c.want {
			t.Errorf("%s: %q, want %q", c.item.Type, got, c.want)
		}
	}
	more := []listenItem{item(core.NoteComment, "check this out"), item(core.NoteComment, "and this"), item(core.NoteAssigned, "")}
	if got, want := runInstructions(more), `@aram-grigoryan commented: "check this out" and 2 more.`; got != want {
		t.Errorf("with more items: %q, want %q", got, want)
	}
	if got, want := runInstructions(more[2:]), `@aram-grigoryan assigned SVA-53.`; got != want {
		t.Errorf("%q, want %q", got, want)
	}
}

// usageLimited is a Claude Code that takes the prompt, works, and stops at
// its usage limit, which resets in an hour.
func usageLimited() []fakeagent.Step {
	resets := time.Now().Add(time.Hour).Truncate(time.Second)
	return []fakeagent.Step{claudeInit(), claudeSays("Working."),
		{Out: fmt.Sprintf(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":%d}}`, resets.Unix())}, exit(1)}
}

// TestAKeptHeadIsAcknowledgedWhenTheServerNoLongerRunsIt: the head an
// entry keeps after a usage limit goes on only when the server still runs
// it; one it acknowledges meanwhile (the task given to someone else while
// the agent was paused: ack before) is acknowledged, and nothing starts.
func TestAKeptHeadIsAcknowledgedWhenTheServerNoLongerRunsIt(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, usageLimited(), claudeDone("done"))
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	if row := rt.ended(0); row["reason"] != core.RunUsageLimit {
		t.Fatalf("the first run ended %v", row)
	}
	rt.eventually("paused", func() bool { return readStatus(rt.files.status()).Entries[rt.entry.ID].Pause == core.PauseUsageLimit })
	rt.f.set(func(f *fakeQuadit) { f.items[0].Do, f.items[0].Why = wakeAck, "before" })
	rt.clock.jump(61 * time.Minute)
	rt.acked(head)
	if len(rt.records()) != 1 || len(rt.f.allRuns()) != 1 {
		t.Fatalf("%d starts, %d runs: the withdrawn head went on", len(rt.records()), len(rt.f.allRuns()))
	}
}
