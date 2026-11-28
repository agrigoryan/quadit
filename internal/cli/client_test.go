package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// flakyServer answers like the API, except that the first request it gets
// has its connection dropped before any answer: a server that could not be
// reached once.
type flakyServer struct {
	mu     sync.Mutex
	bodies []string
	answer func(w http.ResponseWriter, r *http.Request)
}

func (f *flakyServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.bodies = append(f.bodies, string(body))
	first := len(f.bodies) == 1
	f.mu.Unlock()
	if first {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
		return
	}
	f.answer(w, r)
}

func (f *flakyServer) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

func testClient(t *testing.T, h http.Handler) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &Client{URL: srv.URL, Token: "t", HTTP: &http.Client{Timeout: requestTimeout}, ws: testWorkspace}
}

// testWorkspace is the workspace of a testClient's login, as the index
// would hold it.
var testWorkspace = workspaceRef{ID: fakeWorkspaceID, Slug: "personal", Name: "Personal"}

func answerChange(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"results":[{"type":"task.update","seq":7,"key":"SVA-1"}]}`)
}

func TestAChangeIsSentAgainWhenTheServerCouldNotBeReached(t *testing.T) {
	flaky := &flakyServer{answer: answerChange}
	c := testClient(t, flaky)
	res, err := c.Change(context.Background(), "task.update", map[string]any{"id": "SVA-1"}, ChangeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Seq != 7 {
		t.Fatalf("result %+v", res)
	}
	sent := flaky.requests()
	if len(sent) != 2 {
		t.Fatalf("sent %d times, want 2", len(sent))
	}
	if sent[0] != sent[1] {
		t.Fatalf("the second try was not the same change under the same id:\n%s\n%s", sent[0], sent[1])
	}
}

func TestARequestThatIsNotAChangeIsSentOnce(t *testing.T) {
	flaky := &flakyServer{answer: func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "me\n") }}
	c := testClient(t, flaky)
	if _, err := c.Text(context.Background(), "/me", nil); err == nil || !strings.Contains(err.Error(), "cannot reach") {
		t.Fatalf("err = %v, want cannot reach", err)
	}
	if n := len(flaky.requests()); n != 1 {
		t.Fatalf("sent %d times, want 1", n)
	}
}

func TestAnUnreachableServerInCodexSandboxSaysToRunOutsideIt(t *testing.T) {
	// Each server drops its first request: one for each try.
	unreached := func() error {
		flaky := &flakyServer{answer: func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "me\n") }}
		_, err := testClient(t, flaky).Text(context.Background(), "/me", nil)
		return err
	}
	if plain := unreached(); plain == nil || strings.Contains(plain.Error(), "sandbox") {
		t.Fatalf("err = %v, want cannot reach and nothing about a sandbox", plain)
	}

	t.Setenv("CODEX_SANDBOX_NETWORK_DISABLED", "1")
	err := unreached()
	if err == nil || !strings.Contains(err.Error(), "cannot reach") || !strings.Contains(err.Error(), "outside the sandbox") {
		t.Fatalf("err = %v, want cannot reach and to run it outside the sandbox", err)
	}
}

func TestARefusalIsNotSentAgain(t *testing.T) {
	var calls int
	var mu sync.Mutex
	c := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":{"code":"conflict","message":"SVA-1 is taken"}}`)
	}))
	_, err := c.Change(context.Background(), "task.create", map[string]any{}, ChangeOptions{})
	var refusal *APIError
	if !errors.As(err, &refusal) || refusal.Code != "conflict" || refusal.Status != http.StatusConflict {
		t.Fatalf("err = %#v", err)
	}
	if calls != 1 {
		t.Fatalf("sent %d times, want 1", calls)
	}
}

func TestAnAnswerCutShortIsAnError(t *testing.T) {
	c := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
		_ = buf.Flush()
		conn.Close()
	}))
	text, err := c.Text(context.Background(), "/me", nil)
	if err == nil {
		t.Fatalf("got %q and no error from an answer cut short", text)
	}
}

func TestABrokenConfigFileIsSaid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("QUADIT_CONFIG", path)
	t.Setenv("QUADIT_URL", "")
	t.Setenv("QUADIT_TOKEN", "")
	_, _, err := openLogin(context.Background(), workspaceAsk{})
	var syntax *json.SyntaxError
	if !errors.As(err, &syntax) || !strings.Contains(err.Error(), path) {
		t.Fatalf("err = %v, want the config file's syntax error", err)
	}
}

// TestTheServerAndTokenComeAsAPair: the environment is used only when it
// names both the server and the token; otherwise the saved login is used
// whole, so a token saved for one server is never sent to another.
func TestTheServerAndTokenComeAsAPair(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"url":"https://a.example","token":"qd_a"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("QUADIT_CONFIG", path)
	for _, tc := range []struct {
		name, url, token string
		want             Client
	}{
		{"both set", "https://b.example", "qd_b", Client{URL: "https://b.example", Token: "qd_b"}},
		{"only the server set", "https://b.example", "", Client{URL: "https://a.example", Token: "qd_a"}},
		{"only the token set", "", "qd_b", Client{URL: "https://a.example", Token: "qd_a"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("QUADIT_URL", tc.url)
			t.Setenv("QUADIT_TOKEN", tc.token)
			c, _, err := openLogin(context.Background(), workspaceAsk{})
			if err != nil {
				t.Fatal(err)
			}
			if c.URL != tc.want.URL || c.Token != tc.want.Token {
				t.Fatalf("got %s with %s, want %s with %s", c.URL, c.Token, tc.want.URL, tc.want.Token)
			}
		})
	}
}
