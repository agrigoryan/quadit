package server_test

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// localhostServer makes a test server, not yet started, that is called by
// the name "localhost" (passkeys need a name, not an address), and answers
// on both addresses that name can mean.
//
// A server on 127.0.0.1 alone is not enough: a client given the name tries
// ::1 first, and another program that happens to listen on the same port
// there (a second test binary, on a busy machine) answers in its place. The
// test then fails with "connection reset by peer" on its first request.
func localhostServer(t *testing.T) (hs *httptest.Server, base string) {
	t.Helper()
	for range 50 {
		hs = httptest.NewUnstartedServer(nil)
		_, port, _ := net.SplitHostPort(hs.Listener.Addr().String())
		six, err := net.Listen("tcp6", "[::1]:"+port)
		switch {
		case err == nil:
			hs.Listener = bothLoopbacks(hs.Listener, six)
		case errors.Is(err, syscall.EADDRINUSE):
			// Someone else holds that port on ::1: take another.
			_ = hs.Listener.Close() // the next one replaces it
			continue
		default:
			// No ::1 on this machine: nobody else can be listening there either.
		}
		return hs, "http://localhost:" + port
	}
	t.Fatal("no port free on both 127.0.0.1 and ::1")
	return nil, ""
}

// loopbacks accepts connections from two listeners as one.
type loopbacks struct {
	net.Listener // the one whose address the server reports
	other        net.Listener
	accepted     chan accepted
	closed       chan struct{}
	closing      sync.Once
	closeErr     error
}

type accepted struct {
	conn net.Conn
	err  error
}

func bothLoopbacks(four, six net.Listener) net.Listener {
	l := &loopbacks{Listener: four, other: six, accepted: make(chan accepted), closed: make(chan struct{})}
	for _, from := range []net.Listener{four, six} {
		go func() {
			for {
				conn, err := from.Accept()
				select {
				case l.accepted <- accepted{conn, err}:
				case <-l.closed:
					if conn != nil {
						_ = conn.Close() // nobody is left to serve it
					}
					return
				}
				if err != nil {
					return
				}
			}
		}()
	}
	return l
}

func (l *loopbacks) Accept() (net.Conn, error) {
	select {
	case a := <-l.accepted:
		return a.conn, a.err
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *loopbacks) Close() error {
	l.closing.Do(func() {
		close(l.closed)
		l.closeErr = errors.Join(l.Listener.Close(), l.other.Close())
	})
	return l.closeErr
}

func TestLocalhostServerAnswersOnBothLoopbacks(t *testing.T) {
	t.Parallel()
	hs, base := localhostServer(t)
	hs.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "it is me") })
	hs.Start()
	defer hs.Close()
	port := base[strings.LastIndex(base, ":")+1:]
	for _, host := range []string{"127.0.0.1", "[::1]"} {
		res, err := http.Get("http://" + host + ":" + port)
		if err != nil {
			if host == "[::1]" && errors.Is(err, syscall.EADDRNOTAVAIL) {
				continue // no ::1 on this machine
			}
			t.Fatalf("%s: %v", host, err)
		}
		said, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if string(said) != "it is me" {
			t.Fatalf("%s answered %q: someone else is on that port", host, said)
		}
	}
}
