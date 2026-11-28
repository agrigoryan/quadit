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
	// However the test ends, listen has stopped, and let its events file
	// go, before the test's folder is removed: Windows removes no open file.
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("listen did not stop")
		}
	})
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
	case err := <-done:
		done <- err // for the clean-up's wait
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
	command := append([]string{"--exec"}, listenCommand(t, "fail-3")...)
	events, said := listenFor(t, srv, append([]string{"tries=2", "by=the Quadit app"}, command...), func(events []map[string]any) bool {
		return len(named(events, "run_ended")) == 3
	})
	runs := named(events, "run_started")
	if len(runs) != 3 || runs[0]["seq"] != 3.0 || runs[1]["seq"] != 3.0 || runs[2]["seq"] != 4.0 {
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
}

// TestListenReportsBeingRefused: refused because another session listens,
// listen reports it, with the reason, and stops.
func TestListenReportsBeingRefused(t *testing.T) {
	srv := http.HandlerFunc(refusingListener)
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
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 || !strings.HasSuffix(lines[0], `"event":"refused","why":"listening_elsewhere"}`) {
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

// TestListenStopsWhenTheServerRefusesIt: a refusal waiting will not change
// (a person's login, a token revoked) ends listen with the server's error,
// after one ask; it is not tried again for ever.
func TestListenStopsWhenTheServerRefusesIt(t *testing.T) {
	t.Setenv("QUADIT_CONFIG", filepath.Join(t.TempDir(), "codex.json"))
	asked := 0
	srv := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		asked++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"forbidden","message":"this login is @aram's, a person's, not an agent's"}}`))
	})
	r := &runner{ctx: context.Background(), c: testClient(t, srv), out: &syncBuffer{}}
	done := make(chan error, 1)
	go func() { done <- r.listen(input{rest: []string{"--exec", "true"}}) }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "a person's, not an agent's") || asked != 1 {
			t.Fatalf("listen refused ended with %v after %d asks", err, asked)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listen kept trying a refusal")
	}
}

// TestACompanionsCommandWorksAsTheCompanion: the command listen runs for
// an item gets the companion's own login and workspace, never one it
// inherited, so the lines the item carries work where it was heard.
func TestACompanionsCommandWorksAsTheCompanion(t *testing.T) {
	inherited := []string{"PATH=/bin", "QUADIT_URL=http://elsewhere", "QUADIT_TOKEN=other", "QUADIT_WORKSPACE=acme", "QUADIT_CONFIG=/other.json"}
	t.Run("a login from a file", func(t *testing.T) {
		env := childEnv(inherited, &Client{login: "/logins/claude-acme.json"}, acme.ID)
		if want := []string{"PATH=/bin", "QUADIT_CONFIG=/logins/claude-acme.json", "QUADIT_WORKSPACE=" + acme.ID}; !slices.Equal(env, want) {
			t.Fatalf("the environment %q, want %q", env, want)
		}
	})
	t.Run("a login from QUADIT_URL and QUADIT_TOKEN keeps them", func(t *testing.T) {
		env := childEnv(inherited, &Client{URL: "http://elsewhere", Token: "other"}, acme.ID)
		if want := []string{"PATH=/bin", "QUADIT_URL=http://elsewhere", "QUADIT_TOKEN=other", "QUADIT_CONFIG=/other.json", "QUADIT_WORKSPACE=" + acme.ID}; !slices.Equal(env, want) {
			t.Fatalf("the environment %q, want %q", env, want)
		}
	})
}
