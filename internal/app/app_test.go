package app

import (
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestServeStopsWhenItsInputCloses: with --stop-on-stdin-close the server
// shuts down cleanly once its standard input closes, which is how a program
// that started it (the desktop app) ends it even when that program dies;
// without the flag standard input is none of its business, and a server
// whose input is closed from the start (under a service manager) runs on.
func TestServeStopsWhenItsInputCloses(t *testing.T) {
	t.Run("with the flag", func(t *testing.T) {
		input := pipeAsStdin(t)
		url, done := startServe(t, "--stop-on-stdin-close")
		input.Close()
		if code := waitForExit(t, done); code != 0 {
			t.Fatalf("quadit serve exited %d, want 0", code)
		}
		if _, err := http.Get(url + "/readyz"); err == nil {
			t.Fatal("the server still answers after it stopped")
		}
	})

	t.Run("without it", func(t *testing.T) {
		pipeAsStdin(t).Close()
		url, done := startServe(t)
		select {
		case code := <-done:
			t.Fatalf("quadit serve stopped (%d) because its input was closed", code)
		default:
		}
		res, err := http.Get(url + "/readyz")
		if err != nil {
			t.Fatalf("the server does not answer: %v", err)
		}
		res.Body.Close()
		// As a service manager stops it.
		if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
			t.Fatal(err)
		}
		if code := waitForExit(t, done); code != 0 {
			t.Fatalf("quadit serve exited %d, want 0", code)
		}
	})
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
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listen := probe.Addr().String()
	probe.Close()
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
