package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// inboxServer answers listen as the API does for an inbox of a few items:
// GET /events reads after the cursor, at most limit= items, and answers
// the lease "L1"; PUT /cursors moves it; POST /secrets/env fails the first
// time it is asked. It keeps the lease each read and move was sent with.
type inboxServer struct {
	mu          sync.Mutex
	items       []int64 // the seqs of the inbox items
	cursor      int64
	acks        []int64
	leases      []string
	secretAsked int
}

func (s *inboxServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/events"):
		limit := 200
		if l := r.URL.Query().Get("limit"); l != "" {
			limit, _ = strconv.Atoi(l)
		}
		lines, seq := []string{}, s.cursor
		for _, item := range s.items {
			if item > s.cursor && len(lines) < limit {
				lines = append(lines, "#"+strconv.FormatInt(item, 10)+" @mia assigned you SVA-1")
				seq = item
			}
		}
		if len(lines) == 0 {
			seq = s.items[len(s.items)-1]
		}
		s.leases = append(s.leases, r.URL.Query().Get("lease"))
		_ = json.NewEncoder(w).Encode(map[string]any{"events": lines, "seq": seq, "lease": "L1"})
	case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/cursors/"):
		var body struct {
			Seq   int64
			Lease string
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.acks = append(s.acks, body.Seq)
		s.leases = append(s.leases, body.Lease)
		s.cursor = max(s.cursor, body.Seq)
		_, _ = io.WriteString(w, `{}`)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/secrets/env"):
		s.secretAsked++
		if s.secretAsked == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"error":{"code":"unavailable","message":"the vault is away"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"env":{"KEY":"v"}}`)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *inboxServer) state() (cursor int64, acks []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cursor, append([]int64(nil), s.acks...)
}

// syncBuffer is a bytes.Buffer that listen can write to while the test reads.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestListenAcknowledgesOnlyWhatItsCommandHandled: an inbox item whose
// command could not run (its secrets were not given) or failed is not
// marked handled; listen tries it again, and the items after it wait.
func TestListenAcknowledgesOnlyWhatItsCommandHandled(t *testing.T) {
	srv := &inboxServer{items: []int64{3, 5, 8}}
	dir := t.TempDir()
	runs := filepath.Join(dir, "runs")
	// The command fails the first time it is given item #5.
	script := `printf '%s\n' "$QUADIT_EVENT" >> "$0"; case "$QUADIT_EVENT" in '#5'*) [ "$(grep -c '^#5' "$0")" -ge 2 ];; esac`
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &syncBuffer{}
	r := &runner{ctx: ctx, c: testClient(t, srv), out: out}
	done := make(chan error, 1)
	go func() {
		done <- r.listen(input{rest: []string{"--secret", "KEY", "--exec", "sh", "-c", script, runs}})
	}()

	deadline := time.Now().Add(20 * time.Second)
	for {
		if cursor, _ := srv.state(); cursor == 8 {
			break
		}
		if time.Now().After(deadline) {
			cursor, acks := srv.state()
			t.Fatalf("the cursor stands at %d (acks %v), want 8; listen said:\n%s", cursor, acks, out)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("listen did not stop when its context ended; it said:\n%s", out)
	}

	ran, err := os.ReadFile(runs)
	if err != nil {
		t.Fatal(err)
	}
	var seqs []string
	for line := range strings.SplitSeq(strings.TrimSpace(string(ran)), "\n") {
		seqs = append(seqs, strings.Fields(line)[0])
	}
	// #3 is run once its secrets come (the first try never ran the
	// command), #5 twice, and #8 only after #5 was handled.
	if got := strings.Join(seqs, " "); got != "#3 #5 #5 #8" {
		t.Fatalf("the command ran for %s, want #3 #5 #5 #8; listen said:\n%s", got, out)
	}
	_, acks := srv.state()
	for i := 1; i < len(acks); i++ {
		if acks[i] < acks[i-1] {
			t.Fatalf("the acks went back: %v", acks)
		}
	}
	if strings.Count(out.String(), "not handled") != 2 {
		t.Fatalf("listen did not say, twice, that an item was not handled and would be tried again:\n%s", out)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	for i, lease := range srv.leases[1:] {
		if lease != "L1" {
			t.Fatalf("read or move %d after the first was sent with the lease %q, want the one the server gave (L1): %v", i+2, lease, srv.leases)
		}
	}
}

// refusingListener refuses every read of the listener's cursor, as the
// server does while another session holds its lease.
func refusingListener(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	_, _ = io.WriteString(w, `{"error":{"code":"conflict","reason":"listening_elsewhere","field":"lease","message":"@coder is already listening from another session (last heard 14:02 UTC)"}}`)
}

// TestListenStopsWhenAnotherSessionListens: listen does not keep trying
// while another session holds the lease; it says so and ends.
func TestListenStopsWhenAnotherSessionListens(t *testing.T) {
	r := &runner{ctx: context.Background(), c: testClient(t, http.HandlerFunc(refusingListener)), out: &syncBuffer{}}
	err := r.listen(input{rest: []string{"--exec", "true"}})
	if err == nil || !strings.Contains(err.Error(), "already listening from another session") {
		t.Fatalf("listen refused the lease ended with %v", err)
	}
}

// listenServer answers GET /listen as the API does: it holds a request for
// its wait= seconds unless an item is there, answers the lease "L1", and
// keeps what each request asked.
type listenServer struct {
	mu    sync.Mutex
	item  string // the item's JSON, or "" for none
	asked []url.Values
}

func (s *listenServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s.mu.Lock()
	s.asked = append(s.asked, q)
	item := s.item
	s.mu.Unlock()
	if item == "" {
		wait, _ := strconv.Atoi(q.Get("wait"))
		time.Sleep(time.Duration(wait) * time.Second)
		item = "null"
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"lease":"L1","seq":40,"item":`+item+`}`)
}

func TestWaitPrintsOneRecordToActOn(t *testing.T) {
	t.Run("an item is printed with the commands to read it, acknowledge it and go on", func(t *testing.T) {
		srv := &listenServer{item: `{"seq":42,"type":"mentioned","by":"@ann","task":"SVA-12","title":"SVA-12 Login","snippet":"Can you look at\nthe login bug?"}`}
		out := &bytes.Buffer{}
		r := &runner{ctx: context.Background(), c: testClient(t, srv), out: out}
		if err := r.wait(input{f: map[string][]string{"for": {"30"}}}); err != nil {
			t.Fatal(err)
		}
		want := `ITEM #42 mentioned SVA-12 from @ann: "Can you look at the login bug?"
quadit show SVA-12   # read it
quadit ack 42 listen lease=L1   # once it is handled
quadit wait for=30 lease=L1   # then go on listening
`
		if out.String() != want {
			t.Fatalf("wait printed:\n%s\nwant:\n%s", out, want)
		}
		if q := srv.asked[0]; q.Get("wait") != "30" || q.Has("lease") || q.Has("take") {
			t.Fatalf("the first wait asked %v", q)
		}
	})

	t.Run("with nothing, it renews its hold with the lease until for= is over, then says IDLE", func(t *testing.T) {
		srv := &listenServer{}
		out := &bytes.Buffer{}
		r := &runner{ctx: context.Background(), c: testClient(t, srv), out: out}
		started := time.Now()
		if err := r.waitFor(waitSpan{total: 3 * time.Second, hold: time.Second}, "", true, "quadit wait for=3"); err != nil {
			t.Fatal(err)
		}
		if took := time.Since(started); took < 3*time.Second || took > 5*time.Second {
			t.Fatalf("a wait of 3 seconds took %s", took)
		}
		if want := "IDLE\nquadit wait for=3 lease=L1   # go on listening\n"; out.String() != want {
			t.Fatalf("wait printed:\n%s\nwant:\n%s", out, want)
		}
		if len(srv.asked) != 3 {
			t.Fatalf("wait asked %d times, want 3 holds of a second: %v", len(srv.asked), srv.asked)
		}
		if first := srv.asked[0]; first.Get("take") != "1" || first.Has("lease") {
			t.Fatalf("the first hold asked %v, want take=1 and no lease", first)
		}
		for _, q := range srv.asked[1:] {
			if q.Get("lease") != "L1" || q.Has("take") || q.Get("wait") != "1" {
				t.Fatalf("a later hold asked %v, want the lease it was given", q)
			}
		}
	})

	t.Run("refused because another session listens, it names the way to take over", func(t *testing.T) {
		r := &runner{ctx: context.Background(), c: testClient(t, http.HandlerFunc(refusingListener)), out: &bytes.Buffer{}}
		err := r.wait(input{})
		if err == nil || !strings.Contains(err.Error(), "already listening") || !strings.Contains(err.Error(), "quadit wait take=1") {
			t.Fatalf("wait refused ended with %v", err)
		}
	})
}
