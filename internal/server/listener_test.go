package server_test

import (
	"context"
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

// leaseOfAWaitOf is how long a lease lives past now for a wait of d.
func leaseOfAWaitOf(d time.Duration) time.Duration { return d + 90*time.Second }

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

		t.Run("the lease lives ninety seconds past the last request; run out, it still acknowledges, and a wait takes it again", func(t *testing.T) {
			// A wait of twenty seconds that an item ends at once: the ninety seconds count from then, not from the
			// twenty seconds the wait could have lasted.
			s.change(t, s.owner, "", "task.create", M{"project": "OPS", "title": "Renew the certificate", "assignee": "@coder"})
			var got listened
			s.call(t, nil, coder, "GET", w+"/listen?wait=20&lease="+first.Lease, nil, 200, &got)
			if got.Item == nil {
				t.Fatalf("the wait answered %+v", got)
			}
			if left := time.Until(time.UnixMilli(s.listeningUntil(t, st, "coder"))); left < 80*time.Second || left > 90*time.Second {
				t.Fatalf("after its wait the lease lives %s more, want ninety seconds", left)
			}
			// The agent handled the item for longer than that, and nobody took the lease meanwhile.
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
		// The first wait has blocked once its lease is held for its twenty seconds and ninety more.
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
// {seq}, never a lease) takes no lease, is refused nothing, moves its
// cursor, and counts as listening while its wait is held.
func TestAListenerFromBeforeTheLeaseKeepsWorking(t *testing.T) {
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
		if !s.listening(t, "coder") {
			t.Fatal("the agent whose old companion waits does not show as listening")
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

// TestAWaitGivenUpOnLeavesTheLeaseNinetySeconds: however a wait ends, here
// given up on by its client, the lease lives ninety seconds from then.
func TestAWaitGivenUpOnLeavesTheLeaseNinetySeconds(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		giveUp := func(path string) {
			t.Helper()
			ctx, cancel := context.WithCancel(context.Background())
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.url+path, nil)
			req.Header.Set("Authorization", "Bearer "+coder)
			done := make(chan struct{})
			go func() {
				defer close(done)
				if resp, err := http.DefaultClient.Do(req); err == nil {
					resp.Body.Close()
				}
			}()
			// Given up once the wait holds the lease for its twenty seconds.
			for deadline := time.Now().Add(5 * time.Second); time.Until(time.UnixMilli(s.listeningUntil(t, st, "coder"))) < leaseOfAWaitOf(10*time.Second); time.Sleep(20 * time.Millisecond) {
				if time.Now().After(deadline) {
					t.Fatal("the wait never held the lease")
				}
			}
			cancel()
			<-done
		}
		waitFor := func(what string, ok func(m core.Member) bool) {
			t.Helper()
			for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
				var m core.Member
				if err := st.Get(context.Background(), &m, store.Eq("handle", "coder")); err != nil {
					t.Fatal(err)
				}
				if ok(m) {
					return
				}
				if time.Now().After(deadline) {
					t.Fatalf("%s: the member reads lease %q until %d", what, m.ListenLease, m.ListeningUntil)
				}
			}
		}

		var held listened
		s.call(t, nil, coder, "GET", w+"/listen?wait=0", nil, 200, &held)
		giveUp(w + "/listen?wait=20&lease=" + held.Lease)
		waitFor("a wait given up on leaves ninety seconds", func(m core.Member) bool {
			left := time.Until(time.UnixMilli(m.ListeningUntil))
			return m.ListenLease == held.Lease && left > 80*time.Second && left <= 90*time.Second
		})
	})
}

// TestTheFirstWaitStartsAtThePresent: an agent with a history does not have
// it replayed when it first listens: only what comes after is handed over.
func TestTheFirstWaitStartsAtThePresent(t *testing.T) {
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
					_, err := tx.Update(context.Background(), "members", map[string]any{"listen_lease": "TAKENXYZ", "listening_until": time.Now().Add(time.Hour).UnixMilli()},
						store.Eq("handle", "coder"))
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
// something listens as the caller, what it said it is and since when,
// without taking the lease, so a chat can learn that a companion already
// answers for it; the refusal of a second session says it too.
func TestWhatListensIsToldWithoutTakingTheLease(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		type listener struct {
			Listening, Yours, Webhook bool
			By, Since                 string
			LastHeard                 string `json:"last_heard"`
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
		if !now.Listening || now.By != "a companion" || now.Since == "" || now.LastHeard == "" || now.Yours {
			t.Fatalf("with a companion listening the check says %+v", now)
		}
		s.call(t, nil, coder, "GET", w+"/listening?lease="+held.Lease, nil, 200, &now)
		if !now.Yours {
			t.Fatalf("asked with the live lease, the check says %+v", now)
		}
		var r refusal
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&by=a+chat", nil, 409, &r)
		if !strings.Contains(r.Error.Message, "already listening from another session (a companion, last heard ") {
			t.Fatalf("a second session is told %q", r.Error.Message)
		}
		s.call(t, nil, coder, "GET", w+"/listen?wait=0&lease="+held.Lease+"&by=a+companion%3B+rm+-rf", nil, 400, nil)
	})
}

// TestAnOlderListenerShowsAsListeningToTheCheckToo: while a quadit listen
// from before the lease holds its wait, GET /listening says the agent
// listens, as its pages do.
func TestAnOlderListenerShowsAsListeningToTheCheckToo(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		done := make(chan struct{})
		go func() {
			defer close(done)
			req, _ := http.NewRequest(http.MethodGet, s.url+w+"/events?cursor=listen&inbox=1&wait=3&limit=1&types=notification.created&compact=1", nil)
			req.Header.Set("Authorization", "Bearer "+coder)
			if resp, err := http.DefaultClient.Do(req); err == nil {
				resp.Body.Close()
			}
		}()
		for deadline := time.Now().Add(3 * time.Second); !s.listening(t, "coder"); time.Sleep(20 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatal("the older listener never showed as listening")
			}
		}
		var check struct {
			Listening bool
			By        string
		}
		s.call(t, nil, coder, "GET", w+"/listening", nil, 200, &check)
		if !check.Listening || check.By != "a quadit listen from before the lease" {
			t.Fatalf("while an older listener waits, the check says %+v", check)
		}
		<-done
	})
}
