package server_test

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

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
