package app

import (
	"net"
	"net/http"
	"net/netip"
	"os"
	"slices"
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
// will exit with.
func startServe(t *testing.T, flags ...string) (string, <-chan int) {
	t.Helper()
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
