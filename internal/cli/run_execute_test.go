//go:build unix

package cli

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/fakeagent"
	"github.com/agrigoryan/quadit/internal/id"
)

func TestTheProgramGetsACleanEnvironment(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	for k, v := range map[string]string{"CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "QUADIT_URL": "http://elsewhere", "QUADIT_TOKEN": "secret",
		"ELECTRON_RUN_AS_NODE": "1"} {
		t.Setenv(k, v)
	}
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.ended(0)
	want := map[string]string{"QUADIT_CONFIG": rt.login, "QUADIT_TASK": "SVA-12", "QUADIT_SESSION": row["id"].(string)}
	if got := rt.records()[0].Env; !maps.Equal(got, want) {
		t.Fatalf("the program's environment had %v, want %v", got, want)
	}
	if rt.records()[0].Dir != rt.folder {
		t.Fatalf("it ran in %s", rt.records()[0].Dir)
	}
}

func TestThePromptGoesOnStandardInputNeverAsAnArgument(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.ended(0)
	r := rt.records()[0]
	if !strings.HasPrefix(r.Stdin, "Quadit started you, @claude, on Test Mac in ~/devel/game, for task SVA-12.") || !strings.Contains(r.Stdin, `ITEM #1001 comment SVA-12 from @aram: "please do it"`) {
		t.Fatalf("the prompt on standard input:\n%s", r.Stdin)
	}
	for _, a := range r.Argv {
		if strings.Contains(a, "Quadit") || strings.Contains(a, "please") {
			t.Fatalf("an argument carries the prompt: %q", r.Argv)
		}
	}
	if r.Argv[len(r.Argv)-2] != "--disallowedTools" || r.Argv[len(r.Argv)-1] != "AskUserQuestion" {
		t.Fatalf("argv %q", r.Argv)
	}
}

func TestNoTitleOrWorkspaceNameOutsideTheItems(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.ended(0)
	prompt := rt.records()[0].Stdin
	lines := strings.Split(prompt, "\n")
	first := slices.IndexFunc(lines, func(l string) bool { return strings.HasPrefix(l, "QUADIT-ITEMS-") })
	last := len(lines) - 1
	for last > 0 && !strings.HasPrefix(lines[last], "QUADIT-ITEMS-") {
		last--
	}
	nonce := strings.TrimPrefix(lines[first], "QUADIT-ITEMS-")
	if first < 0 || last <= first || lines[last] != lines[first] || len(nonce) != 12 {
		t.Fatalf("the items' lines:\n%s", prompt)
	}
	outside := strings.Join(append(slices.Clone(lines[:first]), lines[last+1:]...), "\n")
	for _, word := range []string{"Boss fight", "personal", "Samurai", "please do it"} {
		if strings.Contains(outside, word) {
			t.Fatalf("%q outside the items:\n%s", word, outside)
		}
	}
}

func TestOnlyStandardOutputIsReadAsTheProtocol(t *testing.T) {
	onStderr := []fakeagent.Step{{Err: `{"type":"system","subtype":"init","session_id":"{session}"}`},
		{Err: `{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`}, {Err: `{"type":"result","is_error":false,"result":"done"}`}}
	rt := newRunTest(t, core.ProgramClaude, onStderr)
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.ended(0)
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunStartFailed || len(rt.records()) != 3 {
		t.Fatalf("protocol lines on standard error were read: %v after %d starts", row, len(rt.records()))
	}
	rt.acked(head)
}

func TestClaudeCodeStartsWithTheSessionTheRunnerChoseAndResumesIt(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("one"), claudeDone("two"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	first := rt.ended(0)
	session := first["program_session"].(string)
	if !id.Valid(session) || !slices.Contains(rt.records()[0].Argv, "--session-id") || rt.records()[0].Argv[slices.Index(rt.records()[0].Argv, "--session-id")+1] != session {
		t.Fatalf("the first run's session %q, argv %q", session, rt.records()[0].Argv)
	}
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.ended(1)
	argv := rt.records()[1].Argv
	if i := slices.Index(argv, "--resume"); i < 0 || argv[i+1] != session || slices.Contains(argv, "--session-id") || slices.Contains(argv, "--name") {
		t.Fatalf("the second run's argv %q", argv)
	}
	if !strings.HasPrefix(rt.records()[1].Stdin, "Quadit started you again on SVA-12 in this same session") {
		t.Fatalf("the second prompt:\n%s", rt.records()[1].Stdin)
	}
}

func TestCodexSessionComesFromItsOutputAndIsResumed(t *testing.T) {
	rt := newRunTest(t, core.ProgramCodex, codexDone("{thread}", "one"), codexDone("{session}", "two"))
	rt.f.addItem(fakeItem{Task: "SVA-12", For: fakeCodexID})
	rt.serve()
	first := rt.ended(0)
	argv := rt.records()[0].Argv
	if argv[0] != "exec" || argv[len(argv)-1] != "-" || slices.Contains(argv, "resume") {
		t.Fatalf("the first argv %q", argv)
	}
	rt.eventually("the session told", func() bool { return rt.f.run(first["id"].(string))["program_session"] == fakeagent.NewThread })
	if first["summary"] != "one" {
		t.Fatalf("the last message file was not read: %v", first)
	}
	rt.f.addItem(fakeItem{Task: "SVA-12", For: fakeCodexID})
	rt.ended(1)
	argv = rt.records()[1].Argv
	if want := []string{"exec", "resume"}; !slices.Equal(argv[:2], want) || argv[len(argv)-2] != fakeagent.NewThread || argv[len(argv)-1] != "-" {
		t.Fatalf("the second argv %q", argv)
	}
}

func TestOnlyASessionTheRunnerRecordedIsResumed(t *testing.T) {
	t.Run("the server's program_session is never resumed", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.set(func(f *fakeQuadit) {
			f.runs = append(f.runs, map[string]any{"id": "0199dddd-0000-7000-8000-000000000009", "task": "SVA-12", "agent_id": fakeAgentID,
				"state": "done", "program_session": "0199ffff-0000-7000-8000-000000000001"})
		})
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.ended(1)
		if slices.Contains(rt.records()[0].Argv, "--resume") {
			t.Fatalf("argv %q", rt.records()[0].Argv)
		}
	})
	t.Run("a recorded session not of a UUID's form is discarded", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Session: "x; rm -rf ~"} })
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.ended(0)
		if argv := rt.records()[0].Argv; slices.Contains(argv, "--resume") || slices.Contains(argv, "x; rm -rf ~") {
			t.Fatalf("argv %q", argv)
		}
	})
}

func TestALostSessionIsStartedFreshOnceWithinTheThreeAttempts(t *testing.T) {
	const old = "0199ffff-0000-7000-8000-000000000002"
	lost := []fakeagent.Step{{Err: "No conversation found with session ID: {session}"}, exit(1)}
	t.Run("once, then fresh", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, lost, claudeDone("done"))
		rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Session: old} })
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		row := rt.ended(0)
		recs := rt.records()
		if row["state"] != core.AgentSessionDone || len(recs) != 2 || !slices.Contains(recs[0].Argv, old) || !slices.Contains(recs[1].Argv, "--session-id") {
			t.Fatalf("%v after starts %v", row, recs)
		}
		if !strings.Contains(recs[1].Stdin, "Your earlier session on SVA-12 could not be found on this computer") {
			t.Fatalf("the fresh prompt:\n%s", recs[1].Stdin)
		}
		fresh := slices.ContainsFunc(rt.changesOf("session.update"), func(ch fakeChange) bool {
			return ch.Args["fresh"] == true && ch.Args["program_session"] == row["program_session"]
		})
		if !fresh || row["program_session"] == old {
			t.Fatalf("the new session was not told fresh: %s", rt.changeTypes())
		}
	})
	t.Run("never twice", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, lost)
		rt.seedState(func(s *entryState) { s.Tasks["SVA-12"] = &taskState{Session: old} })
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		row := rt.ended(0)
		if row["reason"] != core.RunStartFailed || len(rt.records()) != 3 {
			t.Fatalf("%v after %d starts", row, len(rt.records()))
		}
	})
}

func TestACommentDuringARunBecomesTheNextRunInTheSameSession(t *testing.T) {
	slow := []fakeagent.Step{claudeInit(), claudeSays("On it."), {SleepMS: 300}, claudeEnds("one")}
	rt := newRunTest(t, core.ProgramClaude, slow, claudeDone("two"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	first := rt.running(0)
	later := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.ended(0)
	second := rt.ended(1)
	if second["program_session"] != first["program_session"] || !slices.Contains(rt.records()[1].Argv, first["program_session"].(string)) {
		t.Fatalf("the second run's session %v, argv %q", second["program_session"], rt.records()[1].Argv)
	}
	if !strings.Contains(rt.records()[1].Stdin, fmt.Sprintf("#%d", later)) || strings.Contains(rt.records()[1].Stdin, "#1001") {
		t.Fatalf("the second prompt:\n%s", rt.records()[1].Stdin)
	}
}

func TestOneRunAtATimeInAFolderAcrossAgents(t *testing.T) {
	slow := []fakeagent.Step{claudeInit(), claudeSays("On it."), {SleepMS: 300}, claudeEnds("done")}
	rt := newRunTest(t, core.ProgramClaude, slow)
	otherLogin := filepath.Join(rt.dir, "other", "claude.json")
	_ = os.MkdirAll(filepath.Dir(otherLogin), 0o700)
	writeJSON(t, otherLogin, map[string]string{"url": rt.url, "token": codexToken})
	second := rt.entry
	second.ID, second.AgentID, second.Agent, second.Login = "0000bbbb", fakeCodexID, "@codex", otherLogin
	rt.writeRegistry(rt.entry, second)
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.f.addItem(fakeItem{Task: "SVA-13", For: fakeCodexID})
	rt.serve()
	rt.ended(0)
	rt.ended(1)
	busy := slices.ContainsFunc(rt.changesOf("session.update"), func(ch fakeChange) bool { return ch.Args["reason"] == core.RunFolderBusy })
	if !busy || !strings.Contains(rt.out.String(), "waiting for the folder (@") {
		t.Fatalf("no run waited for the folder:\n%s", rt.out)
	}
}

func TestARunWaitsWhileItsSessionWasWrittenInATerminal(t *testing.T) {
	const session = "0199ffff-0000-7000-8000-000000000003"
	rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
	file := filepath.Join(rt.home, ".claude", "projects", notLetterOrDigit.ReplaceAllString(rt.folder, "-"), session+".jsonl")
	_ = os.MkdirAll(filepath.Dir(file), 0o700)
	_ = os.WriteFile(file, []byte("{}\n{}\n"), 0o600)
	rt.seedState(func(s *entryState) {
		s.Tasks["SVA-12"] = &taskState{Session: session, SessionFile: &fileMark{MTime: time.Now().Add(-time.Hour).UnixMilli(), Size: 3}}
	})
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.eventually("the run waiting", func() bool { return len(rt.f.allRuns()) > 0 && rt.f.allRuns()[0]["reason"] == core.RunSessionOpen })
	time.Sleep(50 * time.Millisecond)
	if len(rt.records()) != 0 {
		t.Fatal("a session written a moment ago in a terminal was resumed")
	}
	rt.clock.jump(6 * time.Minute)
	if row := rt.ended(0); row["state"] != core.AgentSessionDone || row["reason"] != nil {
		t.Fatalf("the run %v", row)
	}
	if !slices.Contains(rt.records()[0].Argv, session) {
		t.Fatalf("argv %q", rt.records()[0].Argv)
	}
}

func TestAStopIsSeenFromTheMomentTheRunExists(t *testing.T) {
	t.Run("asked while it waits for the folder: nothing starts", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		srv := newServing(rt.files, rt.host(), testMachine, &syncBuffer{}, "")
		lock, err := srv.takeFolder(rt.folder, "@someone")
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		rt.eventually("waiting for the folder", func() bool { return len(rt.f.allRuns()) > 0 && rt.f.allRuns()[0]["reason"] == core.RunFolderBusy })
		rt.f.stopRun(rt.f.allRuns()[0]["id"].(string))
		if row := rt.ended(0); row["state"] != core.AgentSessionStopped || len(rt.records()) != 0 {
			t.Fatalf("%v, %d starts", row, len(rt.records()))
		}
		rt.acked(head)
	})
	t.Run("asked the moment the run is made: not missed", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		rt.f.set(func(f *fakeQuadit) { f.stopOnStart = true })
		rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		if row := rt.ended(0); row["state"] != core.AgentSessionStopped || len(rt.records()) != 0 {
			t.Fatalf("%v, %d starts", row, len(rt.records()))
		}
	})
	t.Run("asked after the program ended: done", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, claudeDone("done"))
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		row := rt.ended(0)
		rt.acked(head)
		rt.f.stopRun(row["id"].(string))
		time.Sleep(50 * time.Millisecond)
		if now := rt.f.run(row["id"].(string)); now["state"] != core.AgentSessionDone {
			t.Fatalf("%v", now)
		}
	})
}

func TestAStopKillsTheWholeProcessGroup(t *testing.T) {
	stubborn := []fakeagent.Step{claudeInit(), claudeSays("Counting."), {Ignore: "SIGINT"}, {Child: true}, {UntilSignal: []string{"{}"}}}
	rt := newRunTest(t, core.ProgramClaude, stubborn)
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.running(0)
	rt.eventually("the grandchild", func() bool { return len(rt.children()) == 1 })
	rt.f.stopRun(row["id"].(string))
	if row := rt.ended(0); row["state"] != core.AgentSessionStopped {
		t.Fatalf("%v", row)
	}
	rt.acked(head)
	if alive(rt.records()[0].PID) || alive(rt.children()[0]) || syscall.Kill(-rt.records()[0].PID, 0) == nil {
		t.Fatal("something of the program's group still runs")
	}
}

func TestSigtermStopsEveryGroupWithinFourSeconds(t *testing.T) {
	stubborn := []fakeagent.Step{claudeInit(), claudeSays("Counting."), {Ignore: "SIGINT"}, {Child: true}, {UntilSignal: []string{"{}"}}}
	rt := newRunTest(t, core.ProgramClaude, stubborn, stubborn)
	// What a stop takes is the computer's own: the ladder, the drain, the
	// time to send what the stop wrote.
	rt.times.infraLadder, rt.times.drain, rt.times.sendOnStop = defaultTimings.infraLadder, defaultTimings.drain, defaultTimings.sendOnStop
	otherLogin := filepath.Join(rt.dir, "other", "claude.json")
	_ = os.MkdirAll(filepath.Dir(otherLogin), 0o700)
	writeJSON(t, otherLogin, map[string]string{"url": rt.url, "token": codexToken})
	otherFolder := filepath.Join(rt.home, "devel", "site")
	_ = os.MkdirAll(otherFolder, 0o700)
	second := rt.entry
	second.ID, second.AgentID, second.Agent, second.Login, second.Folder = "0000bbbb", fakeCodexID, "@codex", otherLogin, otherFolder
	rt.writeRegistry(rt.entry, second)
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.f.addItem(fakeItem{Task: "SVA-13", For: fakeCodexID})
	var out syncBuffer
	done := make(chan int, 1)
	go func() {
		done <- runnerFormOn(t.Context(), rt.host(), []string{"registry=" + rt.files.registry}, switches{}, &out, &out)
	}()
	rt.out = &out
	rt.eventually("both running", func() bool {
		return rt.runState(0) == core.AgentSessionRunning && rt.runState(1) == core.AgentSessionRunning
	})
	rt.eventually("both grandchildren", func() bool { return len(rt.children()) == 2 })
	sent := time.Now()
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != 0 || time.Since(sent) > 4*time.Second {
			t.Fatalf("quadit run exited %d after %s", code, time.Since(sent))
		}
	case <-time.After(6 * time.Second):
		t.Fatalf("quadit run did not stop on SIGTERM:\n%s", &out)
	}
	for _, r := range rt.records() {
		if syscall.Kill(-r.PID, 0) == nil && alive(r.PID) {
			t.Fatalf("the group %d still runs", r.PID)
		}
	}
	for _, c := range rt.children() {
		if alive(c) {
			t.Fatalf("the grandchild %d still runs", c)
		}
	}
	for _, row := range rt.f.allRuns() {
		if row["reason"] != core.RunInterrupted {
			t.Fatalf("a run reads %v", row)
		}
	}
}

func TestTheIdleWatchdogCountsOnlyAwakeTime(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, []fakeagent.Step{claudeInit(), claudeSays("Thinking."), {UntilSignal: []string{"{}"}}})
	rt.clock.holdAwake()
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.running(0)
	rt.clock.jump(2 * time.Hour) // the computer slept
	time.Sleep(100 * time.Millisecond)
	if rt.runState(0) != core.AgentSessionRunning {
		t.Fatalf("a sleep stopped the run: %v", rt.f.allRuns()[0])
	}
	rt.clock.advance(31 * time.Minute)
	row := rt.ended(0)
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunIdle {
		t.Fatalf("%v", row)
	}
	rt.acked(head)
}

func TestARunWithToolActivityIsNeverRepeated(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, []fakeagent.Step{claudeInit(), claudeRunsBash("Run the tests"), {Err: "crashed"}, exit(1)}, claudeDone("again"))
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.ended(0)
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunProgramError || len(rt.records()) != 1 {
		t.Fatalf("%v after %d starts", row, len(rt.records()))
	}
	rt.acked(head)
}

func TestAFailureBeforeAnyWorkIsTriedThreeTimes(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, []fakeagent.Step{{Err: "boom"}, exit(1)})
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.ended(0)
	if row["state"] != core.AgentSessionFailed || row["reason"] != core.RunStartFailed || len(rt.records()) != 3 {
		t.Fatalf("%v after %d starts", row, len(rt.records()))
	}
	rt.acked(head)
	if !strings.Contains(rt.out.String(), "failed: Claude Code did not start on Test Mac") {
		t.Fatalf("said:\n%s", rt.out)
	}
}

func TestAUsageLimitPausesTheAgentKeepsTheHeadAndContinues(t *testing.T) {
	t.Run("after the work began: continued, not replayed", func(t *testing.T) {
		resets := time.Now().Add(time.Hour).Truncate(time.Second)
		limited := []fakeagent.Step{claudeInit(), claudeSays("Working."),
			{Out: fmt.Sprintf(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":%d}}`, resets.Unix())}, exit(1)}
		rt := newRunTest(t, core.ProgramClaude, limited, claudeDone("done"))
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		row := rt.ended(0)
		if row["reason"] != core.RunUsageLimit || row["resets_at"] != float64(resets.UnixMilli()) || len(rt.f.ackList()) != 0 {
			t.Fatalf("%v, acks %v", row, rt.f.ackList())
		}
		rt.eventually("paused", func() bool { return readStatus(rt.files.status()).Entries[rt.entry.ID].Pause == core.PauseUsageLimit })
		rt.clock.jump(61 * time.Minute)
		rt.ended(1)
		rt.acked(head)
		r := rt.records()[1]
		if !strings.Contains(r.Stdin, "Your last run stopped at Claude Code's limit before it finished") || !slices.Contains(r.Argv, "--resume") || strings.Contains(r.Stdin, "QUADIT-ITEMS") {
			t.Fatalf("the continuation: argv %q\n%s", r.Argv, r.Stdin)
		}
	})
	t.Run("before the work began: the same prompt again", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude, []fakeagent.Step{{Err: "You've hit your limit · resets 3pm (UTC)"}, exit(1)}, claudeDone("done"))
		head := rt.f.addItem(fakeItem{Task: "SVA-12"})
		rt.serve()
		row := rt.ended(0)
		if row["reason"] != core.RunUsageLimit || row["resets_at"] == nil {
			t.Fatalf("%v", row)
		}
		rt.clock.jump(25 * time.Hour)
		rt.ended(1)
		rt.acked(head)
		if p := rt.records()[1].Stdin; strings.Contains(p, "limit") || !strings.Contains(p, fmt.Sprintf("#%d", head)) {
			t.Fatalf("the prompt again:\n%s", p)
		}
	})
}

func TestTheFallbackIsPostedWhenTheAgentWroteNothing(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("Added the line."))
	head := rt.f.addItem(fakeItem{Task: "SVA-12", Type: "assigned"})
	rt.serve()
	row := rt.ended(0)
	if row["state"] != core.AgentSessionDone || row["summary"] != "Added the line." {
		t.Fatalf("the run ended %v", row)
	}
	rt.acked(head)
	rt.eventually("the fallback comment", func() bool { return len(rt.f.commentList()) == 1 })
	if c := rt.f.commentList()[0]; c["body"] != "Added the line." || c["session"] != row["id"] || c["task"] != "SVA-12" {
		t.Fatalf("the fallback comment %v", c)
	}
	if code := rt.stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
	for _, want := range []string{"quadit run: serving 1 entry on Test Mac (stop with Ctrl-C)", "SVA @claude ~/devel/game: listening", "SVA-12 @claude: received #1001 (assigned from @aram)", "SVA-12 @claude: done in"} {
		if !strings.Contains(rt.out.String(), want) {
			t.Fatalf("quadit run did not say %q:\n%s", want, rt.out)
		}
	}
}

func TestTheFallbackIsNotPostedWhenItCommentedOrAsked(t *testing.T) {
	for _, event := range []string{"comment.created", "decision.opened"} {
		t.Run(event, func(t *testing.T) {
			rt := newRunTest(t, core.ProgramClaude, claudeDone("Done."))
			rt.f.set(func(f *fakeQuadit) { f.writeOnRunning = event })
			head := rt.f.addItem(fakeItem{Task: "SVA-12"})
			rt.serve()
			rt.ended(0)
			rt.acked(head)
			if len(rt.f.commentList()) != 0 {
				t.Fatalf("a fallback after the agent wrote: %v", rt.f.commentList())
			}
		})
	}
}

func TestTheFallbackIsCleanedAndCut(t *testing.T) {
	long := "\x1b[31mred\x1b[0m\x07 text\r\n\n\n\n\nafter\t" + strings.Repeat("é", 9000)
	got := cleanedFinal(long, "Test Mac")
	if !strings.HasPrefix(got, "red text\n\n\nafter\t") || strings.ContainsAny(got, "\x1b\x07\r") {
		t.Fatalf("not cleaned: %q", got[:40])
	}
	if !strings.HasSuffix(got, "…\n\n(Cut here: the whole message is in the run's log on Test Mac.)") || len([]rune(strings.Split(got, "…")[0])) != maxFallback {
		t.Fatalf("not cut at %d characters: …%q", maxFallback, got[len(got)-80:])
	}
	if cleanedFinal(" \n\x1b[0m\n ", "m") != "" {
		t.Fatal("a message of nothing posts something")
	}
}

func TestTheFallbackWaitsWhenTheFeedCannotBeRead(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("Done."))
	rt.f.set(func(f *fakeQuadit) { f.failEvents = true })
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.eventually("the program ended", func() bool { return strings.Contains(rt.out.String(), "done in") })
	time.Sleep(100 * time.Millisecond)
	if ended(rt.runState(0)) || len(rt.f.ackList()) != 0 || len(rt.f.commentList()) != 0 {
		t.Fatalf("the end went out before the choice of the fallback: %v", rt.f.allRuns()[0])
	}
	rt.f.set(func(f *fakeQuadit) { f.failEvents = false })
	rt.acked(head)
	if len(rt.f.commentList()) != 1 || rt.runState(0) != core.AgentSessionDone {
		t.Fatalf("comments %v, run %v", rt.f.commentList(), rt.f.allRuns()[0])
	}
	calls := rt.f.callList()
	if i, j := slices.Index(calls, "comment.create"), slices.Index(calls, "ack"); i < 0 || j < i {
		t.Fatalf("the writes came %v", calls)
	}
}

func TestTheTerminalRecordIsWrittenBeforeAnyNetworkCallAndReplayed(t *testing.T) {
	slow := []fakeagent.Step{claudeInit(), claudeSays("On it."), {SleepMS: 200}, claudeEnds("Done.")}
	rt := newRunTest(t, core.ProgramClaude, slow)
	head := rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.running(0)
	rt.f.set(func(f *fakeQuadit) { f.unreachable = true })
	outbox := filepath.Join(rt.files.entry(rt.entry.ID), "outbox")
	rt.eventually("the terminal record kept", func() bool {
		names, _ := filepath.Glob(filepath.Join(outbox, "*.json"))
		for _, n := range names {
			raw, _ := os.ReadFile(n)
			var w outboxWrite
			if json.Unmarshal(raw, &w) == nil && w.Terminal != nil && w.Terminal.State == core.AgentSessionDone && w.Terminal.Final == "Done." {
				return true
			}
		}
		return false
	})
	rt.stop()
	if j, _ := readJournal(rt.files.entry(rt.entry.ID)); j != nil {
		t.Fatal("the journal stayed after the end was kept")
	}
	rt.f.set(func(f *fakeQuadit) { f.unreachable = false })
	rt.serve()
	rt.acked(head)
	if now := rt.f.run(row["id"].(string)); now["state"] != core.AgentSessionDone {
		t.Fatalf("after the replay the run reads %v", now)
	}
	ends := slices.DeleteFunc(rt.changesOf("session.update"), func(ch fakeChange) bool { return ch.Args["state"] != core.AgentSessionDone })
	if len(ends) != 1 || ends[0].ID != changeID(row["id"].(string), writeEnd, 0) || len(rt.records()) != 1 {
		t.Fatalf("the end was sent as %v, %d starts", ends, len(rt.records()))
	}
}

func TestStepsCarryNoCommandLines(t *testing.T) {
	edit := `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"%s","old_string":"a","new_string":"b"}}]}}`
	script := []fakeagent.Step{claudeInit(), claudeRunsBash("Run the tests"),
		{Out: fmt.Sprintf(edit, "{folder}/README")}, {Out: fmt.Sprintf(edit, "/etc/passwd")}, {SleepMS: 60}, claudeEnds("done")}
	rt := newRunTest(t, core.ProgramClaude)
	for i, s := range script {
		script[i].Out = strings.ReplaceAll(s.Out, "{folder}", rt.folder)
	}
	rt.setScripts(script)
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	row := rt.ended(0)
	raw, _ := json.Marshal(row["steps"])
	var steps []step
	_ = json.Unmarshal(raw, &steps)
	if len(steps) != 3 || steps[0].Tool != "Bash" || steps[0].Text != "Run the tests" || steps[1].Text != "README" || steps[2].Tool != "Edit" || steps[2].Text != "" {
		t.Fatalf("steps %s", raw)
	}
	if strings.Contains(rt.changeTypes(), "id_rsa") || strings.Contains(rt.changeTypes(), "passwd") {
		t.Fatalf("a command line or a path outside the folder reached the server:%s", rt.changeTypes())
	}
}

func TestARunAfterTheOwnerChangedNamesTheNewOne(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude, claudeDone("one"), claudeDone("two"))
	rt.f.addItem(fakeItem{Task: "SVA-12"})
	rt.serve()
	rt.ended(0)
	rt.f.set(func(f *fakeQuadit) { m := f.members[agentToken]; m.Responsible = "@bea"; f.members[agentToken] = m })
	rt.f.addItem(fakeItem{Task: "SVA-12", By: "@bea"})
	rt.ended(1)
	if p := rt.records()[1].Stdin; !strings.Contains(p, "You work for @bea now.") {
		t.Fatalf("the resumed run's prompt:\n%s", p)
	}
}
