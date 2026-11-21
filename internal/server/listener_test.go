package server_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// listened is the answer of GET /listen.
type listened struct {
	Lease string
	Seq   int64
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

// TestTheListener: one session at a time delivers an agent's inbox from
// its cursor "listen", by holding a lease: the first wait takes it (and so
// connects the agent and shows it listening), the holder renews it, another
// session is refused until the person has it take over, a lease taken over
// can no longer acknowledge, and the lease ends five minutes after the last
// wait.
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
			if first.Lease == "" || first.Item == nil || first.Item.Type != "assigned" || first.Item.By != "@aram" || first.Item.Task != "OPS-1" {
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
			s.call(t, nil, coder, "GET", w+"/events?cursor=listen&inbox=1&wait=1", nil, 409, nil)
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
			if empty.Item != nil || empty.Seq < first.Item.Seq {
				t.Fatalf("a wait with nothing new answered %+v", empty)
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

		t.Run("the lease ends five minutes after the last wait", func(t *testing.T) {
			var after struct{ ListeningUntil int64 }
			s.call(t, nil, coder, "GET", w+"/listen?wait=1&lease="+first.Lease, nil, 200, nil)
			var m struct {
				Members []struct {
					Handle         string
					ListeningUntil int64 `json:"listening_until"`
				}
			}
			s.call(t, s.owner, "", "GET", w+"/list/members", nil, 200, &m)
			for _, member := range m.Members {
				if member.Handle == "coder" {
					after.ListeningUntil = member.ListeningUntil
				}
			}
			if left := time.Until(time.UnixMilli(after.ListeningUntil)); left < 4*time.Minute || left > 5*time.Minute {
				t.Fatalf("after its wait the lease lives %s more, want five minutes", left)
			}
			if _, err := st.Update(context.Background(), "members", map[string]any{"listening_until": time.Now().Add(-time.Second).UnixMilli()}, store.Eq("handle", "coder")); err != nil {
				t.Fatal(err)
			}
			if s.listening(t, "coder") {
				t.Fatal("an agent whose lease ended shows as listening")
			}
			var next listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &next)
			if next.Lease == "" || next.Lease == first.Lease {
				t.Fatalf("a session after the lease ended got the lease %q", next.Lease)
			}
		})

		t.Run("a wait on the feed with the cursor listen holds the same lease", func(t *testing.T) {
			ops := s.agentToken(t, "ops")
			var page struct{ Lease string }
			s.call(t, nil, ops, "GET", w+"/events?cursor=listen&inbox=1&types=notification.created&wait=1", nil, 200, &page)
			if page.Lease == "" {
				t.Fatal("a wait on the cursor listen answered no lease")
			}
			s.call(t, nil, ops, "GET", w+"/listen?wait=0", nil, 409, nil)
			s.call(t, nil, ops, "GET", w+"/events?cursor=listen&inbox=1&types=notification.created&wait=1&lease="+page.Lease, nil, 200, nil)
			if !s.listening(t, "ops") {
				t.Fatal("an agent whose companion waits does not show as listening")
			}
		})

		t.Run("a wait on another cursor is not listening", func(t *testing.T) {
			bot := s.agentToken(t, "bot")
			s.call(t, nil, bot, "GET", w+"/events?cursor=main&mine=1&others=1&wait=1", nil, 200, nil)
			if s.listening(t, "bot") {
				t.Fatal("an agent waiting on its own cursor shows as listening")
			}
		})
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
