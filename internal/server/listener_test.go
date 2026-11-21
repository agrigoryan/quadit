package server_test

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// leaseOfAWaitOf is how long a lease lives past now for a wait of d.
func leaseOfAWaitOf(d time.Duration) time.Duration { return d + 5*time.Minute }

// leaseForm is how a listener's lease id looks.
var leaseForm = regexp.MustCompile(`^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$`)

// listened is the answer of GET /listen.
type listened struct {
	Lease string
	Seq   int64
	Line  string
	Item  *struct {
		Seq  int64
		Type string
		By   string
		Task string
	}
}

// listening says whether /agents shows an agent as listening.
func (s *site) listening(t *testing.T, handle string) bool {
	t.Helper()
	var out struct {
		Agents []struct {
			Handle    string
			Listening bool
		}
	}
	s.call(t, s.owner, "", "GET", w+"/agents", nil, 200, &out)
	for _, a := range out.Agents {
		if a.Handle == "@"+handle {
			return a.Listening
		}
	}
	t.Fatalf("no agent @%s", handle)
	return false
}

// TestTheListener: one session at a time delivers an agent's inbox, by
// holding a lease that only GET /listen takes: the first wait takes it (and
// so connects the agent and shows it listening), the holder renews it and
// acknowledges with it, another session is refused until the person has it
// take over, a lease taken over or run out can no longer acknowledge, and
// nothing but an acknowledgment moves the cursor.
func TestTheListener(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
		var first listened

		t.Run("the first wait takes the lease, connects the agent and shows it listening", func(t *testing.T) {
			if s.listening(t, "coder") || s.connectedAt(t, "coder") != "" {
				t.Fatal("an agent nothing ran for shows as listening or connected")
			}
			s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &first)
			if !leaseForm.MatchString(first.Lease) || first.Item == nil || first.Item.Type != "assigned" || first.Item.By != "@aram" || first.Item.Task != "OPS-1" ||
				!strings.HasPrefix(first.Line, "#") {
				t.Fatalf("the first wait answered %+v (item %+v)", first, first.Item)
			}
			if !s.listening(t, "coder") || s.connectedAt(t, "coder") == "" {
				t.Fatal("the agent holding its lease does not show as listening and connected")
			}
		})

		t.Run("another session is refused, saying when the listener was last heard", func(t *testing.T) {
			var r refusal
			s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 409, &r)
			if r.Error.Reason != "listening_elsewhere" || !strings.Contains(r.Error.Message, "@coder is already listening from another session (last heard ") {
				t.Fatalf("a second session is refused with %+v", r.Error)
			}
			s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": first.Item.Seq}, 409, nil)
		})

		t.Run("the holder renews its lease and acknowledges with it", func(t *testing.T) {
			var again listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+first.Lease, nil, 200, &again)
			if again.Lease != first.Lease || again.Item == nil || again.Item.Seq != first.Item.Seq {
				t.Fatalf("the holder's next wait answered %+v, want the same lease and the item not acknowledged", again)
			}
			s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": first.Item.Seq, "lease": first.Lease}, 200, nil)
			var empty listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=1&lease="+first.Lease, nil, 200, &empty)
			if empty.Item != nil || empty.Lease != first.Lease {
				t.Fatalf("a wait with nothing new answered %+v", empty)
			}
		})

		t.Run("a wait with nothing for it leaves the cursor where it was acknowledged", func(t *testing.T) {
			s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Not the agent's"})
			s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+first.Lease, nil, 200, nil)
			var cursor struct{ Seq int64 }
			s.call(t, nil, coder, "GET", w+"/cursors/listen", nil, 200, &cursor)
			if cursor.Seq != first.Item.Seq {
				t.Fatalf("after a wait with nothing the cursor stands at %d, want %d where it was acknowledged", cursor.Seq, first.Item.Seq)
			}
		})

		t.Run("take=1 takes over; the old lease can no longer wait or acknowledge", func(t *testing.T) {
			var taken listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=0&take=1", nil, 200, &taken)
			if taken.Lease == "" || taken.Lease == first.Lease {
				t.Fatalf("taking over answered the lease %q, the old one was %q", taken.Lease, first.Lease)
			}
			var r refusal
			s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": first.Item.Seq, "lease": first.Lease}, 409, &r)
			if r.Error.Reason != "lease_stale" {
				t.Fatalf("an acknowledgment with a lease taken over is refused with %+v", r.Error)
			}
			s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+first.Lease, nil, 409, &r)
			if r.Error.Reason != "listening_elsewhere" {
				t.Fatalf("a wait with a lease taken over is refused with %+v", r.Error)
			}
			first.Lease = taken.Lease
		})

		t.Run("the lease ends five minutes after the last wait, and then acknowledges nothing", func(t *testing.T) {
			s.call(t, nil, coder, "GET", w+"/listen?wait=1&lease="+first.Lease, nil, 200, nil)
			var m struct {
				Members []struct {
					Handle         string
					ListeningUntil int64 `json:"listening_until"`
				}
			}
			s.call(t, s.owner, "", "GET", w+"/list/members", nil, 200, &m)
			var until int64
			for _, member := range m.Members {
				if member.Handle == "coder" {
					until = member.ListeningUntil
				}
			}
			if left := time.Until(time.UnixMilli(until)); left < 4*time.Minute || left > 5*time.Minute {
				t.Fatalf("after its wait the lease lives %s more, want five minutes", left)
			}
			if _, err := st.Update(context.Background(), "members", map[string]any{"listening_until": time.Now().Add(-time.Second).UnixMilli()}, store.Eq("handle", "coder")); err != nil {
				t.Fatal(err)
			}
			if s.listening(t, "coder") {
				t.Fatal("an agent whose lease ended shows as listening")
			}
			var r refusal
			s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": first.Item.Seq, "lease": first.Lease}, 409, &r)
			if r.Error.Reason != "lease_ended" {
				t.Fatalf("an acknowledgment with a lease that ran out is refused with %+v", r.Error)
			}
			var next listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &next)
			if next.Lease == "" || next.Lease == first.Lease {
				t.Fatalf("a session after the lease ended got the lease %q", next.Lease)
			}
		})

		t.Run("a person's login is refused", func(t *testing.T) {
			var r refusal
			s.call(t, s.owner, "", "GET", w+"/listen?wait=0", nil, 403, &r)
			if !strings.Contains(r.Error.Message, "a person's, not an agent's") {
				t.Fatalf("a person listening is told %q", r.Error.Message)
			}
		})

		t.Run("a wait on the feed takes no lease and is not listening", func(t *testing.T) {
			bot := s.agentToken(t, "bot")
			var page map[string]any
			s.call(t, nil, bot, "GET", w+"/events?cursor=listen&inbox=1&wait=1", nil, 200, &page)
			if _, has := page["lease"]; has || s.listening(t, "bot") {
				t.Fatalf("a wait on the feed took a lease: %v", page)
			}
		})

		t.Run("a listener on a cursor of its own holds the agent's one lease", func(t *testing.T) {
			ops := s.agentToken(t, "ops")
			var own listened
			s.call(t, nil, ops, "GET", w+"/listen?wait=0&cursor=companion", nil, 200, &own)
			s.call(t, nil, ops, "GET", w+"/listen?wait=0", nil, 409, nil)
			s.call(t, nil, ops, "PUT", w+"/cursors/companion", M{"seq": 1, "lease": "WRONGLEA"}, 409, nil)
			s.call(t, nil, ops, "PUT", w+"/cursors/companion", M{"seq": 1, "lease": own.Lease}, 200, nil)
		})
	})
}

// TestAWaitThatSleptThroughATakeoverHandsNothingOver: a wait blocked when
// another session takes the lease over is refused when its item comes, so
// only the session that holds the lease delivers it.
func TestAWaitThatSleptThroughATakeoverHandsNothingOver(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		var first listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &first)

		blocked := make(chan int, 1)
		go func() {
			req, _ := http.NewRequest("GET", s.url+w+"/listen?wait=20&lease="+first.Lease, nil)
			req.Header.Set("Authorization", "Bearer "+coder)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				blocked <- 0
				return
			}
			resp.Body.Close()
			blocked <- resp.StatusCode
		}()
		// The first wait has blocked once its lease is held for its twenty seconds and five minutes more.
		for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			var m core.Member
			if err := st.Get(context.Background(), &m, store.Eq("handle", "coder")); err != nil {
				t.Fatal(err)
			}
			if time.Until(time.UnixMilli(m.ListeningUntil)) > leaseOfAWaitOf(10*time.Second) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the first wait never blocked")
			}
		}
		var taken listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&take=1", nil, 200, &taken)
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
		select {
		case status := <-blocked:
			if status != 409 {
				t.Fatalf("the wait that slept through the takeover answered %d, want 409", status)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("the wait that slept through the takeover did not wake for the item")
		}
		var got listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+taken.Lease, nil, 200, &got)
		if got.Item == nil || got.Item.Task != "OPS-1" {
			t.Fatalf("the session that took over got %+v", got)
		}
	})
}

// TestHowFarAgentsAreConnectedIsACheapRead: /agents/connection says, for
// every agent, when it connected, whether it listens and the tool of the
// last code it gave back.
func TestHowFarAgentsAreConnectedIsACheapRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.agentToken(t, "idle")
		made := s.makeCode(t, s.owner, "@coder", "Codex")
		s.call(t, nil, coder, "POST", w+"/connect", M{"code": made.Code}, 200, nil)
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, nil)
		var out struct {
			Agents []struct {
				Handle      string
				ConnectedAt string `json:"connected_at"`
				Listening   bool
				Tool        string
			}
		}
		s.call(t, s.owner, "", "GET", w+"/agents/connection", nil, 200, &out)
		if len(out.Agents) != 2 {
			t.Fatalf("the read lists %+v", out.Agents)
		}
		for _, a := range out.Agents {
			connected := a.Handle == "@coder"
			if (a.ConnectedAt != "") != connected || a.Listening != connected || (a.Tool == "Codex") != connected {
				t.Fatalf("%s reads %+v", a.Handle, a)
			}
		}
	})
}

// TestAnAgentConnectsAndListensWithTheCommand: the commands an agent is
// told to run, against a real server: quadit connect CODE connects it and
// starts no wait; quadit wait hands it its item with the lines to go on,
// which work as printed; a second session is refused.
func TestAnAgentConnectsAndListensWithTheCommand(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})

		out, code := s.quadit(t, coder, "connect")
		if code != 0 || !strings.Contains(out, "You are @coder in Games.") || !strings.Contains(out, "quadit connect CODE") {
			t.Fatalf("quadit connect with no code said (%d):\n%s", code, out)
		}
		made := s.makeCode(t, s.owner, "@coder", "Codex")
		out, code = s.quadit(t, coder, "connect", made.Code)
		want := "Connected as @coder in Games.\nTell the person it is connected, and offer: say \"listen to Quadit\" and I will answer what comes in while this run stays active.\n"
		if code != 0 || out != want {
			t.Fatalf("quadit connect CODE said (%d):\n%s", code, out)
		}
		if s.connectedAt(t, "coder") == "" || s.listening(t, "coder") {
			t.Fatal("after quadit connect the agent is not connected, or is listening")
		}

		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
		out, code = s.quadit(t, coder, "wait", "for=5")
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if code != 0 || len(lines) != 4 || !strings.HasPrefix(lines[0], "ITEM #") || !strings.Contains(lines[0], " assigned OPS-1 from @aram: ") {
			t.Fatalf("quadit wait said (%d):\n%s", code, out)
		}
		if out, code := s.quadit(t, coder, "wait", "for=1"); code == 0 || !strings.Contains(out, "quadit wait take=1") {
			t.Fatalf("a second session's wait said (%d):\n%s", code, out)
		}
		run := func(line string) string {
			t.Helper()
			command, _, _ := strings.Cut(line, "   #")
			args := strings.Fields(command)[1:]
			out, code := s.quadit(t, coder, args...)
			if code != 0 {
				t.Fatalf("%s said (%d):\n%s", command, code, out)
			}
			return out
		}
		run(lines[1])
		run(lines[2])
		lines[3] = strings.Replace(lines[3], "for=5", "for=1", 1)
		if again := run(lines[3]); !strings.HasPrefix(again, "IDLE\n") {
			t.Fatalf("after the ack the next wait said:\n%s", again)
		}
		if !s.listening(t, "coder") {
			t.Fatal("the agent waiting with its lease does not show as listening")
		}
	})
}
