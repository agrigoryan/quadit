package server

// API tokens: making, listing and revoking them.

import (
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
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
	rs := x.resolver()
	if b.User == "" {
		b.User = "me"
	}
	m, err := rs.Member("user", b.User)
	if err != nil {
		return err
	}
	if m.UserID != x.member.UserID {
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
		// An agent hands out no more than it has itself: not a higher role,
		// not projects beyond its own.
		if x.member.Kind == core.KindAgent {
			if m.Role != x.member.Role && m.Role.AtLeast(x.member.Role) {
				return errForbidden("an agent cannot make a token for an agent with a higher role than its own")
			}
			if mine := x.member.Scope; mine != nil {
				theirs := m.Scope
				if theirs == nil {
					theirs = &core.Scope{}
				}
				if mine.ReadOnly && !theirs.ReadOnly {
					return errForbidden("an agent that may only read cannot make a token for one that may write")
				}
				if len(mine.Projects) > 0 {
					if len(theirs.Projects) == 0 {
						return errForbidden("@%s works in every project and you do not; you cannot make a token for it", m.Handle)
					}
					for _, p := range theirs.Projects {
						if !has(mine.Projects, p) {
							return errForbidden("@%s works in projects you do not; you cannot make a token for it", m.Handle)
						}
					}
				}
			}
		}
	} else if x.member.Kind == core.KindAgent && x.token != nil {
		return errForbidden("an agent cannot issue itself more tokens; ask an admin")
	}
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
			return err
		}
		if x.token != nil {
			return errForbidden("a token for secrets is made by a signed-in admin, not with another token")
		}
		scopes = append(scopes, "secrets")
	}
	for _, ref := range b.Projects {
		p, err := rs.Project(ref)
		if err != nil {
			return err
		}
		if x.token != nil && len(x.actor.Projects) > 0 && !has(x.actor.Projects, p.ID) {
			return errForbidden("this token does not reach project %s, so it cannot make one that does", p.Key)
		}
		scopes = append(scopes, "project:"+p.ID)
	}
	token, prefix := auth.NewAPIToken()
	now := time.Now()
	t := core.APIToken{ID: id.New(), WorkspaceID: x.ws.ID, UserID: m.UserID, Name: strings.TrimSpace(b.Name), TokenHash: auth.Hash(token), Prefix: prefix,
		Scopes: strings.Join(scopes, " "), Kind: "token", CreatedBy: x.member.UserID, CreatedAt: now.UnixMilli()}
	if t.Name == "" {
		t.Name = "token " + now.UTC().Format("2006-01-02")
	}
	if b.ExpiresDays > 0 {
		t.ExpiresAt = now.AddDate(0, 0, b.ExpiresDays).UnixMilli()
	}
	if err := x.db.Insert(x.ctx(), t); err != nil {
		return err
	}
	s.audit(x.r, x.ws.ID, x.user, "token.created", "token", t.ID, map[string]string{"for": m.Handle, "scopes": t.Scopes})
	return x.json(201, map[string]any{"token": token, "info": t, "note": "this is the only time the token is shown"})
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
	var t core.APIToken
	if err := x.db.Get(x.ctx(), &t, store.Eq("id", x.r.PathValue("id")), store.Null("revoked_at")); err != nil {
		return errNotFound("token")
	}
	if t.UserID != x.member.UserID {
		if err := x.admin(); err != nil {
			return err
		}
	}
	if _, err := x.db.Update(x.ctx(), "api_tokens", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("id", t.ID)); err != nil {
		return err
	}
	s.accessChanged()
	s.audit(x.r, x.ws.ID, x.user, "token.revoked", "token", t.ID, nil)
	return x.ok(map[string]any{"ok": true})
}
