package server_test

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// refusal is the error a call was refused with.
type refusal struct {
	Error struct{ Code, Reason, Message, Field string }
}

// connectCode is the answer of POST /connect-codes.
type connectCode struct {
	ID, Code, Agent, Tool string
	ExpiresAt             int64 `json:"expires_at"`
}

// connectState is the answer of GET /connect-codes/{id}.
type connectState struct {
	Used, Expired bool
}

// makeCode makes a connect code for an agent and a tool as a person.
func (s *site) makeCode(t *testing.T, hc *http.Client, agent, tool string) connectCode {
	t.Helper()
	var made connectCode
	s.call(t, hc, "", "POST", w+"/connect-codes", M{"agent": agent, "tool": tool}, 201, &made)
	return made
}

// connectedAt is when an agent was connected, as /agents says it; "" for
// not yet.
func (s *site) connectedAt(t *testing.T, handle string) string {
	t.Helper()
	var out struct {
		Agents []struct {
			Handle      string
			ConnectedAt string `json:"connected_at"`
			Listening   bool
		}
	}
	s.call(t, s.owner, "", "GET", w+"/agents", nil, 200, &out)
	for _, a := range out.Agents {
		if a.Handle == "@"+handle {
			return a.ConnectedAt
		}
	}
	t.Fatalf("no agent @%s", handle)
	return ""
}

// TestConnectCodes: a person who may make an agent a token makes a code
// for it and a tool; the agent gives it back with its own login and is
// connected; a wrong, used, replaced, expired or another agent's code is
// refused saying which, and guessing is limited.
func TestConnectCodes(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		other := s.agentToken(t, "other")
		bea, _ := s.invitedPerson(t)
		give := func(token, code string, want int) refusal {
			t.Helper()
			var r refusal
			s.call(t, nil, token, "POST", w+"/connect", M{"code": code}, want, &r)
			return r
		}

		t.Run("only a person who may make the agent a token makes one", func(t *testing.T) {
			made := s.makeCode(t, s.owner, "@coder", "Codex")
			if !regexp.MustCompile(`^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$`).MatchString(made.Code) || made.Tool != "Codex" {
				t.Fatalf("the code made is %+v", made)
			}
			if days := time.Until(time.UnixMilli(made.ExpiresAt)).Hours() / 24; days < 6.9 || days > 7 {
				t.Fatalf("the code is good for %.1f days, want 7", days)
			}
			s.call(t, bea, "", "POST", w+"/connect-codes", M{"agent": "@coder", "tool": "Codex"}, 403, nil)
			s.call(t, nil, coder, "POST", w+"/connect-codes", M{"agent": "@coder", "tool": "Codex"}, 403, nil)
			s.call(t, s.owner, "", "POST", w+"/connect-codes", M{"agent": "@aram", "tool": "Codex"}, 400, nil)
			s.call(t, s.owner, "", "POST", w+"/connect-codes", M{"agent": "@coder", "tool": " "}, 400, nil)
		})

		t.Run("the agent gives it back and is connected; its maker sees it used", func(t *testing.T) {
			made := s.makeCode(t, s.owner, "@coder", "Codex")
			var before connectState
			s.call(t, s.owner, "", "GET", w+"/connect-codes/"+made.ID, nil, 200, &before)
			if before.Used || before.Expired || s.connectedAt(t, "coder") != "" {
				t.Fatalf("before it is given back the code is %+v and @coder connected at %q", before, s.connectedAt(t, "coder"))
			}
			var said struct {
				Agent     struct{ Handle string }
				Workspace struct{ Name string }
				Next      string
			}
			// As a person or an agent may write it: lower case, with a dash.
			s.call(t, nil, coder, "POST", w+"/connect", M{"code": strings.ToLower(made.Code[:3] + "-" + made.Code[3:])}, 200, &said)
			if said.Agent.Handle != "@coder" || said.Workspace.Name != "Games" || !strings.Contains(said.Next, `"listen to Quadit"`) {
				t.Fatalf("the answer to the code given back is %+v", said)
			}
			if s.connectedAt(t, "coder") == "" {
				t.Fatal("the code given back did not connect @coder")
			}
			var after connectState
			s.call(t, s.owner, "", "GET", w+"/connect-codes/"+made.ID, nil, 200, &after)
			if !after.Used {
				t.Fatalf("after it was given back the code is %+v", after)
			}
			s.call(t, bea, "", "GET", w+"/connect-codes/"+made.ID, nil, 404, nil)
			if r := give(coder, made.Code, 400); r.Error.Reason != "used" {
				t.Fatalf("a used code is refused with %+v", r.Error)
			}
		})

		t.Run("a wrong code, or another agent's, is wrong", func(t *testing.T) {
			if r := give(coder, "ZZZZZZ", 400); r.Error.Reason != "wrong" || r.Error.Field != "code" {
				t.Fatalf("a wrong code is refused with %+v", r.Error)
			}
			theirs := s.makeCode(t, s.owner, "@other", "Codex")
			if r := give(coder, theirs.Code, 400); r.Error.Reason != "wrong" {
				t.Fatalf("another agent's code is refused with %+v", r.Error)
			}
			give(other, theirs.Code, 200)
		})

		t.Run("a new code for the same agent and tool replaces the open one", func(t *testing.T) {
			first := s.makeCode(t, s.owner, "@other", "Claude Code")
			elsewhere := s.makeCode(t, s.owner, "@other", "Gemini CLI")
			second := s.makeCode(t, s.owner, "@other", "Claude Code")
			if r := give(other, first.Code, 400); r.Error.Reason != "wrong" {
				t.Fatalf("a replaced code is refused with %+v", r.Error)
			}
			give(other, second.Code, 200)
			give(other, elsewhere.Code, 200)
		})

		t.Run("an expired code is refused as expired", func(t *testing.T) {
			made := s.makeCode(t, s.owner, "@other", "Cursor")
			if _, err := st.Update(context.Background(), "connect_codes", map[string]any{"expires_at": time.Now().Add(-time.Minute).UnixMilli()}, store.Eq("id", made.ID)); err != nil {
				t.Fatal(err)
			}
			var state connectState
			s.call(t, s.owner, "", "GET", w+"/connect-codes/"+made.ID, nil, 200, &state)
			if !state.Expired {
				t.Fatalf("an expired code reads %+v", state)
			}
			if r := give(other, made.Code, 400); r.Error.Reason != "expired" {
				t.Fatalf("an expired code is refused with %+v", r.Error)
			}
		})

		t.Run("a person's login is told it is not an agent's", func(t *testing.T) {
			made := s.makeCode(t, s.owner, "@coder", "Codex")
			var r refusal
			s.call(t, s.owner, "", "POST", w+"/connect", M{"code": made.Code}, 403, &r)
			if !strings.Contains(r.Error.Message, "a person's") {
				t.Fatalf("a person giving a code back is told %q", r.Error.Message)
			}
		})

		t.Run("ten tries a minute", func(t *testing.T) {
			guesser := s.agentToken(t, "guesser")
			for range 10 {
				give(guesser, "ZZZZZZ", 400)
			}
			give(guesser, "ZZZZZZ", 429)
		})
	})
}

// TestAReadDoesNotConnectAnAgent: what Connect's own sign-in does (quadit
// login reads /me) proves nothing about the tool, and leaves the agent not
// connected yet.
func TestAReadDoesNotConnectAnAgent(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		coder := s.agentToken(t, "coder")
		s.call(t, nil, coder, "GET", w+"/me", nil, 200, nil)
		s.call(t, nil, coder, "GET", w+"/my-work", nil, 200, nil)
		if at := s.connectedAt(t, "coder"); at != "" {
			t.Fatalf("reads connected @coder at %s", at)
		}
	})
}
