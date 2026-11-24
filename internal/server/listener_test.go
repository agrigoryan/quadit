package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
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

// TestEachSessionIsHandedOnlyWhatItListensTo: the behaviour approved for a
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

// TestAProjectsFirstWaitStartsAtThePresent: a project first listened to
// does not have its history replayed, even when the agent had a cursor for
// everything.
func TestAProjectsFirstWaitStartsAtThePresent(t *testing.T) {
	t.Parallel()
	testdb.Each(t, func(t *testing.T, st store.Store) {
		p := newProjectListening(t, st)
		p.listen(t, "wait=0")
		p.give(t, "SVA")
		first := p.listen(t, "wait=0&project=SVA")
		if first.Item != nil {
			t.Fatalf("SVA's first wait handed over %+v from before it", first.Item)
		}
		key := p.give(t, "SVA")
		if next := p.listen(t, "wait=0&project=SVA&lease="+first.Lease); next.Item == nil || next.Item.Task != key {
			t.Fatalf("SVA's next wait answered %+v, want %s", next.Item, key)
		}
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
