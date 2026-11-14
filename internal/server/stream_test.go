package server_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// stream is an open live stream, read in the background.
type stream struct {
	mu    sync.Mutex
	text  strings.Builder
	done  chan struct{}
	close context.CancelFunc
}

func (st *stream) all() string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.text.String()
}

func (st *stream) ended() bool {
	select {
	case <-st.done:
		return true
	default:
		return false
	}
}

func (s *site) stream(t *testing.T, token string) *stream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", s.url+"/api/v1/w/-/events/stream", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("open stream: %v %v", err, resp)
	}
	st := &stream{done: make(chan struct{}), close: cancel}
	go func() {
		defer close(st.done)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			st.mu.Lock()
			st.text.WriteString(sc.Text() + "\n")
			st.mu.Unlock()
		}
	}()
	t.Cleanup(cancel)
	return st
}

// TestStreamsEndWithAccess checks that a connection held open does not
// outlive the access it was opened with.
func TestStreamsEndWithAccess(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		s.change(s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		for _, h := range []string{"artist", "coder", "writer"} {
			s.change(s.owner, "", "agent.create", M{"name": h, "handle": h})
		}
		token := func(h string) (tok string, id string) {
			var out struct {
				Token string
				Info  struct{ ID string }
			}
			s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@" + h}, 201, &out)
			return out.Token, out.Info.ID
		}
		artist, _ := token("artist")
		coder, _ := token("coder")
		writer, writerID := token("writer")

		// All three follow along and see a comment.
		streams := map[string]*stream{"artist": s.stream(t, artist), "coder": s.stream(t, coder), "writer": s.stream(t, writer)}
		s.change(s.owner, "", "comment.create", M{"task": "SVA-1", "body": "first words"})
		for name, sm := range streams {
			eventually(t, name+" to see the first comment", func() bool { return strings.Contains(sm.all(), "first words") })
		}
		// A request held open on the feed, by the one about to be suspended.
		held := make(chan string, 1)
		go func() {
			req, _ := http.NewRequest("GET", s.url+"/api/v1/w/-/events?wait=20&types=comment.created&after=999999", nil)
			req.Header.Set("Authorization", "Bearer "+coder)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				held <- err.Error()
				return
			}
			defer resp.Body.Close()
			buf := new(strings.Builder)
			bufio.NewReader(resp.Body).WriteTo(buf)
			held <- resp.Status + " " + buf.String()
		}()
		time.Sleep(300 * time.Millisecond)

		// The artist is narrowed to another project, the coder is suspended,
		// the writer's token is revoked. Then more is said on the task.
		s.change(s.owner, "", "agent.update", M{"id": "@artist", "scope": M{"projects": []string{"OPS"}}})
		s.change(s.owner, "", "member.update", M{"id": "@coder", "suspended": true})
		s.call(s.owner, "", "DELETE", w+"/tokens/"+writerID, nil, 200, nil)
		s.change(s.owner, "", "comment.create", M{"task": "SVA-1", "body": "second words, not for them"})

		for name, sm := range streams {
			eventually(t, name+"'s stream to end", sm.ended)
			if strings.Contains(sm.all(), "second words") {
				t.Fatalf("%s lost access and still got what was said after: %s", name, sm.all())
			}
		}
		if got := streams["artist"].all(); !strings.Contains(got, "event: reset") {
			t.Fatalf("someone whose projects changed was not told to start over: %s", got)
		}
		for _, name := range []string{"coder", "writer"} {
			if got := streams[name].all(); !strings.Contains(got, "event: gone") {
				t.Fatalf("%s was not told their access ended: %s", name, got)
			}
		}
		select {
		case got := <-held:
			if strings.Contains(got, "second words") || !strings.HasPrefix(got, "40") {
				t.Fatalf("a held request outlived a suspension: %s", got)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the held request did not end")
		}
		// Starting over, the artist no longer sees the task's project at all.
		again := s.stream(t, artist)
		s.change(s.owner, "", "comment.create", M{"task": "SVA-1", "body": "third words"})
		time.Sleep(700 * time.Millisecond)
		if strings.Contains(again.all(), "third words") {
			t.Fatalf("a narrowed agent sees a project it was taken off: %s", again.all())
		}
	})
}

// TestCompression checks that text answers shrink for those who ask, and
// that files and the live stream are left alone.
func TestCompression(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	for i := 0; i < 40; i++ {
		s.change(s.owner, "", "task.create", M{"project": "SVA", "title": "A task about the boss fight, number " + strings.Repeat("x", i)})
	}
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{}, 201, &tok)
	get := func(path string, gz bool, hdr ...string) (*http.Response, int) {
		req, _ := http.NewRequest("GET", s.url+path, nil)
		req.Header.Set("Authorization", "Bearer "+tok.Token)
		if gz {
			req.Header.Set("Accept-Encoding", "gzip")
		}
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		resp, err := (&http.Transport{DisableCompression: true}).RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		n := 0
		buf := make([]byte, 32<<10)
		for {
			k, err := resp.Body.Read(buf)
			n += k
			if err != nil {
				break
			}
		}
		return resp, n
	}
	plain, full := get("/api/v1/w/-/bootstrap", false)
	packed, small := get("/api/v1/w/-/bootstrap", true)
	if plain.Header.Get("Content-Encoding") != "" || packed.Header.Get("Content-Encoding") != "gzip" || small*3 > full {
		t.Fatalf("bootstrap: %d bytes plain, %d bytes compressed (%q)", full, small, packed.Header.Get("Content-Encoding"))
	}
	// A file is sent as it is, and in ranges.
	var f struct{ ID, URL string }
	s.call(nil, tok.Token, "POST", "/api/v1/w/-/files?name=notes.txt", []byte(strings.Repeat("plain words ", 2000)), 201, &f)
	file, _ := get(strings.TrimPrefix(f.URL, s.url), true)
	part, n := get(strings.TrimPrefix(f.URL, s.url), true, "Range", "bytes=100-199")
	if file.Header.Get("Content-Encoding") != "" || part.StatusCode != 206 || n != 100 {
		t.Fatalf("file: encoding %q; range: %d, %d bytes", file.Header.Get("Content-Encoding"), part.StatusCode, n)
	}
	// A short answer is not worth it; a compressed one still decodes for a normal client.
	if out := s.call(nil, tok.Token, "GET", "/api/v1/w/-/tasks?format=text", nil, 200, nil); !strings.Contains(out, "SVA-40") {
		t.Fatalf("a normal client could not read a compressed answer: %.80s", out)
	}
}

// TestTwoServersOneDatabase runs two servers on one Postgres database: a
// write taken by one wakes a stream held by the other at once, people on a
// page see each other across servers, an upload sent in parts to different
// servers comes together, and a caller's request count is shared.
func TestTwoServersOneDatabase(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		if st.Dialect() != "postgres" {
			t.Skip("several servers need Postgres")
		}
		a := newSite(t, st)
		// The second server: its own process state, the same database and files.
		files, _ := blob.NewDisk(a.dir + "/files")
		sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
		hs := httptest.NewUnstartedServer(nil)
		srvB := server.New(server.Config{DataDir: t.TempDir(), BaseURL: a.url, Version: "test"}, st, files, sealer)
		hs.Config.Handler = srvB.Handler()
		hs.Start()
		ctx, stop := context.WithCancel(context.Background())
		go srvB.Run(ctx)
		t.Cleanup(func() { stop(); hs.Close() })
		b := &site{t: t, url: hs.URL, owner: a.owner, srv: srvB}

		a.change(a.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		a.change(a.owner, "", "task.create", M{"project": "SVA", "title": "Boss design"})
		a.change(a.owner, "", "agent.create", M{"name": "Artist", "handle": "artist"})
		var tok struct{ Token string }
		a.call(a.owner, "", "POST", w+"/tokens", M{"user": "@artist"}, 201, &tok)
		time.Sleep(500 * time.Millisecond) // let the second server start listening

		// A stream held by B hears a write taken by A well inside the 25
		// seconds its own heartbeat would take.
		sm := b.stream(t, tok.Token)
		time.Sleep(300 * time.Millisecond)
		start := time.Now()
		a.change(a.owner, "", "comment.create", M{"task": "SVA-1", "body": "said through the other server"})
		eventually(t, "the other server's stream to carry the comment", func() bool { return strings.Contains(sm.all(), "said through the other server") })
		if took := time.Since(start); took > 3*time.Second {
			t.Fatalf("the other server heard of the write after %s", took)
		}

		// Presence: one on A, one on B, on the same page.
		page := a.change(a.owner, "", "doc.create", M{"title": "Plan", "markdown": "one\n"})["ref"].(string)
		a.call(a.owner, "", "POST", w+"/docs/"+page+"/presence", M{"block": "b1"}, 200, nil)
		if out := b.call(nil, tok.Token, "POST", "/api/v1/w/-/docs/"+page+"/presence", M{"block": "b2"}, 200, nil); !strings.Contains(out, `"block":"b1"`) {
			t.Fatalf("someone on the other server is not seen on the page: %s", out)
		}

		// An upload whose parts go to different servers.
		data := []byte(strings.Repeat("0123456789", 800))
		var f struct {
			ID, State, SHA256 string
			Received          int
		}
		a.call(nil, tok.Token, "POST", fmt.Sprintf("/api/v1/w/-/files?name=clip.bin&size=%d", len(data)), data[:3000], 201, &f)
		b.call(nil, tok.Token, "PATCH", "/api/v1/w/-/files/"+f.ID+"?offset=3000", data[3000:6000], 200, &f)
		a.call(nil, tok.Token, "PATCH", "/api/v1/w/-/files/"+f.ID+"?offset=6000", data[6000:], 200, &f)
		sum := sha256.Sum256(data)
		if f.State != "ready" || f.SHA256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("an upload sent to two servers: %+v", f)
		}
	})
}

// TestBootstrapInParts checks that the open work and the rest add up to
// everything, with nothing in both.
func TestBootstrapInParts(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
		for i := 0; i < 6; i++ {
			s.change(s.owner, "", "task.create", M{"project": "SVA", "title": fmt.Sprintf("Task %d", i+1)})
		}
		s.change(s.owner, "", "task.update", M{"id": "SVA-2", "status": "done"})
		s.change(s.owner, "", "task.update", M{"id": "SVA-3", "status": "canceled"})
		s.change(s.owner, "", "task.update", M{"id": "SVA-4", "archived": true})
		s.change(s.owner, "", "decision.open", M{"task": "SVA-2", "question": "Closed question?", "options": []M{{"label": "A"}, {"label": "B"}}})
		s.change(s.owner, "", "decision.open", M{"task": "SVA-1", "question": "Open question?", "options": []M{{"label": "A"}, {"label": "B"}}})
		type boot struct {
			Rest      int
			Tasks     []struct{ Key string }
			Decisions []struct{ Question string }
			Projects  []struct{ Key string }
		}
		var all, open, rest boot
		s.call(s.owner, "", "GET", w+"/bootstrap", nil, 200, &all)
		s.call(s.owner, "", "GET", w+"/bootstrap?part=open", nil, 200, &open)
		s.call(s.owner, "", "GET", w+"/bootstrap?part=rest", nil, 200, &rest)
		keys := func(b boot) string {
			var out []string
			for _, t := range b.Tasks {
				out = append(out, t.Key)
			}
			return strings.Join(out, " ")
		}
		if keys(open) != "SVA-1 SVA-5 SVA-6" || keys(rest) != "SVA-2 SVA-3 SVA-4" || open.Rest != 3 || len(all.Tasks) != 6 {
			t.Fatalf("open: %s (rest %d); rest: %s; all: %d", keys(open), open.Rest, keys(rest), len(all.Tasks))
		}
		if len(open.Decisions) != 1 || open.Decisions[0].Question != "Open question?" || len(rest.Decisions) != 1 || len(open.Projects) != 1 || len(rest.Projects) != 0 {
			t.Fatalf("decisions and the rest of the copy: open %+v, rest %+v", open, rest)
		}
		s.call(s.owner, "", "GET", w+"/bootstrap?part=nope", nil, 400, nil)
	})
}
