//go:build unix

package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestARunLongerThanItsLimitIsEnded: a run over limit= is ended, with what
// it started and even when it ignores being asked to stop, and counts as a
// failed run.
func TestARunLongerThanItsLimitIsEnded(t *testing.T) {
	was := endGrace
	endGrace = 200 * time.Millisecond
	defer func() { endGrace = was }()
	pidFile := filepath.Join(t.TempDir(), "pid")
	srv := &inboxServer{items: []int64{3}}
	command := []string{"--exec", "sh", "-c", `trap '' TERM; sleep 60 & echo $! > "$0"; wait`, pidFile}
	began := time.Now()
	events, _ := listenFor(t, srv, append([]string{"limit=1", "tries=1"}, command...), func(events []map[string]any) bool {
		return len(named(events, "gave_up")) == 1
	})
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("ending the run took %s", took)
	}
	if ended := named(events, "run_ended"); len(ended) != 1 || ended[0]["status"] != "limit" {
		t.Fatalf("the run's end was reported as %v", ended)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &pid); err != nil {
		t.Fatal(err)
	}
	if p, err := os.FindProcess(pid); err == nil && p.Signal(syscall.Signal(0)) == nil {
		t.Fatalf("what the run started (pid %d) still runs", pid)
	}
	if _, acks := srv.state(); !slices.Equal(acks, []int64{3}) {
		t.Fatalf("acknowledged %v", acks)
	}
}

// TestARunEndedByASignalIsNotSaidNotToHaveRun: a run killed by a signal
// other than the limit ended with no exit status (-1); one that could not
// start did not run.
func TestARunEndedByASignalIsNotSaidNotToHaveRun(t *testing.T) {
	srv := &inboxServer{items: []int64{3}}
	events, _ := listenFor(t, srv, []string{"tries=1", "--exec", "sh", "-c", "kill -KILL $$"}, func(events []map[string]any) bool {
		return len(named(events, "gave_up")) == 1
	})
	if ended := named(events, "run_ended"); len(ended) != 1 || ended[0]["status"] != -1.0 {
		t.Fatalf("a run killed by a signal was reported as %v", ended)
	}
	srv = &inboxServer{items: []int64{3}}
	events, _ = listenFor(t, srv, []string{"tries=1", "--exec", filepath.Join(t.TempDir(), "missing")}, func(events []map[string]any) bool {
		return len(named(events, "gave_up")) == 1
	})
	if ended := named(events, "run_ended"); len(ended) != 1 || ended[0]["status"] != "not_run" {
		t.Fatalf("a command that could not start was reported as %v", ended)
	}
}
