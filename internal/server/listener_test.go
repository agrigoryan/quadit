package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// listeningUntil is when a member's listener lease ends, as stored.
func (s *site) listeningUntil(t *testing.T, st store.Store, handle string) int64 {
	t.Helper()
	var m core.Member
	if err := st.Get(context.Background(), &m, store.Eq("handle", handle)); err != nil {
		t.Fatal(err)
	}
	return m.ListeningUntil
}

// runOut ends the lease of the listener holding it, as if its session had
// stopped asking a while ago.
func runOut(t *testing.T, st store.Store, lease string) {
	t.Helper()
	if _, err := st.Update(context.Background(), "listeners", map[string]any{"lease_until": time.Now().Add(-time.Second).UnixMilli()}, store.Eq("lease", lease)); err != nil {
		t.Fatal(err)
	}
}

// blockedOn returns once a wait of twenty seconds made with lease has
// blocked: its lease is held for those and ninety more.
func blockedOn(t *testing.T, st store.Store, lease string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		var l core.Listener
		if err := st.Get(context.Background(), &l, store.Eq("lease", lease)); err != nil {
			t.Fatal(err)
		}
		if time.Until(time.UnixMilli(l.LeaseUntil)) > leaseOfAWaitOf(10*time.Second) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the wait never blocked")
		}
	}
}

// leaseOfAWaitOf is how long a lease lives past now for a wait of d.
func leaseOfAWaitOf(d time.Duration) time.Duration { return d + 90*time.Second }

// leaseForm is how a listener's lease id looks.
var leaseForm = regexp.MustCompile(`^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$`)

// listened is the answer of GET /listen.
type listened struct {
	Lease   string
	Project string
	Seq     int64
	Line    string
	Item    *struct {
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
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		var first listened

		t.Run("the first wait takes the lease, connects the agent and shows it listening", func(t *testing.T) {
			if s.listening(t, "coder") || s.connectedAt(t, "coder") != "" {
				t.Fatal("an agent nothing ran for shows as listening or connected")
			}
			s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &first)
			s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
			s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+first.Lease, nil, 200, &first)
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

		t.Run("the lease lives ninety seconds past the hold asked for; run out, it still acknowledges, and a wait takes it again", func(t *testing.T) {
			s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Renew the certificate", "assignee": "@coder"})
			var got listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=20&lease="+first.Lease, nil, 200, &got)
			if got.Item == nil {
				t.Fatalf("the wait answered %+v", got)
			}
			if left := time.Until(time.UnixMilli(s.listeningUntil(t, st, "coder"))); left < 100*time.Second || left > 110*time.Second {
				t.Fatalf("after a wait of twenty seconds the lease lives %s more, want those and ninety", left)
			}
			// The agent handled the item for longer than that, and nobody took the lease meanwhile.
			runOut(t, st, first.Lease)
			if _, err := st.Update(context.Background(), "members", map[string]any{"listening_until": time.Now().Add(-time.Second).UnixMilli()}, store.Eq("handle", "coder")); err != nil {
				t.Fatal(err)
			}
			if s.listening(t, "coder") {
				t.Fatal("an agent whose lease ended shows as listening")
			}
			s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": got.Item.Seq, "lease": first.Lease}, 200, nil)
			var next listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+first.Lease, nil, 200, &next)
			if next.Lease != first.Lease || !s.listening(t, "coder") {
				t.Fatalf("the holder's next wait after its lease ran out got %q", next.Lease)
			}
		})

		t.Run("a person's login is refused", func(t *testing.T) {
			var r refusal
			s.call(t, s.owner, "", "GET", w+"/listen?wait=0", nil, 403, &r)
			if !strings.Contains(r.Error.Message, "a person's, not an agent's") {
				t.Fatalf("a person listening is told %q", r.Error.Message)
			}
		})

	})
}

// TestAWaitThatSleptThroughATakeoverHandsNothingOver: a wait blocked when
// another session takes the lease over is refused when its item comes, so
// only the session that holds the lease delivers it.
func TestAWaitThatSleptThroughATakeoverHandsNothingOver(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		var first listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &first)

		blocked := make(chan int, 1)
		go func() {
			req, _ := http.NewRequest(http.MethodGet, s.url+w+"/listen?wait=20&lease="+first.Lease, nil)
			req.Header.Set("Authorization", "Bearer "+coder)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				blocked <- 0
				return
			}
			resp.Body.Close()
			blocked <- resp.StatusCode
		}()
		blockedOn(t, st, first.Lease)
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
	t.Parallel()
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
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv).
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
		want := "Connected as @coder in the workspace \"Games\".\nTell the person it is connected, and offer: say \"listen to Quadit\" and I will answer what comes in while this run stays active.\n"
		if code != 0 || out != want {
			t.Fatalf("quadit connect CODE said (%d):\n%s", code, out)
		}
		if s.connectedAt(t, "coder") == "" || s.listening(t, "coder") {
			t.Fatal("after quadit connect the agent is not connected, or is listening")
		}

		// The first wait starts at the present, with nothing for it: it prints the wait to go on with, lease and all.
		out, code = s.quadit(t, coder, "wait", "for=1")
		next := regexp.MustCompile(`lease=[A-Z0-9]{8}`).FindString(out)
		if code != 0 || !strings.HasPrefix(out, "IDLE") || next == "" {
			t.Fatalf("the first quadit wait said (%d):\n%s", code, out)
		}
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
		out, code = s.quadit(t, coder, "wait", "for=5", next)
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if code != 0 || len(lines) != 5 || !strings.HasPrefix(lines[0], "ITEM #") || !strings.Contains(lines[0], " assigned OPS-1 from @aram: ") {
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
		// The answering line, sent twice (as two sessions handed the same item would), makes one comment.
		answer := strings.Replace(lines[2], `"…"`, "Rotated.", 1)
		if !strings.HasPrefix(answer, "quadit comment OPS-1 Rotated. --id=") {
			t.Fatalf("the answering line is %q", lines[2])
		}
		run(answer)
		run(answer)
		var shown struct{ Comments []struct{ By string } }
		s.call(t, s.owner, "", "GET", w+"/tasks/OPS-1", nil, 200, &shown)
		if len(shown.Comments) != 1 || shown.Comments[0].By != "@coder" {
			t.Fatalf("the answer sent twice made the comments %+v", shown.Comments)
		}
		run(lines[3])
		lines[4] = strings.Replace(lines[4], "for=5", "for=1", 1)
		if again := run(lines[4]); !strings.HasPrefix(again, "IDLE\n") {
			t.Fatalf("after the ack the next wait said:\n%s", again)
		}
		if !s.listening(t, "coder") {
			t.Fatal("the agent waiting with its lease does not show as listening")
		}
	})
}

// TestAListenerFromBeforeTheLeaseKeepsWorking: `quadit listen` as it was
// before the lease (GET /events?cursor=listen&wait=, PUT /cursors/listen
// {seq}, never a lease) takes no lease, is refused nothing and moves its
// cursor; it does not show as listening.
func TestAListenerFromBeforeTheLeaseKeepsWorking(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
		// The requests exactly as that client sends them.
		read := w + "/events?cursor=listen&inbox=1&wait=50&limit=1&types=notification.created&compact=1"
		var page map[string]any
		s.call(t, nil, coder, "GET", read, nil, 200, &page)
		events, _ := page["events"].([]any)
		if _, has := page["lease"]; has || len(events) != 1 {
			t.Fatalf("the old companion's read answered %v", page)
		}
		if s.listening(t, "coder") {
			t.Fatal("an old companion's wait shows as listening")
		}
		seq := int64(page["seq"].(float64))
		s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": seq}, 200, nil)
		var again map[string]any
		s.call(t, nil, coder, "GET", w+"/events?cursor=listen&inbox=1&wait=1&limit=1&types=notification.created&compact=1", nil, 200, &again)
		if more, _ := again["events"].([]any); len(more) != 0 {
			t.Fatalf("after its acknowledgment the old companion read %v again", more)
		}
		// Beside a listener holding a lease, an acknowledgment with none, as a person giving up on an item by hand
		// makes it, is let through too.
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, nil)
		s.call(t, nil, coder, "PUT", w+"/cursors/listen", M{"seq": seq}, 200, nil)
	})
}

// TestTheFirstWaitStartsAtThePresent: an agent with a history does not have
// it replayed when it first listens: only what comes after is handed over.
func TestTheFirstWaitStartsAtThePresent(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Old work", "assignee": "@coder"})
		var first listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &first)
		if first.Item != nil {
			t.Fatalf("the first wait handed over %+v from before it", first.Item)
		}
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "New work", "assignee": "@coder"})
		var next listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+first.Lease, nil, 200, &next)
		if next.Item == nil || next.Item.Task != "OPS-2" {
			t.Fatalf("the next wait answered %+v, want OPS-2", next.Item)
		}
	})
}

// TestAnAcknowledgmentCannotSlipPastATakeover: a takeover that comes while
// an acknowledgment with the old lease is being made either waits for it
// or makes it refused: it never lands between the check of the lease and
// the move of the cursor.
func TestAnAcknowledgmentCannotSlipPastATakeover(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		fs := newFaultyStore(plain)
		s := newSite(t, fs)
		coder := s.agentToken(t, "coder")
		s.change(t, s.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
		var held listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &held)
		s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Rotate keys", "assignee": "@coder"})
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+held.Lease, nil, 200, &held)
		var ws core.Workspace
		if err := plain.Get(context.Background(), &ws, store.Eq("slug", "games")); err != nil {
			t.Fatal(err)
		}

		// Just as the cursor is about to move, another session takes the lease over, written straight to the
		// database; it is given a moment to land.
		landed := false
		fs.faults.arm(fault{op: "upsert", table: "cursors", times: 1, match: func(map[string]any, []store.Cond) bool {
			done := make(chan struct{})
			go func() {
				defer close(done)
				_ = plain.Write(context.Background(), ws.ID, func(tx store.Tx) error { // an error leaves landed false, which the test then says
					_, err := tx.Update(context.Background(), "listeners", map[string]any{"lease": "TAKENXYZ", "lease_until": time.Now().Add(time.Hour).UnixMilli()},
						store.Eq("lease", held.Lease))
					return err
				})
			}()
			select {
			case <-done:
				landed = true
			case <-time.After(500 * time.Millisecond):
			}
			return false // the move itself goes ahead
		}})
		req, _ := http.NewRequest(http.MethodPut, s.url+w+"/cursors/listen", strings.NewReader(`{"seq":`+strconv.FormatInt(held.Item.Seq, 10)+`,"lease":"`+held.Lease+`"}`))
		req.Header.Set("Authorization", "Bearer "+coder)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if landed && resp.StatusCode == http.StatusOK {
			t.Fatal("a takeover landed between the check of the old lease and the move of the cursor, and the move was made")
		}
	})
}

// TestWhatListensIsToldWithoutTakingTheLease: GET /listening says whether
// something listens as the caller, what it said it is and when it was last
// heard, without taking the lease, so a chat can learn that a companion
// already answers for it; the refusal of a second session says it too.
func TestWhatListensIsToldWithoutTakingTheLease(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		type listener struct {
			Listening bool
			By        string
			LastHeard string `json:"last_heard"`
		}
		var before listener
		s.call(t, nil, coder, "GET", w+"/listening", nil, 200, &before)
		if before.Listening || s.listening(t, "coder") {
			t.Fatalf("before any wait the check says %+v", before)
		}

		var held listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&by=a+companion", nil, 200, &held)
		var now listener
		s.call(t, nil, coder, "GET", w+"/listening", nil, 200, &now)
		if !now.Listening || now.By != "a companion" || now.LastHeard == "" {
			t.Fatalf("with a companion listening the check says %+v", now)
		}
		var r refusal
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&by=a+chat", nil, 409, &r)
		if !strings.Contains(r.Error.Message, "already listening from another session (a companion, last heard ") {
			t.Fatalf("a second session is told %q", r.Error.Message)
		}
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+held.Lease+"&by=a+companion%3B+rm+-rf", nil, 400, nil)
	})
}

// projectListening is a site with an agent, @coder, and two projects, SVA
// and ART, for the tests of listening by project.
type projectListening struct {
	*site
	st    store.Store
	coder string // its token
}

func newProjectListening(t *testing.T, st store.Store) projectListening {
	t.Helper()
	s := newSite(t, st)
	p := projectListening{site: s, st: st, coder: s.agentToken(t, "coder")}
	s.change(t, s.owner, "", "project.create", M{"key": "SVA", "name": "Samurai vs Alien"})
	s.change(t, s.owner, "", "project.create", M{"key": "ART", "name": "Art"})
	return p
}

// project is a project of the site's, by key.
func (p projectListening) project(t *testing.T, key string) core.Project {
	t.Helper()
	var project core.Project
	if err := p.st.Get(context.Background(), &project, store.Eq("key", key)); err != nil {
		t.Fatal(err)
	}
	return project
}

// listen is one wait of a session: GET /listen with the query given.
func (p projectListening) listen(t *testing.T, query string) listened {
	t.Helper()
	var got listened
	p.call(t, nil, p.coder, "GET", w+"/listen?"+query, nil, 200, &got)
	return got
}

// give makes an item for @coder: a task of the project given, assigned to
// it, whose key is returned.
func (p projectListening) give(t *testing.T, project string) string {
	t.Helper()
	return p.change(t, p.owner, "", "task.create", M{"project": project, "title": "Work in " + project, "assignee": "@coder"})["key"].(string)
}

// mention makes an item of no project for @coder: a mention in a comment
// on a page of the workspace's.
func (p projectListening) mention(t *testing.T) string {
	t.Helper()
	page := p.change(t, p.owner, "", "doc.create", M{"title": "Handbook"})["ref"].(string)
	p.change(t, p.owner, "", "comment.create", M{"doc": page, "body": "@coder is this still how we work?"})
	return page
}

// TestEachSessionIsHandedOnlyWhatItListensTo: what was approved for a
// person working in two folders, each with a chat of the same agent: a
// listener of a project is handed its project's items only; with a
// listener of everything beside, the named project wins; a project whose
// listener stops keeps its items for its next listener instead of letting
// them fall to the listener of everything; with only listeners of
// projects, an item of no project waits in the inbox.
func TestEachSessionIsHandedOnlyWhatItListensTo(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		a := p.listen(t, "wait=0&project=SVA&by=a+chat")
		b := p.listen(t, "wait=0&project=art")
		if a.Lease == b.Lease || a.Project != "SVA" || b.Project != "ART" {
			t.Fatalf("two projects' first waits answered %+v and %+v", a, b)
		}

		t.Run("two sessions listening to two projects are each handed only their project's items", func(t *testing.T) {
			sva, art := p.give(t, "SVA"), p.give(t, "ART")
			gotA, gotB := p.listen(t, "wait=0&project=SVA&by=a+chat&lease="+a.Lease), p.listen(t, "wait=0&project=ART&lease="+b.Lease)
			if gotA.Item == nil || gotA.Item.Task != sva || gotB.Item == nil || gotB.Item.Task != art {
				t.Fatalf("SVA's session got %+v, ART's %+v; want %s and %s", gotA.Item, gotB.Item, sva, art)
			}
			p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": gotA.Seq, "lease": a.Lease}, 200, nil)
			p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": gotB.Seq, "lease": b.Lease}, 200, nil)
			if again := p.listen(t, "wait=0&project=SVA&by=a+chat&lease="+a.Lease); again.Item != nil {
				t.Fatalf("after its acknowledgment SVA's session got %+v", again.Item)
			}
		})

		t.Run("a second session asking for the same project is refused, told what listens to it, and takes over with take=1", func(t *testing.T) {
			var r refusal
			p.call(t, nil, p.coder, "GET", w+"/listen?wait=0&project=SVA&by=a+chat", nil, 409, &r)
			if r.Error.Reason != "listening_elsewhere" || !strings.Contains(r.Error.Message, "@coder is already listening to SVA from another session (a chat, last heard ") {
				t.Fatalf("a second SVA session is refused with %+v", r.Error)
			}
			taken := p.listen(t, "wait=0&project=SVA&take=1&by=a+chat")
			if taken.Lease == "" || taken.Lease == a.Lease {
				t.Fatalf("taking SVA over answered %+v", taken)
			}
			p.call(t, nil, p.coder, "GET", w+"/listen?wait=0&project=SVA&lease="+a.Lease, nil, 409, &r)
			if r.Error.Reason != "listening_elsewhere" {
				t.Fatalf("the session SVA was taken from is refused with %+v", r.Error)
			}
			p.call(t, nil, p.coder, "GET", w+"/listen?wait=0&project=ART&lease="+b.Lease, nil, 200, nil) // ART's session is not touched
			a = taken
		})

		var c listened
		t.Run("beside a listener of everything, the named project wins and everything gets the rest", func(t *testing.T) {
			c = p.listen(t, "wait=0&by=a+companion")
			if c.Project != "" {
				t.Fatalf("the listener of everything answered the project %q", c.Project)
			}
			sva := p.give(t, "SVA")
			if got := p.listen(t, "wait=0&lease="+c.Lease); got.Item != nil {
				t.Fatalf("the listener of everything was handed %+v, an item of SVA, which listens by itself", got.Item)
			}
			got := p.listen(t, "wait=0&project=SVA&lease="+a.Lease)
			if got.Item == nil || got.Item.Task != sva {
				t.Fatalf("SVA's session got %+v, want %s", got.Item, sva)
			}
			p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": a.Lease}, 200, nil)
			// A project that has no listener of its own (a new one), and an item of no project, are everything's.
			p.change(t, p.owner, "", "project.create", M{"key": "OPS", "name": "Operations"})
			ops := p.give(t, "OPS")
			got = p.listen(t, "wait=0&lease="+c.Lease)
			if got.Item == nil || got.Item.Task != ops {
				t.Fatalf("the listener of everything got %+v, want %s", got.Item, ops)
			}
			p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": c.Lease}, 200, nil)
			page := p.mention(t)
			if got := p.listen(t, "wait=0&lease="+c.Lease); got.Item == nil || got.Item.Task != "" {
				t.Fatalf("the listener of everything got %+v, want the mention on page %s", got.Item, page)
			} else {
				p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": c.Lease}, 200, nil)
			}
		})

		t.Run("when a project's session stops, its items wait for its next one and do not fall to everything", func(t *testing.T) {
			runOut(t, st, a.Lease)
			sva := p.give(t, "SVA")
			if got := p.listen(t, "wait=0&lease="+c.Lease); got.Item != nil {
				t.Fatalf("with SVA's session gone the listener of everything was handed %+v", got.Item)
			}
			next := p.listen(t, "wait=0&project=SVA&by=a+chat")
			if next.Lease == a.Lease || next.Item == nil || next.Item.Task != sva {
				t.Fatalf("SVA's next session got %+v, want a new lease and %s", next, sva)
			}
		})

		t.Run("with only listeners of projects, an item of no project waits in the inbox", func(t *testing.T) {
			runOut(t, st, c.Lease)
			before := unread(t, p)
			p.mention(t)
			for _, q := range []string{"wait=0&project=SVA&take=1", "wait=0&project=ART&take=1"} {
				if got := p.listen(t, q); got.Item != nil && got.Item.Task == "" {
					t.Fatalf("a listener of a project was handed %+v, an item of no project", got.Item)
				}
			}
			if after := unread(t, p); after != before+1 {
				t.Fatalf("the inbox holds %d unread, want %d", after, before+1)
			}
		})
	})
}

// unread is how many of @coder's inbox items are unread.
func unread(t *testing.T, p projectListening) int {
	t.Helper()
	var me struct{ Unread int }
	p.call(t, nil, p.coder, "GET", w+"/me", nil, 200, &me)
	return me.Unread
}

// TestAnAcknowledgmentMovesTheCursorOfTheListenerOfItsLease: the
// acknowledgment every listener sends names the cursor listen; its lease
// says which listener's cursor it moves. A lease taken over is refused for
// its own listener only, and a lease cannot move a cursor not its
// listener's.
func TestAnAcknowledgmentMovesTheCursorOfTheListenerOfItsLease(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		everything := p.listen(t, "wait=0")
		sva := p.listen(t, "wait=0&project=SVA")
		p.give(t, "SVA")
		got := p.listen(t, "wait=0&project=SVA&lease="+sva.Lease)
		project := p.project(t, "SVA")
		var moved struct {
			Name string
			Seq  int64
		}
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": sva.Lease}, 200, &moved)
		if moved.Name != "listen:"+project.ID || moved.Seq != got.Seq {
			t.Fatalf("the acknowledgment with SVA's lease answered %+v, want the cursor listen:%s at %d", moved, project.ID, got.Seq)
		}
		var listen struct{ Seq int64 }
		p.call(t, nil, p.coder, "GET", w+"/cursors/listen", nil, 200, &listen)
		if listen.Seq >= got.Seq {
			t.Fatalf("the cursor of everything moved to %d with SVA's acknowledgment", listen.Seq)
		}
		var r refusal
		p.call(t, nil, p.coder, "PUT", w+"/cursors/main", M{"seq": got.Seq, "lease": sva.Lease}, 400, &r)
		if !strings.Contains(r.Error.Message, "the cursor main is moved without one") {
			t.Fatalf("a lease moving another cursor is refused with %+v", r.Error)
		}

		p.listen(t, "wait=0&project=SVA&take=1")
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": sva.Lease}, 409, &r)
		if r.Error.Reason != "lease_stale" {
			t.Fatalf("an acknowledgment with SVA's lease taken over is refused with %+v", r.Error)
		}
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": everything.Lease}, 200, nil)
	})
}

// TestWhereAProjectsFirstListenerStarts: a project first listened to
// beside a live listener of everything takes over that one's queue of its
// project's items, but never the item it holds in hand; with no live
// listener of everything, it starts at the present, and history is not
// replayed.
func TestWhereAProjectsFirstListenerStarts(t *testing.T) {
	t.Parallel()
	each := func(t *testing.T, test func(t *testing.T, p projectListening)) {
		t.Helper()
		testdb.Each(t, func(t *testing.T, st store.Store) { test(t, newProjectListening(t, st)) })
	}
	t.Run("the first queued item of its project, not handed out yet, is the project listener's", func(t *testing.T) {
		each(t, func(t *testing.T, p projectListening) {
			everything := p.listen(t, "wait=0")
			queued := p.give(t, "SVA")
			if sva := p.listen(t, "wait=0&project=SVA"); sva.Item == nil || sva.Item.Task != queued {
				t.Fatalf("SVA's first wait got %+v, want %s, which the listener of everything had not been handed", sva.Item, queued)
			}
			if got := p.listen(t, "wait=0&lease="+everything.Lease); got.Item != nil {
				t.Fatalf("the listener of everything got %+v, SVA's", got.Item)
			}
		})
	})

	t.Run("a session of everything on a token kept to SVA holds an SVA item; a session of SVA on a token for all is not handed it", func(t *testing.T) {
		each(t, func(t *testing.T, p projectListening) {
			var kept struct{ Token string }
			p.call(t, p.owner, "", "POST", w+"/tokens", M{"user": "@coder", "projects": []string{"SVA"}}, 201, &kept)
			var everything listened
			p.call(t, nil, kept.Token, "GET", w+"/listen?wait=0", nil, 200, &everything)
			p.give(t, "ART")
			key := p.give(t, "SVA")
			var inHand listened
			p.call(t, nil, kept.Token, "GET", w+"/listen?wait=0&lease="+everything.Lease, nil, 200, &inHand)
			if inHand.Item == nil || inHand.Item.Task != key {
				t.Fatalf("the session of everything on the token kept to SVA got %+v, want %s", inHand.Item, key)
			}
			if sva := p.listen(t, "wait=0&project=SVA"); sva.Item != nil {
				t.Fatalf("SVA's first wait was handed %+v, which the session of everything holds", sva.Item)
			}
		})
	})

	t.Run("beside a live listener of everything, it takes over the queued items of its project", func(t *testing.T) {
		each(t, func(t *testing.T, p projectListening) {
			everything := p.listen(t, "wait=0")
			art := p.give(t, "ART")
			inHand := p.listen(t, "wait=0&lease="+everything.Lease)
			if inHand.Item == nil || inHand.Item.Task != art {
				t.Fatalf("the listener of everything got %+v, want %s", inHand.Item, art)
			}
			queued := p.give(t, "SVA")
			sva := p.listen(t, "wait=0&project=SVA")
			if sva.Item == nil || sva.Item.Task != queued {
				t.Fatalf("SVA's first wait got %+v, want %s, queued behind the item in hand", sva.Item, queued)
			}
			p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": inHand.Seq, "lease": everything.Lease}, 200, nil)
			if got := p.listen(t, "wait=0&lease="+everything.Lease); got.Item != nil {
				t.Fatalf("after its acknowledgment the listener of everything got %+v, SVA's", got.Item)
			}
		})
	})

	t.Run("the item the listener of everything holds in hand is not handed to the project's listener as well", func(t *testing.T) {
		each(t, func(t *testing.T, p projectListening) {
			everything := p.listen(t, "wait=0")
			key := p.give(t, "SVA")
			inHand := p.listen(t, "wait=0&lease="+everything.Lease)
			if inHand.Item == nil || inHand.Item.Task != key {
				t.Fatalf("the listener of everything got %+v, want %s", inHand.Item, key)
			}
			sva := p.listen(t, "wait=0&project=SVA")
			if sva.Item != nil {
				t.Fatalf("SVA's first wait was handed %+v, which the listener of everything holds", sva.Item)
			}
			p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": inHand.Seq, "lease": everything.Lease}, 200, nil)
			next := p.give(t, "SVA")
			if got := p.listen(t, "wait=0&project=SVA&lease="+sva.Lease); got.Item == nil || got.Item.Task != next {
				t.Fatalf("SVA's next wait got %+v, want %s", got.Item, next)
			}
		})
	})

	t.Run("with no live listener of everything, it starts at the present", func(t *testing.T) {
		each(t, func(t *testing.T, p projectListening) {
			everything := p.listen(t, "wait=0")
			p.give(t, "SVA")
			runOut(t, p.st, everything.Lease)
			first := p.listen(t, "wait=0&project=SVA")
			if first.Item != nil {
				t.Fatalf("SVA's first wait handed over %+v from before it", first.Item)
			}
			key := p.give(t, "SVA")
			if next := p.listen(t, "wait=0&project=SVA&lease="+first.Lease); next.Item == nil || next.Item.Task != key {
				t.Fatalf("SVA's next wait answered %+v, want %s", next.Item, key)
			}
		})
	})
}

// TestAWaitForEverythingHandsNothingOfAProjectThatGotItsOwnListener: a
// wait of the listener of everything blocked when a project gets a
// listener of its own does not hand over that project's item when it
// comes: the project's listener does.
func TestAWaitForEverythingHandsNothingOfAProjectThatGotItsOwnListener(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		everything := p.listen(t, "wait=0")
		blocked := make(chan listened, 1)
		go func() {
			req, _ := http.NewRequest(http.MethodGet, p.url+w+"/listen?wait=20&lease="+everything.Lease, nil)
			req.Header.Set("Authorization", "Bearer "+p.coder)
			var got listened
			if resp, err := http.DefaultClient.Do(req); err == nil {
				_ = json.NewDecoder(resp.Body).Decode(&got) // a body that is not an answer leaves got empty, which the test then says
				resp.Body.Close()
			}
			blocked <- got
		}()
		blockedOn(t, st, everything.Lease)
		sva := p.listen(t, "wait=0&project=SVA")
		key := p.give(t, "SVA")
		select {
		case got := <-blocked:
			if got.Lease != everything.Lease || got.Item != nil {
				t.Fatalf("the wait of everything answered %+v (item %+v), want its lease and no item", got, got.Item)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("the wait of everything did not wake for the item")
		}
		if got := p.listen(t, "wait=0&project=SVA&lease="+sva.Lease); got.Item == nil || got.Item.Task != key {
			t.Fatalf("SVA's listener got %+v, want %s", got.Item, key)
		}
	})
}

// TestAProjectsListenerIsForgottenOnlyWhenNothingHoldsIt: the way back for
// a project that should go to the listener of everything again: forgetting
// its listener, refused while its lease lives, drops it and its cursor;
// forgetting one that is not there is done already.
func TestAProjectsListenerIsForgottenOnlyWhenNothingHoldsIt(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		everything := p.listen(t, "wait=0")
		sva := p.listen(t, "wait=0&project=SVA&by=a+chat")
		var r refusal
		p.call(t, nil, p.coder, "DELETE", w+"/listening/SVA", nil, 409, &r)
		if r.Error.Reason != "listening_elsewhere" || !strings.Contains(r.Error.Message, "already listening to SVA from another session (a chat, ") {
			t.Fatalf("forgetting a live listener is refused with %+v", r.Error)
		}
		runOut(t, st, sva.Lease)
		type forgot struct {
			Project   string
			Forgotten bool
			DryRun    bool `json:"dry_run"`
		}
		var dry forgot
		p.call(t, nil, p.coder, "DELETE", w+"/listening/SVA?dry_run=1", nil, 200, &dry)
		if !dry.Forgotten || !dry.DryRun || p.listenersOf(t) != 2 {
			t.Fatalf("a dry run answered %+v and left %d listeners, want both", dry, p.listenersOf(t))
		}
		var done forgot
		p.call(t, nil, p.coder, "DELETE", w+"/listening/sva", nil, 200, &done)
		if done.Project != "SVA" || !done.Forgotten || p.listenersOf(t) != 1 {
			t.Fatalf("forgetting answered %+v and left %d listeners", done, p.listenersOf(t))
		}
		var cursors struct{ Cursors map[string]int64 }
		p.call(t, nil, p.coder, "GET", w+"/me", nil, 200, &cursors)
		for name := range cursors.Cursors {
			if strings.HasPrefix(name, "listen:") {
				t.Fatalf("the forgotten listener's cursor %s stays", name)
			}
		}
		key := p.give(t, "SVA")
		if got := p.listen(t, "wait=0&lease="+everything.Lease); got.Item == nil || got.Item.Task != key {
			t.Fatalf("after SVA was forgotten the listener of everything got %+v, want %s", got.Item, key)
		}
		p.call(t, nil, p.coder, "DELETE", w+"/listening/SVA", nil, 200, &done)
		if done.Forgotten {
			t.Fatalf("forgetting again answered %+v", done)
		}
		p.call(t, nil, p.coder, "DELETE", w+"/listening/NOPE", nil, 404, nil)
	})
}

// listenersOf counts @coder's listeners, as stored.
func (p projectListening) listenersOf(t *testing.T) int {
	t.Helper()
	n, err := p.st.Count(context.Background(), "listeners")
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestWhatListensToEachProjectIsTold: GET /listening keeps its first fields
// for the listener of everything and lists every listener; /agents and
// /agents/connection say, beside whether the agent listens at all, which
// projects (and whether items of no project) a live listener is handed,
// held to the same rule as delivery.
func TestWhatListensToEachProjectIsTold(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		ids := map[string]string{"SVA": p.project(t, "SVA").ID, "ART": p.project(t, "ART").ID}
		type shown struct {
			ProjectID string `json:"project_id"`
			Project   string
			By        string
			LastHeard string `json:"last_heard"`
			Live      bool
		}
		type reach struct {
			Handle                   string
			Listening                bool
			Listeners                []shown
			ListeningProjects        []string `json:"listening_projects"`
			ListeningOutsideProjects bool     `json:"listening_outside_projects"`
		}
		connection := func(path string) reach {
			t.Helper()
			var out struct{ Agents []reach }
			p.call(t, p.owner, "", "GET", w+path, nil, 200, &out)
			for _, a := range out.Agents {
				if a.Handle == "@coder" {
					return a
				}
			}
			t.Fatalf("%s has no @coder", path)
			return reach{}
		}
		type listening struct {
			Listening bool
			By        string
			Listeners []shown
		}

		var none listening
		p.call(t, nil, p.coder, "GET", w+"/listening", nil, 200, &none)
		if got := connection("/agents/connection"); none.Listening || none.Listeners == nil || len(none.Listeners) != 0 ||
			got.Listening || len(got.ListeningProjects) != 0 || got.ListeningOutsideProjects {
			t.Fatalf("with nothing listening /listening says %+v and /agents/connection %+v", none, got)
		}

		sva := p.listen(t, "wait=0&project=SVA&by=a+chat")
		var one listening
		p.call(t, nil, p.coder, "GET", w+"/listening", nil, 200, &one)
		if one.Listening || len(one.Listeners) != 1 || one.Listeners[0].Project != "SVA" || one.Listeners[0].ProjectID != ids["SVA"] ||
			one.Listeners[0].By != "a chat" || !one.Listeners[0].Live || one.Listeners[0].LastHeard == "" {
			t.Fatalf("with SVA's listener only, /listening says %+v", one)
		}
		for _, path := range []string{"/agents/connection", "/agents"} {
			if got := connection(path); !got.Listening || strings.Join(got.ListeningProjects, ",") != ids["SVA"] || got.ListeningOutsideProjects {
				t.Fatalf("with SVA's listener only, %s says %+v", path, got)
			}
		}

		p.listen(t, "wait=0&by=a+companion")
		runOut(t, st, sva.Lease)
		var both listening
		p.call(t, nil, p.coder, "GET", w+"/listening", nil, 200, &both)
		if !both.Listening || both.By != "a companion" || len(both.Listeners) != 2 || both.Listeners[0].Project != "" || !both.Listeners[0].Live ||
			both.Listeners[1].Project != "SVA" || both.Listeners[1].Live {
			t.Fatalf("with everything live and SVA's gone, /listening says %+v", both)
		}
		// SVA waits for its own listener: everything is not handed its items, and the pages are told so.
		if got := connection("/agents/connection"); !got.Listening || strings.Join(got.ListeningProjects, ",") != ids["ART"] || !got.ListeningOutsideProjects {
			t.Fatalf("with everything live and SVA's gone, /agents/connection says %+v", got)
		}
	})
}

// TestAnAgentListensToAProjectWithTheCommand: quadit wait project=KEY
// against a real server listens to that project, and the lines it prints
// to go on keep to it, as run; quadit listening says what listens to each
// project; quadit listening forget project=KEY is refused while the
// project's session lives, and checks without forgetting in a dry run.
func TestAnAgentListensToAProjectWithTheCommand(t *testing.T) {
	// Not in parallel: the command line it runs reads the process's environment (t.Setenv).
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		run := func(args ...string) string {
			t.Helper()
			out, code := p.quadit(t, p.coder, args...)
			if code != 0 {
				t.Fatalf("quadit %s said (%d):\n%s", strings.Join(args, " "), code, out)
			}
			return out
		}
		out := run("wait", "project=sva", "for=1")
		next := regexp.MustCompile(`(?m)^quadit wait project=SVA for=1 lease=[A-Z0-9]{8} --workspace=[0-9a-f-]{36}`).FindString(out)
		if !strings.HasPrefix(out, "IDLE\n") || next == "" {
			t.Fatalf("the first quadit wait project=sva said:\n%s", out)
		}
		p.give(t, "ART")
		key := p.give(t, "SVA")
		out = run(strings.Fields(next)[1:]...)
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if len(lines) != 5 || !strings.Contains(lines[0], " assigned "+key+" ") || !strings.HasPrefix(lines[4], next+"   # then go on listening") {
			t.Fatalf("the next wait said:\n%s", out)
		}
		ack, _, _ := strings.Cut(lines[3], "   #")
		run(strings.Fields(ack)[1:]...)

		if out := run("listening"); out != "SVA: a chat listens (last heard "+regexp.MustCompile(`\d{4}-\d\d-\d\d \d\d:\d\d`).FindString(out)+" UTC).\n"+
			"Everything else: nothing listens now, and those items wait in the inbox; it leaves out SVA, which has a listener of its own.\n" {
			t.Fatalf("quadit listening said:\n%s", out)
		}
		if out, code := p.quadit(t, p.coder, "listening", "forget", "project=SVA"); code == 0 || !strings.Contains(out, "already listening to SVA from another session") {
			t.Fatalf("forgetting SVA while it listens said (%d):\n%s", code, out)
		}
		lease := regexp.MustCompile(`lease=([A-Z0-9]{8})`).FindStringSubmatch(next)[1]
		runOut(t, st, lease)
		if out := run("--dry-run", "listening", "forget", "project=SVA"); !strings.HasPrefix(out, "would be accepted: Forgot the listener of SVA") || p.listenersOf(t) != 1 {
			t.Fatalf("a dry forget said:\n%s", out)
		}
		if out := run("listening", "forget", "project=SVA"); !strings.HasPrefix(out, "Forgot the listener of SVA") || p.listenersOf(t) != 0 {
			t.Fatalf("forget said:\n%s", out)
		}
	})
}

// TestForgettingAProjectNeverReplays: after a project's listener is
// forgotten its items go to the listener of everything from now on: what
// was pending for either stays unread in the inbox, and nothing already
// acknowledged comes again.
func TestForgettingAProjectNeverReplays(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		everything := p.listen(t, "wait=0")
		p.give(t, "ART") // pending for everything, which is far behind
		sva := p.listen(t, "wait=0&project=SVA")
		p.give(t, "SVA")
		got := p.listen(t, "wait=0&project=SVA&lease="+sva.Lease)
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": got.Seq, "lease": sva.Lease}, 200, nil)
		runOut(t, st, sva.Lease)
		p.call(t, nil, p.coder, "DELETE", w+"/listening/SVA", nil, 200, nil)
		if old := p.listen(t, "wait=0&lease="+everything.Lease); old.Item != nil {
			t.Fatalf("after the forget the listener of everything got %+v, from before it", old.Item)
		}
		key := p.give(t, "SVA")
		if now := p.listen(t, "wait=0&lease="+everything.Lease); now.Item == nil || now.Item.Task != key {
			t.Fatalf("a new item of the forgotten project went %+v, want %s to the listener of everything", now.Item, key)
		}
	})
}

// TestALoginKeptToSomeProjectsLearnsNothingOfTheOthersListeners: a login
// kept to SVA asking to listen to ART is answered as for a project that
// does not exist, naming only the projects it may read; it does not see
// the cursor of the agent's listener of ART, nor move it, while the cursor
// listen keeps its acknowledgment without a lease.
func TestALoginKeptToSomeProjectsLearnsNothingOfTheOthersListeners(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		p.listen(t, "wait=0&project=ART")
		art := p.project(t, "ART")
		var kept struct{ Token string }
		p.call(t, p.owner, "", "POST", w+"/tokens", M{"user": "@coder", "projects": []string{"SVA"}}, 201, &kept)

		var hidden, missing refusal
		var hiddenAllowed, missingAllowed struct{ Error struct{ Allowed []string } }
		raw := p.call(t, nil, kept.Token, "GET", w+"/listen?wait=0&project=ART", nil, 404, &hidden)
		_ = json.Unmarshal([]byte(raw), &hiddenAllowed)
		raw = p.call(t, nil, kept.Token, "GET", w+"/listen?wait=0&project=NOPE", nil, 404, &missing)
		_ = json.Unmarshal([]byte(raw), &missingAllowed)
		if hidden.Error.Message != `project "ART" does not exist in this workspace` || missing.Error.Message != `project "NOPE" does not exist in this workspace` ||
			strings.Join(hiddenAllowed.Error.Allowed, ",") != "SVA" || strings.Join(missingAllowed.Error.Allowed, ",") != "SVA" {
			t.Fatalf("a hidden project is answered %+v %v, a missing one %+v %v", hidden.Error, hiddenAllowed.Error.Allowed, missing.Error, missingAllowed.Error.Allowed)
		}

		var me struct{ Cursors map[string]int64 }
		p.call(t, nil, kept.Token, "GET", w+"/me", nil, 200, &me)
		if _, seen := me.Cursors["listen:"+art.ID]; seen {
			t.Fatalf("the login kept to SVA sees the cursors %v", me.Cursors)
		}
		p.call(t, nil, p.coder, "GET", w+"/me", nil, 200, &me)
		if _, seen := me.Cursors["listen:"+art.ID]; !seen {
			t.Fatalf("the agent's own login does not see the cursor of its listener of ART: %v", me.Cursors)
		}
		p.give(t, "ART")
		seq := p.seq(t)
		p.call(t, nil, kept.Token, "PUT", w+"/cursors/listen:"+art.ID, M{"seq": seq}, 404, nil)
		p.call(t, nil, kept.Token, "GET", w+"/cursors/listen:"+art.ID, nil, 404, nil)
		p.call(t, nil, kept.Token, "GET", w+"/events?cursor=listen:"+art.ID+"&ack="+strconv.FormatInt(seq, 10), nil, 404, nil)
		p.call(t, nil, kept.Token, "PUT", w+"/cursors/listen", M{"seq": seq}, 200, nil)
	})
}

// seq is where the feed stands.
func (p projectListening) seq(t *testing.T) int64 {
	t.Helper()
	var me struct{ Seq int64 }
	p.call(t, nil, p.coder, "GET", w+"/me", nil, 200, &me)
	return me.Seq
}

// TestAListenerFromBeforeTheLeaseLeavesOutProjectsListenedToByThemselves:
// the read a `quadit listen` from before the lease makes is the listener of
// everything's, and leaves out the items of a project that has a listener
// of its own.
func TestAListenerFromBeforeTheLeaseLeavesOutProjectsListenedToByThemselves(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		p.listen(t, "wait=0&project=SVA")
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen", M{"seq": p.seq(t)}, 200, nil)
		p.give(t, "SVA")
		art := p.give(t, "ART")
		var page struct {
			Events []struct {
				ProjectID string `json:"project_id"`
			}
		}
		p.call(t, nil, p.coder, "GET", w+"/events?cursor=listen&inbox=1&wait=1&limit=5&types=notification.created", nil, 200, &page)
		if len(page.Events) != 1 || page.Events[0].ProjectID != p.project(t, "ART").ID {
			t.Fatalf("the old companion's read gave %+v, want only %s's item", page.Events, art)
		}
	})
}

// TestADryAcknowledgmentChecksTheCursorOfItsLease: an acknowledgment's dry
// run says where the cursor of its lease's listener would stand, and
// refuses a lease taken over, as the acknowledgment itself would.
func TestADryAcknowledgmentChecksTheCursorOfItsLease(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		sva := p.listen(t, "wait=0&project=SVA")
		p.give(t, "SVA")
		got := p.listen(t, "wait=0&project=SVA&lease="+sva.Lease)
		var dry struct {
			Name string
			Seq  int64
		}
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen?dry_run=1", M{"seq": got.Seq, "lease": sva.Lease}, 200, &dry)
		if dry.Name != "listen:"+p.project(t, "SVA").ID || dry.Seq != got.Seq {
			t.Fatalf("the dry acknowledgment answered %+v", dry)
		}
		p.listen(t, "wait=0&project=SVA&take=1")
		var r refusal
		p.call(t, nil, p.coder, "PUT", w+"/cursors/listen?dry_run=1", M{"seq": got.Seq, "lease": sva.Lease}, 409, &r)
		if r.Error.Reason != "lease_stale" {
			t.Fatalf("a dry acknowledgment with a lease taken over is refused with %+v", r.Error)
		}
	})
}

// listenerRow is the agent's listener of SVA as stored.
func (r *aRunner) listenerRow(t *testing.T) core.Listener {
	t.Helper()
	var l core.Listener
	if err := r.st.Get(context.Background(), &l, store.Eq("agent_id", r.claudeID), store.Eq("project_id", r.sva.ID)); err != nil {
		t.Fatal(err)
	}
	return l
}

// shownRunner is a runner listener's mark as pages read it.
type shownRunner struct {
	Machine, Folder, Program, Since, Paused, Task string
	ProgramVersion                                string `json:"program_version"`
	PausedUntil                                   string `json:"paused_until"`
	Holding                                       bool
}

// runnerShown is the mark of @claude's listener of SVA in GET /listening,
// as its agent reads it, or nil.
func (r *aRunner) runnerShown(t *testing.T) *shownRunner {
	t.Helper()
	var out struct {
		Listeners []struct {
			Project string
			Runner  *shownRunner
		}
	}
	r.call(t, nil, r.claude, "GET", w+"/listening", nil, 200, &out)
	for _, l := range out.Listeners {
		if l.Project == "SVA" {
			return l.Runner
		}
	}
	t.Fatalf("no listener of SVA in %+v", out)
	return nil
}

func TestARunnerHoldMarksTheListenerWithItsMachine(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		l := r.listenerRow(t)
		if l.MachineID != "3f9c0a7d5e21b864" || l.MachineName != "Aram's MacBook Pro" || l.RunnerFolder != "~/devel/game" || l.RunnerProgram != "claude" ||
			l.RunnerVersion != "2.1.331" || !l.RunnerHolds || l.RunnerSeenAt == 0 || l.RunnerSeenAt != l.HeardAt || l.HeldBy != "Quadit's runner" {
			t.Fatalf("the runner's listener is %+v", l)
		}
		if got := r.runnerShown(t); got == nil || !got.Holding || got.Machine != "Aram's MacBook Pro" || got.ProgramVersion != "2.1.331" || got.Since == "" || got.Paused != "" {
			t.Fatalf("the listener is shown with %+v", got)
		}
		r.hold(t, "&paused=usage_limit&paused_until=1732471200000")
		if got := r.runnerShown(t); got.Paused != "usage_limit" || got.PausedUntil == "" {
			t.Fatalf("a paused runner is shown %+v", got)
		}
		r.hold(t, "&paused=not_signed_in")
		if got := r.runnerShown(t); got.Paused != "not_signed_in" || got.PausedUntil != "" {
			t.Fatalf("the runner's new pause is shown %+v", got)
		}
		r.hold(t, "&paused=")
		if got := r.runnerShown(t); got.Paused != "" {
			t.Fatalf("a pause cleared is shown %+v", got)
		}
	})
}

func TestAnyOtherHoldClearsRunnerHolds(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		var chat listened
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&take=1&by=a+chat", nil, 200, &chat)
		l := r.listenerRow(t)
		if l.RunnerHolds || l.MachineID == "" || l.MachineName != "Aram's MacBook Pro" || l.Lease != chat.Lease {
			t.Fatalf("after a chat took over, the listener is %+v", l)
		}
		if got := r.runnerShown(t); got == nil || got.Holding {
			t.Fatalf("a listener a chat holds shows its runner as %+v", got)
		}
		var refused struct{ Error struct{ Reason string } }
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&"+runnerOf+"&lease="+r.lease, nil, 409, &refused)
		if refused.Error.Reason != "listening_elsewhere" {
			t.Fatalf("the runner was refused %+v", refused)
		}
	})
}

func TestAMachineOnlyListensToOneProject(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		for _, bad := range []struct{ query, field string }{
			{"/listen?wait=0&" + runnerOf, "project"},
			{"/listen?wait=0&project=SVA&batch=1", "machine_id"},
			{"/listen?wait=0&project=SVA&folder=~/x", "machine_id"},
			{"/listen?wait=0&project=SVA&" + strings.Replace(runnerOf, "3f9c0a7d5e21b864", "3F9C", 1), "machine_id"},
			{"/listen?wait=0&project=SVA&" + strings.Replace(runnerOf, "~/devel/game", "devel", 1), "folder"},
			{"/listen?wait=0&project=SVA&" + strings.Replace(runnerOf, "program=claude", "program=vim", 1), "program"},
			{"/listen?wait=0&project=SVA&" + strings.Replace(runnerOf, "2.1.331", "2.1+331", 1), "program_version"},
			{"/listen?wait=0&project=SVA&" + strings.Replace(runnerOf, "Aram%27s+MacBook+Pro", "%0A", 1), "machine_name"},
			{"/listen?wait=0&project=SVA&paused=asleep&" + runnerOf, "paused"},
			{"/listen?wait=0&project=SVA&paused=not_signed_in&paused_until=5&" + runnerOf, "paused_until"},
		} {
			var refused struct{ Error struct{ Field string } }
			r.call(t, nil, r.claude, "GET", w+bad.query, nil, 400, &refused)
			if refused.Error.Field != bad.field {
				t.Errorf("%s was refused naming %q, want %q", bad.query, refused.Error.Field, bad.field)
			}
		}
		// A person's login listens to nothing.
		r.call(t, r.owner, "", "GET", w+"/listen?wait=0&project=SVA&"+runnerOf, nil, 403, nil)
	})
}

func TestReleasingARunnerClearsItsMarkAndEndsItsLease(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		var out struct {
			Project  string
			Released bool
			DryRun   bool `json:"dry_run"`
		}
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864&dry_run=1", nil, 200, &out)
		if !out.Released || !out.DryRun || r.listenerRow(t).MachineID == "" {
			t.Fatalf("a dry release answered %+v", out)
		}
		r.call(t, r.owner, "", "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 403, nil)
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=nope", nil, 400, nil)
		cursorBefore := r.cursor(t)
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, &out)
		l := r.listenerRow(t)
		if out.Project != "SVA" || !out.Released || l.MachineID != "" || l.MachineName != "" || l.RunnerFolder != "" || l.RunnerHolds || l.RunnerSeenAt != 0 ||
			l.LeaseLives(time.Now().UnixMilli()) || r.cursor(t) != cursorBefore {
			t.Fatalf("the release answered %+v and left %+v", out, l)
		}
		if r.listening(t, "claude") {
			t.Fatal("the agent still shows as listening")
		}
		// A chat listens at once, without taking over; and a release again is done already.
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&by=a+chat", nil, 200, nil)
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, &out)
		if out.Released {
			t.Fatalf("a second release answered %+v", out)
		}
	})
}

// cursor is where the runner's listener of SVA stands.
func (r *aRunner) cursor(t *testing.T) int64 {
	t.Helper()
	var c core.Cursor
	if err := r.st.Get(context.Background(), &c, store.Eq("user_id", r.claudeID), store.Eq("name", "listen:"+r.sva.ID)); err != nil {
		t.Fatal(err)
	}
	return c.Seq
}

func TestReleasingARunnerOfAnotherMachineReleasesNothing(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		var out struct{ Released bool }
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=0000000000000000", nil, 200, &out)
		if l := r.listenerRow(t); out.Released || l.MachineID != "3f9c0a7d5e21b864" || !l.HeldByRunner(time.Now().UnixMilli()) {
			t.Fatalf("another machine's release answered %+v and left %+v", out, l)
		}
		// A chat that holds the project keeps it when the runner is let go.
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&take=1&by=a+chat", nil, 200, nil)
		r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, &out)
		if l := r.listenerRow(t); !out.Released || !l.LeaseLives(time.Now().UnixMilli()) {
			t.Fatalf("the release ended the chat's lease: %+v", l)
		}
	})
}

func TestListenAnswersTheOtherItemsOfTheSameTaskWhenAskedForABatch(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		other := r.task(t, M{"assignee": "@claude"})
		r.drain(t)
		r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "first"})
		r.change(t, r.owner, "", "comment.create", M{"task": other, "body": "elsewhere"})
		r.itemOf(t, core.Notification{Type: core.NoteWaitingOn, ActorID: r.ownerID(t), TaskID: r.taskID(t, key), Addressed: true}, id.New())
		for i := range 21 {
			r.change(t, r.owner, "", "comment.create", M{"task": key, "body": fmt.Sprint("more ", i)})
		}
		got := r.hold(t, "&batch=1")
		if got.Item.Task != key || got.Wake.Do != "run" || len(got.Batch) != 20 {
			t.Fatalf("the head %+v came with %d more", got.Item, len(got.Batch))
		}
		// The rule's item, which starts nothing, is not in the batch: it
		// comes as a head of its own.
		for i, b := range got.Batch {
			if b.Item.Task != key || b.Seq != b.Item.Seq || b.Line == "" || b.Wake.Do != "run" || (i > 0 && b.Seq <= got.Batch[i-1].Seq) {
				t.Fatalf("batch item %d is %+v", i, b)
			}
		}
		if l := r.listenerRow(t); l.HandedSeq != got.Seq {
			t.Fatalf("the batch was recorded as handed: %d, the head %d", l.HandedSeq, got.Seq)
		}
		// Without batch=1, or for an item of no task, no batch.
		var plain map[string]json.RawMessage
		r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&"+runnerOf+"&lease="+r.lease, nil, 200, &plain)
		if _, has := plain["batch"]; has {
			t.Fatal("a hold that did not ask for a batch got one")
		}
		r.drain(t)
		page := r.change(t, r.owner, "", "doc.create", M{"title": "Design", "project": "SVA"})["ref"]
		r.change(t, r.owner, "", "comment.create", M{"doc": page, "body": "@claude read this"})
		if got := r.hold(t, "&batch=1"); got.Item.ID == "" || got.Batch != nil {
			t.Fatalf("a page's item came with a batch: %+v", got)
		}
	})
}

func TestListenNamesTheDecisionOfADecisionItem(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		key := r.task(t, nil)
		r.drain(t)
		question := r.change(t, r.owner, "", "decision.open", M{"task": key, "question": "Which boss?", "options": []M{{"label": "Big"}, {"label": "Small"}}, "ask": "@claude"})["ref"]
		got := r.hold(t, "")
		if got.Item.Type != "decision_asked" || got.Item.Decision != question {
			t.Fatalf("the item about a decision is %+v", got.Item)
		}
		r.ack(t, got.Seq)
		r.change(t, r.owner, "", "comment.create", M{"task": key, "body": "@claude and this"})
		if got := r.hold(t, ""); got.Item.Type != "mentioned" || got.Item.Decision != "" {
			t.Fatalf("an item about no decision is %+v", got.Item)
		}
	})
}

// TestAHoldWithoutTheRunnersParametersAnswersAsBefore: what the released
// command and skill send gets, byte for byte, what it got before runners,
// but for what every item answer now carries: what a runner would do with
// it (wake).
func TestAHoldWithoutTheRunnersParametersAnswersAsBefore(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		var first listened
		raw := p.call(t, nil, p.coder, "GET", w+"/listen?wait=0&project=SVA&by=a+chat", nil, 200, &first)
		if want := fmt.Sprintf(`{"lease":%q,"project":"SVA"}`, first.Lease); raw != want+"\n" && raw != want {
			t.Fatalf("an empty hold answered %s", raw)
		}
		p.give(t, "SVA")
		var item struct {
			Item struct{ ID, At string }
			Line string
			Seq  int64
		}
		raw = p.call(t, nil, p.coder, "GET", w+"/listen?wait=0&project=SVA&lease="+first.Lease, nil, 200, &item)
		head := fmt.Sprintf(`{"item":{"id":%q,"seq":%d,"type":"assigned","by":"@aram","task":"SVA-1","title":"SVA-1 Work in SVA","at":%q},"lease":%q,"line":%q,"project":"SVA","seq":%d`,
			item.Item.ID, item.Seq, item.Item.At, first.Lease, item.Line, item.Seq)
		if strings.TrimSpace(raw) != head+`,"wake":{"do":"run","why":"for_you"}}` {
			t.Fatalf("an item was answered\n%s\nwant what it was before, and its wake:\n%s}", raw, head)
		}
		var all listened
		p.call(t, nil, p.coder, "GET", w+"/listen?wait=0", nil, 200, &all)
		p.mention(t)
		raw = p.call(t, nil, p.coder, "GET", w+"/listen?wait=0&lease="+all.Lease, nil, 200, &item)
		if !strings.HasPrefix(raw, `{"item":{"id":`) || !strings.HasSuffix(strings.TrimSpace(raw), fmt.Sprintf(`"lease":%q,"line":%q,"seq":%d,"wake":{"do":"ack","why":"page"}}`, all.Lease, item.Line, item.Seq)) {
			t.Fatalf("an item of no project was answered %s", raw)
		}
	})
}

func TestTheConnectionReadsTellARunnerAndItsState(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		r.change(t, r.owner, "", "project.create", M{"key": "ART", "name": "Art"})
		key := r.task(t, nil)
		art := r.change(t, r.owner, "", "task.create", M{"project": "ART", "title": "Sky"})["key"].(string)
		// read is the mark of @claude's listener of SVA as /agents and
		// /agents/connection tell it to the owner.
		read := func(t *testing.T) *shownRunner {
			t.Helper()
			var out struct {
				Agents []struct {
					Handle    string
					Listeners []struct {
						Project string
						Runner  *shownRunner
					}
				}
			}
			var runners []*shownRunner
			for _, path := range []string{"/agents", "/agents/connection"} {
				r.call(t, r.owner, "", "GET", w+path, nil, 200, &out)
				for _, a := range out.Agents {
					for _, l := range a.Listeners {
						if a.Handle == "@claude" && l.Project == "SVA" {
							runners = append(runners, l.Runner)
						}
					}
				}
			}
			if len(runners) != 2 || (runners[0] == nil) != (runners[1] == nil) || runners[0] != nil && *runners[0] != *runners[1] {
				t.Fatalf("the reads differ: %+v", runners)
			}
			return runners[0]
		}

		t.Run("holding, with the task of its own project it works on", func(t *testing.T) {
			// A run of the agent on that machine on another project's task is
			// not this listener's.
			var artLease listened
			r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=ART&"+runnerOf, nil, 200, &artLease)
			r.change(t, nil, r.claude, "session.start", M{"task": art, "state": "waiting", "program": "claude", "machine_id": "3f9c0a7d5e21b864",
				"machine_name": "Aram's MacBook Pro", "folder": "~/devel/art", "lease": artLease.Lease, "item_seq": 1})
			if got := read(t); got == nil || !got.Holding || got.Task != "" {
				t.Fatalf("a runner working on another project's task is told %+v", got)
			}
			r.hold(t, "")
			r.change(t, nil, r.claude, "session.start", M{"task": key, "state": "waiting", "program": "claude", "machine_id": "3f9c0a7d5e21b864",
				"machine_name": "Aram's MacBook Pro", "folder": "~/devel/game", "lease": r.lease, "item_seq": 1})
			if got := read(t); got == nil || !got.Holding || got.Task != key || got.Machine != "Aram's MacBook Pro" {
				t.Fatalf("a runner working on %s is told %+v", key, got)
			}
		})
		t.Run("paused", func(t *testing.T) {
			r.hold(t, "&paused=program_missing")
			if got := read(t); got.Paused != "program_missing" || !got.Holding {
				t.Fatalf("a paused runner is told %+v", got)
			}
		})
		t.Run("a chat holds it", func(t *testing.T) {
			r.call(t, nil, r.claude, "GET", w+"/listen?wait=0&project=SVA&take=1", nil, 200, nil)
			if got := read(t); got == nil || got.Holding {
				t.Fatalf("a listener a chat holds is told %+v", got)
			}
		})
		t.Run("away", func(t *testing.T) {
			runOut(t, st, r.listenerRow(t).Lease)
			if got := read(t); got == nil || got.Holding || got.Since == "" {
				t.Fatalf("a runner that went away is told %+v", got)
			}
		})
		t.Run("not to a member who may not read the project", func(t *testing.T) {
			var tok struct{ Token string }
			r.call(t, r.owner, "", "POST", w+"/tokens", M{"user": "me", "projects": []string{"ART"}}, 201, &tok)
			var out struct {
				Agents []struct {
					Handle    string
					Listeners []struct{ Project string }
				}
			}
			r.call(t, nil, tok.Token, "GET", w+"/agents/connection", nil, 200, &out)
			for _, a := range out.Agents {
				for _, l := range a.Listeners {
					if l.Project == "SVA" {
						t.Fatalf("a login kept to ART is told of %+v", a)
					}
				}
			}
		})
	})
}

// TestAReleasedLeaseIsDead: once the runner is let go, its lease hands
// nothing, moves no cursor and starts no run, even when it had run out
// before the release.
func TestAReleasedLeaseIsDead(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		r := newRunner(t, st)
		key := r.task(t, M{"assignee": "@claude"})
		for _, before := range []string{"after it ran out", "while it lives"} {
			t.Run(before, func(t *testing.T) {
				r.hold(t, "")
				old := r.lease
				if before == "after it ran out" {
					runOut(t, st, old)
				}
				r.call(t, nil, r.claude, "DELETE", w+"/listening/SVA/runner?machine_id=3f9c0a7d5e21b864", nil, 200, nil)
				if l := r.listenerRow(t); l.Lease != "" {
					t.Fatalf("the released listener keeps the lease %q", l.Lease)
				}
				var refused struct{ Error struct{ Reason string } }
				r.call(t, nil, r.claude, "PUT", w+"/cursors/listen:"+r.sva.ID, M{"seq": 1, "lease": old}, 409, &refused)
				if refused.Error.Reason != "lease_stale" {
					t.Errorf("an acknowledgment with the released lease: %+v", refused)
				}
				r.call(t, nil, r.claude, "POST", w+"/changes", M{"id": id.New(), "type": "session.start", "args": M{"task": key, "state": "waiting", "program": "claude",
					"machine_id": "3f9c0a7d5e21b864", "machine_name": "Aram's MacBook Pro", "folder": "~/devel/game", "lease": old, "item_seq": 1}}, 409, &refused)
				if refused.Error.Reason != "lease_stale" {
					t.Errorf("a start with the released lease: %+v", refused)
				}
				r.lease = "" // the runner asks again without the lease that was let go
			})
		}
	})
}
