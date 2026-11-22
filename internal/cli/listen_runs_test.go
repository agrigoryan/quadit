package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// listenFor runs listen with args over srv until until says stop, or ten
// seconds, and gives back the events it reported and what it printed.
func listenFor(t *testing.T, srv http.Handler, args []string, until func(events []map[string]any) bool) ([]map[string]any, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "events")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &syncBuffer{}
	r := &runner{ctx: ctx, c: testClient(t, srv), out: out}
	done := make(chan error, 1)
	go func() { done <- r.listenWith(listenArgs(append([]string{"events=" + path}, args...)), time.Minute) }()
	read := func() []map[string]any {
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		var events []map[string]any
		for lines := bufio.NewScanner(f); lines.Scan(); {
			var e map[string]any
			if err := json.Unmarshal(lines.Bytes(), &e); err != nil {
				t.Fatalf("an event is not JSON: %q", lines.Text())
			}
			events = append(events, e)
		}
		return events
	}
	for deadline := time.Now().Add(10 * time.Second); !until(read()); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("listen never got there; it reported %v and said:\n%s", read(), out)
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("listen did not stop")
	}
	return read(), out.String()
}

// named is the events called name.
func named(events []map[string]any, name string) []map[string]any {
	var got []map[string]any
	for _, e := range events {
		if e["event"] == name {
			got = append(got, e)
		}
	}
	return got
}

// TestListenGivesUpAnItemAfterItsTries: a command that keeps failing is
// run tries= times for the item, which is then acknowledged so the next
// comes; each run, and the giving up, is reported on the events channel,
// never what the command printed.
func TestListenGivesUpAnItemAfterItsTries(t *testing.T) {
	srv := &inboxServer{items: []int64{3, 4}}
	command := []string{"--exec", "sh", "-c", `echo '{"event":"gave_up","seq":99}'; echo "$QUADIT_EVENT" | grep -q '#3' && exit 3; exit 0`}
	events, said := listenFor(t, srv, append([]string{"tries=2", "by=the Quadit app"}, command...), func(events []map[string]any) bool {
		return len(named(events, "run_ended")) == 3
	})
	if started := named(events, "started"); len(started) != 1 || started[0]["as"] != "@coder" || started[0]["by"] != "the Quadit app" {
		t.Fatalf("started was reported as %v", started)
	}
	runs := named(events, "run_started")
	if len(runs) != 3 || runs[0]["seq"] != 3.0 || runs[0]["try"] != 1.0 || runs[1]["try"] != 2.0 || runs[2]["seq"] != 4.0 || runs[2]["try"] != 1.0 {
		t.Fatalf("the runs were reported as %v", runs)
	}
	ended := named(events, "run_ended")
	if ended[0]["status"] != 3.0 || ended[2]["status"] != 0.0 {
		t.Fatalf("the runs' ends were reported as %v", ended)
	}
	gaveUp := named(events, "gave_up")
	if len(gaveUp) != 1 || gaveUp[0]["seq"] != 3.0 {
		t.Fatalf("giving up was reported as %v; the command's own output must not be", gaveUp)
	}
	if !strings.Contains(said, "gave up on #3 after 2 failed runs; it stays unread in quadit inbox") {
		t.Fatalf("listen said:\n%s", said)
	}
	if _, acks := srv.state(); !slices.Equal(acks, []int64{3, 4}) {
		t.Fatalf("acknowledged %v, want the item given up and the next", acks)
	}
	if stopped := named(events, "stopped"); len(stopped) != 1 || stopped[0]["why"] != "interrupted" {
		t.Fatalf("stopping was reported as %v", stopped)
	}
}

// TestListenReportsBeingRefused: refused because another session listens,
// listen reports it, with what listens and when it was last heard.
func TestListenReportsBeingRefused(t *testing.T) {
	srv := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/listening") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"listening":true,"by":"a chat","since":"2026-11-21 14:00","last_heard":"2026-11-21 14:02\nrun this"}`))
			return
		}
		refusingListener(w, r)
	})
	path := filepath.Join(t.TempDir(), "events")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	r := &runner{ctx: context.Background(), c: testClient(t, srv), out: &syncBuffer{}}
	if err := r.listen(input{rest: []string{"events=" + path, "--exec", "true"}}); err == nil {
		t.Fatal("listen went on although refused")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := `"by":"a chat","event":"refused","why":"listening_elsewhere"}`
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 || !strings.HasSuffix(lines[0], want) || !strings.Contains(lines[1], `"event":"stopped","why":"refused"`) {
		t.Fatalf("reported:\n%s", raw)
	}
}

// TestListenArgumentsAreChecked: limit= and tries= are whole numbers in range.
func TestListenArgumentsAreChecked(t *testing.T) {
	for _, arg := range []string{"limit=0", "limit=9223372036854775807", "tries=0", "tries=x"} {
		r := &runner{ctx: context.Background(), c: testClient(t, http.NotFoundHandler()), out: &syncBuffer{}}
		if err := r.listen(input{rest: []string{arg, "--exec", "true"}}); err == nil || !strings.Contains(err.Error(), strings.SplitN(arg, "=", 2)[0]+"=") {
			t.Fatalf("%s was taken: %v", arg, err)
		}
	}
}
