package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestMain is the test binary, unless a test started it as quadit serve
// (serveApart): then it is that, with the arguments it was given.
func TestMain(m *testing.M) {
	if spec := os.Getenv("QUADIT_TEST_SERVE"); spec != "" {
		var args []string
		if err := json.Unmarshal([]byte(spec), &args); err != nil {
			os.Exit(2)
		}
		os.Exit(Serve(args, "test"))
	}
	os.Exit(m.Run())
}

// TestServeStopsWhenItsInputCloses: with --stop-on-stdin-close the server
// shuts down once its standard input closes, which is how the desktop app
// stops it on every system, and how it ends with the app however the app
// ends; without the flag standard input is none of its business, and a
// server whose input is closed from the start (under a service manager)
// runs on until it is asked to stop as the system asks (askToStop). Either
// way the shutdown is the whole one (stoppedCleanly). Each server is a
// process of its own, as the app and a service manager see it.
func TestServeStopsWhenItsInputCloses(t *testing.T) {
	t.Run("with the flag", func(t *testing.T) {
		input, held := pipe(t)
		server := serveApart(t, apart{input: input}, "--stop-on-stdin-close")
		held.Close()
		server.stoppedCleanly(t)
	})

	t.Run("without it", func(t *testing.T) {
		server := serveApart(t, apart{}) // the null device: its input ends at once
		res, err := http.Get(server.url + "/readyz")
		if err != nil {
			t.Fatalf("the server does not answer: %v", err)
		}
		res.Body.Close()
		askToStop(t, server.cmd)
		server.stoppedCleanly(t)
	})
}

// TestServeStartsWithABareEnvironment: the server starts and stops with
// little more than PATH in its environment (and on Windows the system's
// own folder, SystemRoot), as a program that starts it may give it; on
// Windows its temporary files then go in its data directory.
func TestServeStartsWithABareEnvironment(t *testing.T) {
	env := []string{"PATH=" + os.Getenv("PATH")}
	if runtime.GOOS == "windows" {
		env = append(env, "SystemRoot="+os.Getenv("SystemRoot"))
	}
	input, held := pipe(t)
	server := serveApart(t, apart{input: input, env: env}, "--stop-on-stdin-close")
	// Windows would give it the Windows folder for its temporary files.
	if info, err := os.Stat(filepath.Join(server.data, "tmp")); runtime.GOOS == "windows" && (err != nil || !info.IsDir()) {
		t.Errorf("the server has no temporary folder of its own: %v", err)
	}
	held.Close()
	server.stoppedCleanly(t)
}

// servedApart is quadit serve running in a process of its own.
type servedApart struct {
	url  string
	data string // its data directory
	cmd  *exec.Cmd
	done chan int // what it exits with, once it has
	log  func() string
}

// apart is how a server is started in a process of its own: what its
// standard input reads (nil: the null device), and its environment (nil:
// the test's, without its QUADIT_ settings).
type apart struct {
	input io.Reader
	env   []string
}

// serveApart runs quadit serve with extra flags in a process of its own (this
// test binary, by TestMain) on a new data directory and a free port, and
// waits until it is ready.
func serveApart(t *testing.T, how apart, flags ...string) *servedApart {
	t.Helper()
	listen, data := freeAddress(t), t.TempDir()
	spec, err := json.Marshal(append([]string{"--data", data, "--listen", listen, "--url", "http://" + listen}, flags...))
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^$")
	env := how.env
	if env == nil {
		env = slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "QUADIT_") })
	}
	cmd.Env = append(env, "QUADIT_TEST_SERVE="+string(spec))
	cmd.SysProcAttr = stoppableProcess()
	var log strings.Builder
	cmd.Stdin, cmd.Stdout, cmd.Stderr = how.input, &log, &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	server := &servedApart{url: "http://" + listen, data: data, cmd: cmd, done: make(chan int, 1)}
	waited := make(chan struct{})
	server.log = func() string { <-waited; return log.String() } // written until the process is gone
	go func() {
		defer close(waited)
		_ = cmd.Wait() // its exit code is what counts, read below
		server.done <- cmd.ProcessState.ExitCode()
	}()
	// The data directory is removed after the server is gone: Windows does
	// not remove files a running process holds open.
	t.Cleanup(func() {
		_ = cmd.Process.Kill() // gone already when the test stopped it
		<-waited
		if t.Failed() {
			t.Logf("quadit serve said:\n%s", log.String())
		}
	})
	deadline := time.Now().Add(20 * time.Second)
	for {
		res, err := http.Get(server.url + "/readyz")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return server
			}
		}
		select {
		case <-waited:
			t.Fatalf("quadit serve exited %d before it was ready:\n%s", cmd.ProcessState.ExitCode(), log.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("quadit serve was not ready on %s within 20 s", server.url)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// stoppedCleanly checks that the server, told to stop, stopped as it
// should: exited 0 having shut down within its time, its address no longer
// answering, its data directory free for the next server, and its database
// and files closed (on Windows an open file cannot be removed).
func (s *servedApart) stoppedCleanly(t *testing.T) {
	t.Helper()
	if code := waitForExit(t, s.done); code != 0 {
		t.Fatalf("quadit serve exited %d, want 0", code)
	}
	said := s.log()
	if !strings.Contains(said, "shutting down") || strings.Contains(said, "did not end in time") || strings.Contains(said, "cut off") {
		t.Fatalf("the shutdown was not the whole one:\n%s", said)
	}
	if _, err := http.Get(s.url + "/readyz"); err == nil {
		t.Fatal("the server still answers after it stopped")
	}
	release, err := lockData(s.data)
	if err != nil {
		t.Fatalf("the data directory is still held: %v", err)
	}
	release()
	if err := os.RemoveAll(s.data); err != nil {
		t.Fatalf("the server left its files open: %v", err)
	}
}

// pipe is a pipe whose reading end is to be a server's input and whose
// writing end the test holds; both are closed after the test.
func pipe(t *testing.T) (input, held *os.File) {
	t.Helper()
	input, held, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		input.Close()
		held.Close()
	})
	return input, held
}

// freeAddress is an address on this computer that nothing listens at.
func freeAddress(t *testing.T) string {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	return probe.Addr().String()
}

// TestServeTakesTheAppKeyFromItsInput: with --app-key-stdin the server
// reads the key of the app that runs it from the first line of its input
// before it listens, and takes requests that carry it as that app's; the
// rest of the input is still only waited through, and its end still stops
// the server. A key that is missing or too short stops the start, and is
// never written to the log.
func TestServeTakesTheAppKeyFromItsInput(t *testing.T) {
	const key = "a2V5LW9mLXRoZS1hcHAtdGhhdC1ydW5zLXRoaXMtc2VydmVyLTEyMzQ"
	t.Run("a key", func(t *testing.T) {
		input := pipeAsStdin(t)
		if _, err := input.WriteString(key + "\n"); err != nil {
			t.Fatal(err)
		}
		url, done := startServe(t, "--stop-on-stdin-close", "--app-key-stdin")
		if _, err := input.WriteString("anything else the app sends\n"); err != nil {
			t.Fatal(err)
		}
		app := func(key string) int {
			req, _ := http.NewRequest(http.MethodPost, url+"/api/v1/auth/app-session", nil)
			req.Header.Set("X-Quadit-App-Key", key)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			return res.StatusCode
		}
		// Not set up yet: the app is known, and there is no owner to sign in.
		if got := app(key); got != http.StatusConflict {
			t.Errorf("an app session with the key: %d, want 409", got)
		}
		if got := app(key[1:]); got != http.StatusForbidden {
			t.Errorf("an app session with another key: %d, want 403", got)
		}
		input.Close()
		if code := waitForExit(t, done); code != 0 {
			t.Fatalf("quadit serve exited %d, want 0", code)
		}
	})

	for name, line := range map[string]string{"a short key": "c2hvcnQta2V5LXNob3J0LWtleQ\n", "no key": ""} {
		t.Run(name, func(t *testing.T) {
			withoutQuaditEnv(t)
			input := pipeAsStdin(t)
			if _, err := input.WriteString(line); err != nil {
				t.Fatal(err)
			}
			input.Close()
			log := pipeAsStderr(t)
			done := make(chan int, 1)
			go func() {
				done <- Serve([]string{"--data", t.TempDir(), "--listen", "127.0.0.1:0", "--stop-on-stdin-close", "--app-key-stdin"}, "test")
			}()
			if code := waitForExit(t, done); code != 1 {
				t.Fatalf("quadit serve exited %d, want 1", code)
			}
			said := log()
			if !strings.Contains(said, "--app-key-stdin") {
				t.Errorf("the log does not say why it stopped: %q", said)
			}
			if key := strings.TrimSpace(line); key != "" && strings.Contains(said, key) {
				t.Errorf("the log shows the key: %q", said)
			}
		})
	}
}

// TestServeWithAnAppKeyListensOnThisComputerOnly: a server the app runs
// with its key takes the app's set-up and sign-in, so it refuses to start
// on an address another computer can reach.
func TestServeWithAnAppKeyListensOnThisComputerOnly(t *testing.T) {
	const key = "a2V5LW9mLXRoZS1hcHAtdGhhdC1ydW5zLXRoaXMtc2VydmVyLTEyMzQ"
	for _, listen := range []string{":0", "0.0.0.0:0", "[::]:0", "192.168.1.20:0", "example.com:0"} {
		t.Run(listen, func(t *testing.T) {
			withoutQuaditEnv(t)
			input := pipeAsStdin(t)
			if _, err := input.WriteString(key + "\n"); err != nil {
				t.Fatal(err)
			}
			log := pipeAsStderr(t)
			done := make(chan int, 1)
			go func() {
				done <- Serve([]string{"--data", t.TempDir(), "--listen", listen, "--app-key-stdin"}, "test")
			}()
			if code := waitForExit(t, done); code != 1 {
				t.Fatalf("quadit serve exited %d, want 1", code)
			}
			if said := log(); !strings.Contains(said, "this computer") {
				t.Errorf("the log does not say why it stopped: %q", said)
			}
		})
	}
	for _, listen := range []string{"127.0.0.1:4780", "127.0.0.2:4780", "[::1]:4780", "localhost:4780"} {
		if !onThisComputer(listen) {
			t.Errorf("%s is taken as off this computer", listen)
		}
	}
}

// pipeAsStderr makes a pipe the process's standard error for the test, and
// gives what was written to it once called.
func pipeAsStderr(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stderr
	os.Stderr = w
	t.Cleanup(func() {
		os.Stderr = old
		r.Close()
	})
	return func() string {
		os.Stderr = old
		w.Close()
		said, _ := io.ReadAll(r) // a pipe of this process: the read ends at its close
		return string(said)
	}
}

// pipeAsStdin makes a pipe the process's standard input for the test and
// gives its writing end.
func pipeAsStdin(t *testing.T) *os.File {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = old
		w.Close()
		r.Close()
	})
	return w
}

// startServe runs quadit serve with extra flags on a new data directory and
// a free port, waits until it is ready, and gives its address and what it
// will exit with. None of the QUADIT_ settings of the environment the tests
// run in reach it: QUADIT_DB would open, and upgrade, a real database.
func startServe(t *testing.T, flags ...string) (string, <-chan int) {
	t.Helper()
	withoutQuaditEnv(t)
	listen := freeAddress(t)
	url := "http://" + listen
	done := make(chan int, 1)
	go func() {
		done <- Serve(append([]string{"--data", t.TempDir(), "--listen", listen, "--url", url}, flags...), "test")
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		res, err := http.Get(url + "/readyz")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return url, done
			}
		}
		select {
		case code := <-done:
			t.Fatalf("quadit serve exited %d before it was ready", code)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("quadit serve was not ready on %s within 20 s", url)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// withoutQuaditEnv takes the QUADIT_ settings of the environment the tests
// run in away for the test.
func withoutQuaditEnv(t *testing.T) {
	t.Helper()
	for _, item := range os.Environ() {
		if name, _, _ := strings.Cut(item, "="); strings.HasPrefix(name, "QUADIT_") {
			t.Setenv(name, "")
			_ = os.Unsetenv(name) // cannot fail for a name os.Environ gave; t.Setenv puts it back after the test
		}
	}
}

// waitForExit gives what quadit serve exited with, failing when it runs on.
func waitForExit(t *testing.T, done <-chan int) int {
	t.Helper()
	select {
	case code := <-done:
		return code
	case <-time.After(20 * time.Second):
		t.Fatal("quadit serve did not stop within 20 s")
		return 0
	}
}

// TestNetworksAreReadAsWritten: a list of networks in a flag or the
// environment takes networks and single addresses, split by commas or
// spaces; anything else stops the server rather than being left out.
func TestNetworksAreReadAsWritten(t *testing.T) {
	got, err := networks("10.0.0.0/8, 192.168.1.20 ::1,fd00::/8")
	want := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("192.168.1.20/32"), netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("fd00::/8")}
	if err != nil || !slices.Equal(got, want) {
		t.Fatalf("networks = %v, %v; want %v", got, err, want)
	}
	if got, err := networks(""); err != nil || len(got) != 0 {
		t.Fatalf("an empty list = %v, %v", got, err)
	}
	for _, bad := range []string{"192.168.1", "localhost", "10.0.0.0/33"} {
		if _, err := networks(bad); err == nil {
			t.Errorf("%q was taken", bad)
		}
	}
}

// TestAdminSetupMakesTheSamples: an install set up from the command line
// starts as one set up any other way, with the sample tasks and the
// owner's password, and is set up once.
func TestAdminSetupMakesTheSamples(t *testing.T) {
	dir := setUpInstall(t)
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "quadit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var projects, tasks, passwords int
	row := db.QueryRowContext(context.Background(), `SELECT
		(SELECT COUNT(*) FROM projects WHERE key = 'GS' AND samples IS NOT NULL),
		(SELECT COUNT(*) FROM tasks WHERE key LIKE 'GS-%'),
		(SELECT COUNT(*) FROM users WHERE email = 't@example.com' AND password_hash IS NOT NULL)`)
	if err := row.Scan(&projects, &tasks, &passwords); err != nil {
		t.Fatal(err)
	}
	if projects != 1 || tasks != 3 || passwords != 1 {
		t.Fatalf("after admin setup: %d sample projects, %d sample tasks, %d owners with a password", projects, tasks, passwords)
	}
	var code int
	stdoutOf(t, func() {
		code = Admin([]string{"setup", "--data", dir, "--name", "B", "--email", "b@example.com", "--password", "a long password", "--workspace", "again"}, "test")
	})
	if code == 0 {
		t.Fatal("setting a set-up install up again succeeded")
	}
}
