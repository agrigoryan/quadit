package cli

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/fakeagent"
)

// TestARunLongerThanItsLimitIsEnded: a run over limit= is killed, with
// what it started, and counts as a failed run.
func TestARunLongerThanItsLimitIsEnded(t *testing.T) {
	dir := t.TempDir()
	scripts, record := filepath.Join(dir, "scripts.json"), filepath.Join(dir, "record.jsonl")
	// The command passes SIGINT over, starts a child, and waits to be ended.
	writeJSON(t, scripts, [][]fakeagent.Step{{{Ignore: "SIGINT"}, {Child: true}, {SleepMS: 60_000}}})
	t.Setenv("FAKEAGENT", "claude")
	t.Setenv("FAKEAGENT_SCRIPTS", scripts)
	t.Setenv("FAKEAGENT_RECORD", record)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	srv := &inboxServer{items: []int64{3}}
	began := time.Now()
	events, _ := listenFor(t, srv, []string{"limit=1", "tries=1", "--exec", exe}, func(events []map[string]any) bool {
		return len(named(events, "gave_up")) == 1
	})
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("ending the run took %s", took)
	}
	if ended := named(events, "run_ended"); len(ended) != 1 || ended[0]["status"] != "limit" {
		t.Fatalf("the run's end was reported as %v", ended)
	}
	var children []int
	for _, r := range fakeagent.Records(record) {
		if r.Child > 0 {
			children = append(children, r.Child)
		}
	}
	if len(children) != 1 {
		t.Fatalf("the command started %d children", len(children))
	}
	if alive(children[0]) {
		t.Fatalf("what the run started (pid %d) still runs", children[0])
	}
	if _, acks := srv.state(); !slices.Equal(acks, []int64{3}) {
		t.Fatalf("acknowledged %v", acks)
	}
}
