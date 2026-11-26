package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeStarter stands in for starting the app: it counts its starts, and
// with serve brings a server up on the address that was refused; with
// already it says the app runs.
type fakeStarter struct {
	starts  int
	serve   func()
	fail    error
	already bool
}

func (f *fakeStarter) running(context.Context) bool { return f.already }

func (f *fakeStarter) start(context.Context, appLogin) error {
	f.starts++
	if f.fail != nil {
		return f.fail
	}
	if f.serve != nil {
		f.serve()
	}
	return nil
}

// downServer is an address of this computer where nothing listens, and a
// function that starts a server there answering /healthz and /me.
func downServer(t *testing.T) (base string, up func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	up = func() {
		l, err := net.Listen("tcp", addr)
		if err != nil {
			t.Error(err)
			return
		}
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/v1/version" {
				_, _ = io.WriteString(w, `{"name":"quadit","version":"test"}`)
				return
			}
			_, _ = io.WriteString(w, "you are @codex\n")
		}))
		srv.Listener.Close()
		srv.Listener = l
		srv.Start()
		t.Cleanup(srv.Close)
	}
	return "http://" + addr, up
}

// appClient is a client of base with a login the app marked, kept in dir.
func appClient(base, dir string, starter appStarter, stderr io.Writer) *Client {
	return &Client{URL: base, Token: "t", HTTP: &http.Client{Timeout: 5 * time.Second},
		app: &appStart{login: appLogin{Path: "/opt/Quadit/quadit"}, dir: dir, starter: starter, within: time.Second, stderr: stderr}}
}

func TestTheCommandStartsTheAppWhenItsServerIsNotRunning(t *testing.T) {
	t.Run("started and answering: said on stderr, and the request sent again", func(t *testing.T) {
		base, up := downServer(t)
		starter := &fakeStarter{serve: up}
		var stderr bytes.Buffer
		c := appClient(base, t.TempDir(), starter, &stderr)
		text, err := c.Text(context.Background(), "/me", nil)
		if err != nil || text != "you are @codex\n" || starter.starts != 1 {
			t.Fatalf("the request answered %q, %v after %d starts", text, err, starter.starts)
		}
		if stderr.String() != "Quadit was not running; started it.\n" {
			t.Fatalf("stderr said %q", stderr.String())
		}
	})

	t.Run("started and never answering, or not started: the error says to open the app", func(t *testing.T) {
		for name, starter := range map[string]*fakeStarter{"never answering": {}, "not started": {fail: errors.New("no app")}} {
			base, _ := downServer(t)
			var stderr bytes.Buffer
			_, err := appClient(base, t.TempDir(), starter, &stderr).Text(context.Background(), "/me", nil)
			if err == nil || !strings.HasSuffix(err.Error(), "\n  Quadit could not be started: open the Quadit app.") || stderr.Len() != 0 {
				t.Fatalf("%s: the request ended with %v, stderr %q", name, err, stderr.String())
			}
		}
	})

	t.Run("running already: nothing started, the server waited for", func(t *testing.T) {
		base, up := downServer(t)
		starter := &fakeStarter{already: true}
		var stderr bytes.Buffer
		go func() {
			time.Sleep(100 * time.Millisecond) // the server comes up while the command waits
			up()
		}()
		text, err := appClient(base, t.TempDir(), starter, &stderr).Text(context.Background(), "/me", nil)
		if err != nil || text != "you are @codex\n" || starter.starts != 0 || stderr.Len() != 0 {
			t.Fatalf("the request answered %q, %v after %d starts; stderr %q", text, err, starter.starts, stderr.String())
		}
	})

	t.Run("running already and its server never answering: the error says to look at its menu", func(t *testing.T) {
		base, _ := downServer(t)
		starter := &fakeStarter{already: true}
		_, err := appClient(base, t.TempDir(), starter, io.Discard).Text(context.Background(), "/me", nil)
		if err == nil || !strings.HasSuffix(err.Error(), "\n  Quadit is running but its server does not answer: look at the Quadit menu.") || starter.starts != 0 {
			t.Fatalf("the request ended with %v after %d starts", err, starter.starts)
		}
	})

	t.Run("one attempt in a run", func(t *testing.T) {
		base, _ := downServer(t)
		starter := &fakeStarter{}
		c := appClient(base, t.TempDir(), starter, io.Discard)
		for range 2 {
			if _, err := c.Text(context.Background(), "/me", nil); err == nil {
				t.Fatal("a server that is not there answered")
			}
		}
		if starter.starts != 1 {
			t.Fatalf("the app was started %d times in one run", starter.starts)
		}
	})

	t.Run("stopped on purpose: nothing started, and every failure of the run says so", func(t *testing.T) {
		base, _ := downServer(t)
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "server-stopped"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		starter := &fakeStarter{}
		c := appClient(base, dir, starter, io.Discard)
		for i := range 2 { // a change is sent again when the server is not reached
			_, err := c.Text(context.Background(), "/me", nil)
			if err == nil || !strings.HasSuffix(err.Error(), "\n  Quadit's server is stopped: start it from the Quadit menu.") || starter.starts != 0 {
				t.Fatalf("request %d ended with %v after %d starts", i+1, err, starter.starts)
			}
		}
	})

	t.Run("something else answering there is not Quadit: nothing is sent to it", func(t *testing.T) {
		base, _ := downServer(t)
		other := func() {
			l, err := net.Listen("tcp", strings.TrimPrefix(base, "http://"))
			if err != nil {
				t.Error(err)
				return
			}
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }))
			srv.Listener.Close()
			srv.Listener = l
			srv.Start()
			t.Cleanup(srv.Close)
		}
		_, err := appClient(base, t.TempDir(), &fakeStarter{serve: other}, io.Discard).Text(context.Background(), "/me", nil)
		if err == nil || !strings.HasSuffix(err.Error(), "\n  Quadit could not be started: open the Quadit app.") {
			t.Fatalf("the request ended with %v", err)
		}
	})

	t.Run("a file going up is not sent twice: the app is started and the command asked for again", func(t *testing.T) {
		base, up := downServer(t)
		c := appClient(base, t.TempDir(), &fakeStarter{serve: up}, io.Discard)
		_, err := c.workspaceRequest(context.Background(), apiRequest{method: http.MethodPost, path: "/files", body: io.LimitReader(strings.NewReader("bytes"), 5)})
		if err == nil || !strings.HasSuffix(err.Error(), "\n  Quadit was not running; started it. Run the command again.") {
			t.Fatalf("the upload ended with %v", err)
		}
	})

	t.Run("a login the app did not make starts nothing", func(t *testing.T) {
		base, _ := downServer(t)
		c := &Client{URL: base, Token: "t", HTTP: &http.Client{Timeout: time.Second}}
		_, err := c.Text(context.Background(), "/me", nil)
		if err == nil || strings.Contains(err.Error(), "Quadit") && strings.Contains(err.Error(), "started") {
			t.Fatalf("the request ended with %v", err)
		}
	})
}

// TestTheAppIsStartedOnlyForItsServerNotRunning: only a refusal at the
// connection, from an address of this computer, outside a sandbox that
// keeps the command off the network, means the app's server is not
// running.
func TestTheAppIsStartedOnlyForItsServerNotRunning(t *testing.T) {
	// A refusal as this system gives it: each has its own error for one.
	down, _ := downServer(t)
	_, refusedErr := http.Get(down)
	if refusedErr == nil {
		t.Fatal("an address where nothing listens answered")
	}
	timeout := &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ETIMEDOUT)}
	cases := []struct {
		name    string
		base    string
		err     error
		sandbox bool
		want    bool
	}{
		{"refused on this computer", "http://127.0.0.1:4780", refusedErr, false, true},
		{"refused at localhost", "http://localhost:4780", refusedErr, false, true},
		{"refused at ::1", "http://[::1]:4780", refusedErr, false, true},
		{"refused elsewhere", "https://quadit.example.com", refusedErr, false, false},
		{"refused on a private network", "http://192.168.1.5:4780", refusedErr, false, false},
		{"a timeout", "http://127.0.0.1:4780", timeout, false, false},
		{"a deadline", "http://127.0.0.1:4780", context.DeadlineExceeded, false, false},
		{"in a sandbox without network", "http://127.0.0.1:4780", refusedErr, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.sandbox {
				t.Setenv("CODEX_SANDBOX_NETWORK_DISABLED", "1")
			}
			starter := &fakeStarter{fail: errors.New("not started, only counted")}
			a := &appStart{starter: starter, dir: t.TempDir(), within: time.Millisecond, stderr: io.Discard}
			a.revive(context.Background(), http.DefaultClient, c.base, c.err, true)
			if got := starter.starts == 1; got != c.want {
				t.Fatalf("started: %v, want %v", got, c.want)
			}
		})
	}
}

// TestTheAppIsStartedWithoutAShell: the command lines that start the app
// are argument lists: the bundle id on macOS, the recorded path on Linux
// and Windows (which must be a full path), and none elsewhere.
func TestTheAppIsStartedWithoutAShell(t *testing.T) {
	mac, err := appCommand("darwin", appLogin{Path: "/Applications/Quadit.app/Contents/MacOS/Quadit; rm -rf ~"})
	if err != nil || !slices.Equal(mac, []string{"/usr/bin/open", "-g", "-j", "-b", "io.github.agrigoryan.quadit", "--args", "--background"}) {
		t.Fatalf("macOS: %q, %v", mac, err)
	}
	linux, err := appCommand("linux", appLogin{Path: "/opt/Quadit/quadit desktop; echo $HOME"})
	if err != nil || !slices.Equal(linux, []string{"/opt/Quadit/quadit desktop; echo $HOME", "--background"}) {
		t.Fatalf("Linux: %q, %v", linux, err)
	}
	if _, err := appCommand("linux", appLogin{Path: "quadit"}); err == nil {
		t.Fatal("Linux: a path that is not a full one was taken")
	}
	// A full path as this computer writes one: C:\ on Windows, / elsewhere.
	exe := filepath.Join(os.TempDir(), "Programs", "Quadit", "Quadit.exe")
	windows, err := appCommand("windows", appLogin{Path: exe})
	if err != nil || !slices.Equal(windows, []string{exe, "--background"}) {
		t.Fatalf("Windows: %q, %v", windows, err)
	}
	if _, err := appCommand("windows", appLogin{Path: "Quadit.exe"}); err == nil {
		t.Fatal("Windows: a path that is not a full one was taken")
	}
	if _, err := appCommand("freebsd", appLogin{Path: exe}); err == nil {
		t.Fatal("FreeBSD: an app was to be started")
	}
	// Whether it runs on macOS is asked by its bundle id; the answer names it, or is empty.
	if argv := runningCommand(); !slices.Equal(argv, []string{"/usr/bin/lsappinfo", "find", "bundleid=io.github.agrigoryan.quadit"}) {
		t.Fatalf("running is asked with %q", argv)
	}
	if !appFound([]byte("ASN:0x0-0xe08e08-\"Quadit\":\n")) || appFound([]byte("\n")) {
		t.Fatal("lsappinfo's answer is misread")
	}
}

// TestLoginMarksALoginTheAppMakes: --app PATH puts the app's mark on the
// login; a login without it has none, even where the one before had.
func TestLoginMarksALoginTheAppMakes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "@codex\n") }))
	t.Cleanup(srv.Close)
	path := filepath.Join(t.TempDir(), "codex.json")
	t.Setenv("QUADIT_CONFIG", path)
	run := func(args ...string) savedConfig {
		t.Helper()
		var out, errs bytes.Buffer
		if code := login(context.Background(), args, strings.NewReader("qd_secret"), &out, &errs); code != 0 {
			t.Fatalf("exit %d: %s", code, errs.String())
		}
		c, err := NewClient()
		if err != nil {
			t.Fatal(err)
		}
		var saved savedConfig
		saved.URL, saved.Token = c.URL, c.Token
		if c.app != nil {
			saved.App = &c.app.login
		}
		return saved
	}
	if saved := run(srv.URL, "-", "--app", "/Applications/Quadit.app/Contents/MacOS/Quadit"); saved.App == nil || saved.App.Path != "/Applications/Quadit.app/Contents/MacOS/Quadit" {
		t.Fatalf("the app's login was saved as %+v", saved)
	}
	if saved := run(srv.URL, "-"); saved.App != nil {
		t.Fatalf("a login made by hand kept the app's mark: %+v", saved.App)
	}
}
