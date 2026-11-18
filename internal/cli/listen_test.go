package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// inboxServer answers listen as the API does for an inbox of a few items:
// GET /events reads after the cursor, at most limit= items; PUT /cursors
// moves it; POST /secrets/env fails the first time it is asked.
type inboxServer struct {
	mu          sync.Mutex
	items       []int64 // the seqs of the inbox items
	cursor      int64
	acks        []int64
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
		_ = json.NewEncoder(w).Encode(map[string]any{"events": lines, "seq": seq})
	case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/cursors/"):
		var body struct{ Seq int64 }
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.acks = append(s.acks, body.Seq)
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
}
