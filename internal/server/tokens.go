package server

// API tokens: making, listing and revoking them.

import (
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

type tokenBody struct {
	User        string   `json:"user"` // an agent's @handle, or "me"
	Name        string   `json:"name"`
	ReadOnly    bool     `json:"read_only"`
	Projects    []string `json:"projects"` // keys; empty = every project the member may use
	ExpiresDays int      `json:"expires_days"`
	// Secrets makes a token for a companion: it may receive the secrets
	// marked for use in an environment. Admins only.
	Secrets bool `json:"secrets"`
}

// handleCreateToken issues a token for an agent (admins) or for oneself. The
// token is in the answer and nowhere else afterwards.
func (s *Server) handleCreateToken(x *c) error {
	var b tokenBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.actor.ReadOnly {
		return errForbidden("this credential is read-only")
	}
	resolver := x.resolver()
	if b.User == "" {
		b.User = "me"
	}
	m, err := resolver.Member("user", b.User)
	if err != nil {
		return err
	}
	if err := mayMakeTokenFor(x, m); err != nil {
		return err
	}
	scopes, err := tokenScopes(x, resolver, b)
	if err != nil {
		return err
	}
	token, prefix := auth.NewAPIToken()
	now := time.Now()
	info := core.APIToken{ID: id.New(), WorkspaceID: x.ws.ID, UserID: m.UserID, Name: strings.TrimSpace(b.Name), TokenHash: auth.Hash(token), Prefix: prefix,
		Scopes: strings.Join(scopes, " "), Kind: core.TokenAPI, CreatedBy: x.member.UserID, CreatedAt: now.UnixMilli()}
	if info.Name == "" {
		info.Name = "token " + now.UTC().Format(time.DateOnly)
	}
	if b.ExpiresDays > 0 {
		info.ExpiresAt = now.AddDate(0, 0, b.ExpiresDays).UnixMilli()
	}
	if err := x.db.Insert(x.ctx(), info); err != nil {
		return err
	}
	s.audit(x.r, x.ws.ID, x.user, "token.created", "token", info.ID, map[string]string{"for": m.Handle, "scopes": info.Scopes})
	return x.json(201, map[string]any{"token": token, "info": info, "note": "this is the only time the token is shown"})
}

// mayMakeTokenFor refuses a token the caller may not make for member m.
func mayMakeTokenFor(x *c, m core.Member) error {
	if m.UserID == x.member.UserID {
		if x.member.Kind == core.KindAgent && x.token != nil {
			return errForbidden("an agent cannot issue itself more tokens; ask an admin")
		}
		return nil
	}
	// An admin makes tokens for agents; anyone makes them for a
	// sub-agent they made themselves.
	if m.DelegatedBy != x.member.UserID {
		if err := x.admin(); err != nil {
			return err
		}
	}
	if m.Kind != core.KindAgent {
		return errForbidden("a person's tokens are made by that person")
	}
	if x.member.Kind == core.KindAgent {
		return agentMayHandOut(x.member, m)
	}
	return nil
}

// agentMayHandOut refuses a token an agent would make for another agent
// that could do more than the agent itself: an agent hands out no more than
// it has, not a higher role, not projects beyond its own.
func agentMayHandOut(agent, m core.Member) error {
	if m.Role != agent.Role && m.Role.AtLeast(agent.Role) {
		return errForbidden("an agent cannot make a token for an agent with a higher role than its own")
	}
	mine := agent.Scope
	if mine == nil {
		return nil
	}
	theirs := m.Scope
	if theirs == nil {
		theirs = &core.Scope{}
	}
	if mine.ReadOnly && !theirs.ReadOnly {
		return errForbidden("an agent that may only read cannot make a token for one that may write")
	}
	if len(mine.Projects) == 0 {
		return nil
	}
	if len(theirs.Projects) == 0 {
		return errForbidden("@%s works in every project and you do not; you cannot make a token for it", m.Handle)
	}
	for _, p := range theirs.Projects {
		if !slices.Contains(mine.Projects, p) {
			return errForbidden("@%s works in projects you do not; you cannot make a token for it", m.Handle)
		}
	}
	return nil
}

// tokenScopes lists what a new token may do: read only, limited to
// projects, given secrets. A token made with a token keeps its limits.
func tokenScopes(x *c, resolver *engine.Resolver, b tokenBody) ([]string, error) {
	var scopes []string
	if b.ReadOnly || x.actor.ReadOnly {
		scopes = append(scopes, "read")
	}
	// A token made with a token limited to some projects keeps that limit.
	if len(b.Projects) == 0 && x.token != nil {
		for _, p := range x.actor.Projects {
			scopes = append(scopes, "project:"+p)
		}
	}
	if b.Secrets {
		if err := x.admin(); err != nil {
			return nil, err
		}
		if x.token != nil {
			return nil, errForbidden("a token for secrets is made by a signed-in admin, not with another token")
		}
		scopes = append(scopes, "secrets")
	}
	for _, ref := range b.Projects {
		p, err := resolver.Project(ref)
		if err != nil {
			return nil, err
		}
		if x.token != nil && len(x.actor.Projects) > 0 && !slices.Contains(x.actor.Projects, p.ID) {
			return nil, errForbidden("this token does not reach project %s, so it cannot make one that does", p.Key)
		}
		scopes = append(scopes, "project:"+p.ID)
	}
	return scopes, nil
}

func (s *Server) handleListTokens(x *c) error {
	conds := []store.Cond{store.Null("revoked_at")}
	if !x.member.Role.AtLeast(core.RoleAdmin) {
		conds = append(conds, store.Eq("user_id", x.member.UserID))
	}
	var ts []core.APIToken
	if err := x.db.List(x.ctx(), &ts, store.Q{Where: conds, Order: "-created_at"}); err != nil {
		return err
	}
	return x.ok(map[string]any{"tokens": ts})
}

// handleRevokeToken ends a token at once.
func (s *Server) handleRevokeToken(x *c) error {
	var token core.APIToken
	if err := x.db.Get(x.ctx(), &token, store.Eq("id", x.r.PathValue("id")), store.Null("revoked_at")); err != nil {
		return err
	}
	if token.UserID != x.member.UserID {
		if err := x.admin(); err != nil {
			return err
		}
	}
	if _, err := x.db.Update(x.ctx(), "api_tokens", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("id", token.ID)); err != nil {
		return err
	}
	s.accessChanged()
	s.audit(x.r, x.ws.ID, x.user, "token.revoked", "token", token.ID, nil)
	return x.ok(map[string]any{"ok": true})
}
