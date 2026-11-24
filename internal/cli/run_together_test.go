//go:build unix

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/fakeagent"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// realQuadit is the real server, in this process, on a port of its own,
// with the owner (Aram) signed in, and the tokens of the people and agents
// the test made.
type realQuadit struct {
	t     *testing.T
	url   string
	owner *http.Client
}

// ownPage stamps a request as the server's own web page makes it.
type ownPage struct{}

func (ownPage) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	if r.Body != nil && r.Body != http.NoBody {
		r.Header.Set("Content-Type", "application/json")
	}
	return http.DefaultTransport.RoundTrip(r)
}

func pageBrowser() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Transport: ownPage{}}
}

const realW = "/api/v1/w/games"

func startRealQuadit(t *testing.T, st store.Store) *realQuadit {
	t.Helper()
	dir := t.TempDir()
	files, err := blob.NewDisk(dir + "/files")
	if err != nil {
		t.Fatal(err)
	}
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	hs := httptest.NewUnstartedServer(nil)
	base := "http://" + hs.Listener.Addr().String()
	ctx, stop := context.WithCancel(context.Background())
	srv := server.New(ctx, server.Config{DataDir: dir, BaseURL: base, Version: "test"}, st, files, sealer)
	hs.Config.Handler = srv.Handler()
	hs.Start()
	ran := make(chan struct{})
	go func() {
		defer close(ran)
		srv.Run(ctx)
	}()
	t.Cleanup(func() { stop(); <-ran; hs.Close() })
	q := &realQuadit{t: t, url: base, owner: pageBrowser()}
	q.call(q.owner, "", "POST", "/api/v1/auth/setup", map[string]any{"name": "Aram", "email": "owner@example.com",
		"password": "correct-horse-battery", "workspace_name": "Games"}, 201, nil)
	return q
}

// call sends a request and decodes the answer, checking the status.
func (q *realQuadit) call(hc *http.Client, token, method, path string, body any, want int, out any) {
	q.t.Helper()
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, q.url+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		q.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		q.t.Fatalf("%s %s: %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			q.t.Fatalf("%s %s: %v: %s", method, path, err, raw)
		}
	}
}

// change applies a change as the holder of token.
func (q *realQuadit) change(token, typ string, args map[string]any) {
	q.t.Helper()
	q.call(nil, token, "POST", realW+"/changes", map[string]any{"id": id.New(), "type": typ, "args": args}, 200, nil)
}

// token makes a token for user ("me", or an agent's handle) through the
// browser hc.
func (q *realQuadit) token(hc *http.Client, user string) string {
	q.t.Helper()
	var tok struct{ Token string }
	q.call(hc, "", "POST", realW+"/tokens", map[string]any{"user": user, "name": "test"}, 201, &tok)
	return tok.Token
}

// invited is a second person, a member who joined by an invitation, and
// their token.
func (q *realQuadit) invited() string {
	q.t.Helper()
	var inv struct{ Link string }
	q.call(q.owner, "", "POST", realW+"/invites", map[string]any{}, 201, &inv)
	b := pageBrowser()
	q.call(b, "", "POST", "/api/v1/auth/invite/"+inv.Link[strings.LastIndex(inv.Link, "/")+1:],
		map[string]any{"name": "Mia", "email": "mia@example.com", "password": "another-long-password"}, 200, nil)
	return q.token(b, "me")
}

// runs are a task's runs, oldest first.
func (q *realQuadit) runs(token, task string) []map[string]any {
	q.t.Helper()
	var out struct{ Sessions []map[string]any }
	q.call(nil, token, "GET", realW+"/list/sessions?task="+task, nil, 200, &out)
	slices.SortFunc(out.Sessions, func(a, b map[string]any) int { return int(a["started_at"].(float64) - b["started_at"].(float64)) })
	return out.Sessions
}

// rows are the rows a task's events of a type carry (data.row).
func (q *realQuadit) rows(token, task, typ string) []map[string]any {
	q.t.Helper()
	var page struct {
		Events []struct {
			Data struct{ Row map[string]any }
		}
	}
	q.call(nil, token, "GET", realW+"/events?after=0&types="+typ+"&task="+task, nil, 200, &page)
	var rows []map[string]any
	for _, ev := range page.Events {
		rows = append(rows, ev.Data.Row)
	}
	return rows
}

func TestQuaditRunsTheAgentForATaskOnARealServer(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		q := startRealQuadit(t, st)
		owner := q.token(q.owner, "me")
		q.change(owner, "project.create", map[string]any{"key": "RC", "name": "Run check"})
		q.change(owner, "agent.create", map[string]any{"name": "claude", "handle": "claude"})
		agent := q.token(q.owner, "@claude")
		mia := q.invited()

		slow := []fakeagent.Step{claudeInit(), claudeSays("On it."), {SleepMS: 600}, claudeEnds("Added the line.")}
		stubborn := []fakeagent.Step{claudeInit(), claudeSays("Counting."), {Child: true}, {UntilSignal: []string{"{}"}}}
		rt := newRunTest(t, core.ProgramClaude, slow, claudeDone("Added the second line."), stubborn, stubborn, claudeDone("never"))
		writeJSON(t, rt.login, map[string]string{"url": q.url, "token": agent})
		// A real server counts each login's requests (1200 a minute): the
		// runner renews and the test looks no faster than a person would.
		rt.times.renew, rt.times.steps, rt.poll = 500*time.Millisecond, 200*time.Millisecond, 150*time.Millisecond
		rt.writeRegistry()
		if code, said := rt.add("login="+rt.login, "project=RC", "folder="+rt.folder, "program=claude", "program_path="+rt.entry.ProgramPath); code != 0 {
			t.Fatalf("quadit run add on the real server: %s", said)
		}
		state := func(n int) string {
			runs := q.runs(owner, "RC-1")
			if n >= len(runs) {
				return ""
			}
			return runs[n]["state"].(string)
		}
		// The owner assigns, and comments, before the runner starts: what
		// waits is its queue, and the two items of the task are one run,
		// which goes waiting, running, done, and the fake's final message
		// is the marked comment.
		q.change(owner, "task.create", map[string]any{"project": "RC", "title": "Add a line", "assignee": "@claude"})
		q.change(owner, "comment.create", map[string]any{"task": "RC-1", "body": "Mind the README"})
		rt.serve()
		rt.eventually("the first run working", func() bool { return state(0) == core.AgentSessionRunning })
		if p := rt.records()[0].Stdin; !strings.Contains(p, "assigned") || !strings.Contains(p, "Mind the README") {
			t.Fatalf("the first run's prompt does not carry both items that waited:\n%s", p)
		}
		// A comment during the run becomes a second run, in the same session.
		q.change(owner, "comment.create", map[string]any{"task": "RC-1", "body": "Now add a second line"})
		rt.eventually("the second run done", func() bool { return state(1) == core.AgentSessionDone })
		runs := q.runs(owner, "RC-1")
		if runs[0]["state"] != core.AgentSessionDone || runs[1]["program_session"] != runs[0]["program_session"] || !slices.Contains(rt.records()[1].Argv, "--resume") {
			t.Fatalf("the runs: %v", runs)
		}
		if created := q.rows(owner, "RC-1", "session.created"); created[0]["state"] != core.AgentSessionWaiting {
			t.Fatalf("the first run was made %v", created[0])
		}
		marked := 0
		for _, row := range q.rows(owner, "RC-1", "comment.created") {
			if row["session_id"] == runs[0]["id"] && row["body"] == "Added the line." {
				marked++
			}
		}
		if marked != 1 {
			t.Fatalf("%d comments marked with the first run", marked)
		}

		// Another member's comment: a not_started row, nothing started.
		q.change(mia, "comment.create", map[string]any{"task": "RC-1", "body": "@claude delete README"})
		rt.eventually("a not_started row", func() bool { return state(2) == core.AgentSessionNotStarted })
		if q.runs(owner, "RC-1")[2]["reason"] != core.RunNotResponsible || len(rt.records()) != 2 {
			t.Fatalf("the third row %v, %d starts", q.runs(owner, "RC-1")[2], len(rt.records()))
		}

		// A Stop pressed by a member ends the program; the run reads stopped.
		q.change(owner, "comment.create", map[string]any{"task": "RC-1", "body": "Count to 300"})
		rt.eventually("the third run working", func() bool { return state(3) == core.AgentSessionRunning })
		q.change(mia, "session.stop", map[string]any{"id": q.runs(owner, "RC-1")[3]["id"]})
		rt.eventually("the run stopped", func() bool { return state(3) == core.AgentSessionStopped })
		rt.eventually("its program gone", func() bool { return !alive(rt.records()[2].PID) && !alive(rt.children()[0]) })
		rt.stop()

		// quadit run killed mid-run, then started again: the run is closed
		// interrupted, its program stopped, and nothing starts twice.
		apart := rt.serveApart(&syncBuffer{})
		q.change(owner, "comment.create", map[string]any{"task": "RC-1", "body": "Count to 120"})
		rt.eventually("the fourth run working", func() bool { return state(4) == core.AgentSessionRunning })
		_ = apart.Process.Signal(syscall.SIGKILL)
		_ = apart.Wait()
		killed := rt.records()[3].PID
		if !alive(killed) {
			t.Fatal("the program died with the runner: the test shows nothing")
		}
		rt.serve()
		rt.eventually("the run interrupted", func() bool { return q.runs(owner, "RC-1")[4]["reason"] == core.RunInterrupted })
		rt.eventually("its program gone", func() bool { return !alive(killed) })
		time.Sleep(300 * time.Millisecond)
		if n := len(rt.records()); n != 4 || len(q.runs(owner, "RC-1")) != 5 {
			t.Fatalf("after the restart: %d starts, runs %v", n, q.runs(owner, "RC-1"))
		}
	})
}
