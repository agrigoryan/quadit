package cli

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
)

// recordingServer is the server as the outbox sees it, keeping what it
// was sent; refuse decides each answer.
type recordingServer struct {
	sent   []string // change ids, or "ack N", "release P"
	refuse func(what string) error
	events []feedEvent
	seq    int64
}

func (s *recordingServer) answer(what string) error {
	s.sent = append(s.sent, what)
	if s.refuse != nil {
		return s.refuse(what)
	}
	return nil
}

func (s *recordingServer) change(_ context.Context, id, _ string, _ map[string]any) (Result, error) {
	return Result{Seq: 7}, s.answer(id)
}

func (s *recordingServer) acknowledge(_ context.Context, _ string, seq int64, _ string) error {
	return s.answer("ack " + strconv.FormatInt(seq, 10))
}

func (s *recordingServer) release(_ context.Context, project, _ string) error {
	return s.answer("release " + project)
}

func (s *recordingServer) seqNow(context.Context) (int64, error) { return s.seq, nil }

func (s *recordingServer) taskEvents(context.Context, string, int64, int64) ([]feedEvent, error) {
	return s.events, nil
}

func stepsWrite(run string, n int) outboxWrite {
	return outboxWrite{Run: run, Write: writeSteps, Ordinal: n, ChangeID: changeID(run, writeSteps, n), Change: &pendingChange{Type: "session.update", Args: map[string]any{"id": run}}}
}

func TestEveryWriteIsStoredOnceAndSentInOrder(t *testing.T) {
	out, err := openOutbox(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const run = "0199eeee-0000-7000-8000-00000000000a"
	for n := range 3 {
		if _, err := out.add(stepsWrite(run, n)); err != nil {
			t.Fatal(err)
		}
	}
	away := true
	srv := &recordingServer{refuse: func(what string) error {
		if what == changeID(run, writeSteps, 1) && away {
			return errors.New("connection refused")
		}
		return nil
	}}
	if _, err := out.flush(context.Background(), srv, ""); !errors.Is(err, errOutboxWaits) {
		t.Fatalf("a server away: %v", err)
	}
	away = false
	if _, err := out.flush(context.Background(), srv, ""); err != nil || !out.empty() {
		t.Fatalf("flush: %v, empty %v", err, out.empty())
	}
	want := []string{changeID(run, writeSteps, 0), changeID(run, writeSteps, 1), changeID(run, writeSteps, 1), changeID(run, writeSteps, 2)}
	if !slices.Equal(srv.sent, want) {
		t.Fatalf("sent %v, want %v: in order, the one not answered again under its id", srv.sent, want)
	}
}

func TestAStaleAcknowledgmentIsDropped(t *testing.T) {
	dir := t.TempDir()
	out, _ := openOutbox(dir)
	const run = "0199eeee-0000-7000-8000-00000000000b"
	_, _ = out.add(outboxWrite{Run: run, Write: writeAck, Head: 5, Ack: &pendingAck{Cursor: "listen:p", Seq: 5, Lease: "KQ7MX4PA"}})
	_, _ = out.add(stepsWrite(run, 0))
	srv := &recordingServer{refuse: func(what string) error {
		if what == "ack 5" {
			return &APIError{Status: http.StatusConflict, Code: "conflict", Reason: "lease_stale"}
		}
		return nil
	}}
	if _, err := out.flush(context.Background(), srv, ""); err != nil || !out.empty() {
		t.Fatalf("flush: %v", err)
	}
	if failed, _ := os.ReadDir(filepath.Join(dir, "failed")); len(failed) != 0 || len(out.failed()) != 0 {
		t.Fatal("a stale acknowledgment was kept as refused")
	}
	if len(srv.sent) != 2 {
		t.Fatalf("sent %v", srv.sent)
	}
}

func TestAResolvedTerminalRecordIsNeverDecidedAgain(t *testing.T) {
	dir := t.TempDir()
	out, _ := openOutbox(dir)
	const run = "0199eeee-0000-7000-8000-00000000000c"
	var quiet []bool
	out.quiet = func(_, _ string, q bool) { quiet = append(quiet, q) }
	_, _ = out.add(outboxWrite{Run: run, Task: "SVA-1", Head: 5, Write: writeEnd, Terminal: &terminalRecord{State: "done", Final: "Done.", StartSeq: 1,
		Fallback: decidePending, Quiet: decidePending, SendEnd: true, Head: 5, Ack: true, Cursor: "listen:p", Lease: "KQ7MX4PA", AgentID: "a", Machine: "m"}})
	srv := &recordingServer{seq: 9, refuse: func(what string) error {
		if what == changeID(run, writeEnd, 0) {
			return errors.New("connection refused")
		}
		return nil
	}}
	if _, err := out.flush(context.Background(), srv, ""); !errors.Is(err, errOutboxWaits) {
		t.Fatal(err)
	}
	srv.events = []feedEvent{{Seq: 3, Type: "comment.created", ActorID: "a"}} // came later than the decision: not read again
	srv.refuse = nil
	if _, err := out.flush(context.Background(), srv, ""); err != nil {
		t.Fatal(err)
	}
	want := []string{changeID(run, writeFallback, 0), changeID(run, writeEnd, 0), changeID(run, writeEnd, 0), "ack 5"}
	if !slices.Equal(srv.sent, want) || !slices.Equal(quiet, []bool{true}) {
		t.Fatalf("sent %v, quiet %v", srv.sent, quiet)
	}
}
