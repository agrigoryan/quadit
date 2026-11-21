// Connect codes: a person makes one for an agent and a tool, the agent gives
// it back from inside that tool (quadit connect CODE), and so proves that it
// reached Quadit from there.

package server

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// connectRoutes are the routes of connect codes.
func (s *Server) connectRoutes() []route {
	const w = "/api/v1/w/{ws}"
	return []route{
		{"POST " + w + "/connect-codes", s.workspaceMember(s.handleCreateConnectCode), "Make a connect code for an agent and the tool it runs in. Body: {agent, tool}: the agent's id or @handle, the tool's name (\"Codex\"). Answers 201 with {id, code, agent, tool, expires_at}; the code is in the answer once. Six characters, good once for seven days; a new code for the same agent and tool replaces the open one. Made by a person who may make the agent a token.", "", "admin"},
		{"GET " + w + "/connect-codes/{id}", s.workspaceMember(s.handleShowConnectCode), "Whether a connect code was used: {id, agent, tool, created_at, expires_at, used_at, used, expired}. Only its maker reads it.", "", "admin"},
		{"POST " + w + "/connect", s.workspaceMember(s.handleConnectAgent), "An agent gives back the connect code a person made for it, with its own login, and is connected. Body: {code}. Answers {agent: {user_id, handle, name}, workspace: {id, slug, name}, tool, next}: next is what to tell the person. A wrong, used or expired code is refused, saying which (reason: wrong, used, expired); ten attempts a minute per agent.", "", "orient"},
	}
}

// Connect codes are codeLength characters of codeAlphabet, which leaves out
// the characters read as one another (0 and O, 1, I and L), and are good
// for codeLife.
const (
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLength   = 6
	codeLife     = 7 * 24 * time.Hour
	// connectTries is how many codes an agent may give back in a minute.
	connectTries = 10
)

// Why a code given back was refused (engine.Error.Reason).
const (
	reasonCodeWrong   = "wrong"
	reasonCodeUsed    = "used"
	reasonCodeExpired = "expired"
)

// randomCode is n random characters of codeAlphabet.
func randomCode(n int) string {
	var b strings.Builder
	limit := big.NewInt(int64(len(codeAlphabet)))
	for range n {
		i, err := rand.Int(rand.Reader, limit)
		if err != nil {
			panic(err) // the system has no randomness: nothing safe can be done
		}
		b.WriteByte(codeAlphabet[i.Int64()])
	}
	return b.String()
}

// normalCode is a code as it is kept: upper case, without the spaces or
// dashes a person or an agent may have put in it.
func normalCode(code string) string {
	return strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(strings.TrimSpace(code)))
}

// handleCreateConnectCode makes a code for an agent and a tool, taking away
// the open code of the same agent and tool (its name in any case), and
// every code of the agent that ran out, in the same write: two made at once
// leave one open code, and a code that cannot be made leaves the one before
// it.
func (s *Server) handleCreateConnectCode(x *c) error {
	var b struct {
		Agent string `json:"agent"`
		Tool  string `json:"tool"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	tool := strings.TrimSpace(b.Tool)
	if tool == "" || len(tool) > 64 {
		return &engine.Error{Code: engine.CodeInvalid, Field: "tool", Message: "name the tool the agent runs in (\"Codex\"), in at most 64 characters"}
	}
	if x.actor.ReadOnly {
		return errForbidden("this credential is read-only")
	}
	if x.member.Kind == core.KindAgent {
		return errForbidden("a connect code is made by a person, for the agent to give back")
	}
	agent, err := x.resolver(x.ctx()).Member("agent", b.Agent)
	if err != nil {
		return err
	}
	if agent.Kind != core.KindAgent {
		return &engine.Error{Code: engine.CodeInvalid, Field: "agent", Message: "@" + agent.Handle + " is a person; a connect code is for an agent"}
	}
	if err := mayMakeTokenFor(x, agent); err != nil {
		return err
	}
	now := time.Now()
	code := randomCode(codeLength)
	row := core.ConnectCode{ID: id.New(), WorkspaceID: x.ws.ID, AgentID: agent.UserID, Tool: tool, CodeHash: auth.Hash(code), CreatedBy: x.member.UserID,
		CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(codeLife).UnixMilli()}
	err = s.st.Write(x.ctx(), x.ws.ID, func(tx store.Tx) error {
		// The same tool, however its name is written ("codex", "Codex").
		var open []core.ConnectCode
		if err := tx.List(x.ctx(), &open, store.Where(store.Eq("agent_id", agent.UserID), store.Null("used_at"))); err != nil {
			return err
		}
		for _, code := range open {
			if strings.EqualFold(code.Tool, tool) {
				if _, err := tx.Delete(x.ctx(), "connect_codes", store.Eq("id", code.ID)); err != nil {
					return err
				}
			}
		}
		if _, err := tx.Delete(x.ctx(), "connect_codes", store.Eq("agent_id", agent.UserID), store.Lt("expires_at", now.UnixMilli())); err != nil {
			return err
		}
		return tx.Insert(x.ctx(), row)
	})
	if err != nil {
		return err
	}
	return x.json(201, map[string]any{"id": row.ID, "code": code, "agent": agent.UserID, "tool": tool, "expires_at": row.ExpiresAt})
}

// handleShowConnectCode says whether a code was used, to the one who made
// it; to anyone else it is not there.
func (s *Server) handleShowConnectCode(x *c) error {
	var row core.ConnectCode
	there, err := store.Find(x.ctx(), x.db, &row, store.Eq("id", x.r.PathValue("id")), store.Eq("created_by", x.member.UserID))
	if err != nil {
		return err
	}
	if !there {
		return errNotFound("connect code")
	}
	return x.ok(map[string]any{"id": row.ID, "agent": row.AgentID, "tool": row.Tool, "created_at": row.CreatedAt, "expires_at": row.ExpiresAt,
		"used_at": row.UsedAt, "used": row.UsedAt != 0, "expired": row.UsedAt == 0 && row.ExpiresAt <= time.Now().UnixMilli()})
}

// handleConnectAgent takes a code back from the agent it was made for: one
// that is open, has not run out and is the calling agent's is used up, and
// the agent is connected, in one write that finds and checks the code too.
// Every attempt counts toward the agent's limit, so codes cannot be guessed.
func (s *Server) handleConnectAgent(x *c) error {
	var b struct {
		Code string `json:"code"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	if x.member.Kind != core.KindAgent {
		return errForbidden("this login is @%s's, a person's: a connect code is given back by the agent it was made for, with the agent's own login", x.member.Handle)
	}
	if err := s.throttle(x.ctx(), "connect:"+x.member.UserID, connectTries, time.Minute); err != nil {
		return err
	}
	code := normalCode(b.Code)
	refuse := func(reason, format string, a ...any) error {
		return &engine.Error{Code: engine.CodeInvalid, Field: "code", Reason: reason, Message: fmt.Sprintf(format, a...)}
	}
	var row core.ConnectCode
	err := s.eng.System(x.ctx(), x.ws.ID, x.member.UserID, func(sys *engine.Sys) error {
		there, err := store.Find(x.ctx(), sys.Tx(), &row, store.Eq("agent_id", x.member.UserID), store.Eq("code_hash", auth.Hash(code)))
		if err != nil {
			return err
		}
		now := time.Now()
		switch {
		case !there:
			return refuse(reasonCodeWrong, "%q is not a connect code made for @%s; check it, or ask the person for a new one", code, x.member.Handle)
		case row.UsedAt != 0:
			return refuse(reasonCodeUsed, "connect code %s was already used; ask the person for a new one", code)
		case row.ExpiresAt <= now.UnixMilli():
			return refuse(reasonCodeExpired, "connect code %s ran out on %s; ask the person for a new one", code, formatTime(row.ExpiresAt))
		}
		if _, err := sys.Tx().Update(x.ctx(), "connect_codes", map[string]any{"used_at": now.UnixMilli()}, store.Eq("id", row.ID)); err != nil {
			return err
		}
		return sys.Connected()
	})
	if err != nil {
		return err
	}
	s.audit(x.r, x.ws.ID, x.user, "agent.connected", "member", x.member.UserID, map[string]string{"tool": row.Tool})
	return x.ok(map[string]any{
		"agent":     map[string]any{"user_id": x.member.UserID, "handle": "@" + x.member.Handle, "name": x.member.Name},
		"workspace": map[string]any{"id": x.ws.ID, "slug": x.ws.Slug, "name": x.ws.Name},
		"tool":      row.Tool,
		"next":      `Tell the person it is connected, and offer: say "listen to Quadit" and I will answer what comes in while this run stays active.`,
	})
}
