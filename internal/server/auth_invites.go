package server

// Registration and invitations: how a person gets an account and joins a workspace.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// emailAllowed checks an address against the allowed-domains list. When
// the list cannot be read, the error says so and no address is allowed.
func (s *Server) emailAllowed(ctx context.Context, email string) (bool, error) {
	var domains []string
	if err := s.settings.Checked(ctx, "auth.allowed_domains", &domains); err != nil {
		return false, err
	}
	if len(domains) == 0 {
		return true, nil
	}
	at := strings.LastIndex(email, "@")
	for _, d := range domains {
		if at >= 0 && strings.EqualFold(email[at+1:], strings.TrimPrefix(strings.TrimSpace(d), "@")) {
			return true, nil
		}
	}
	return false, nil
}

// newPerson makes a person's account, with a password when one is given
// (held to the password rules). The email is kept in lower case; one that
// has an account already is refused.
func (s *Server) newPerson(ctx context.Context, name, email, password string) (core.User, error) {
	var u core.User
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	if name == "" {
		return u, &engine.Error{Code: engine.CodeInvalid, Field: "name", Message: "a name is required"}
	}
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \t\n<>") {
		return u, &engine.Error{Code: engine.CodeInvalid, Field: "email", Message: "that is not an email address"}
	}
	now := time.Now().UnixMilli()
	u = core.User{ID: id.New(), Kind: core.KindPerson, Name: name, Email: email, CreatedAt: now, UpdatedAt: now}
	if password != "" {
		if err := auth.CheckPasswordRules(password); err != nil {
			return u, &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: err.Error()}
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			return u, err
		}
		u.PasswordHash = hash
	}
	if err := s.st.Insert(ctx, u); errors.Is(err, store.ErrConflict) {
		return u, &engine.Error{Code: engine.CodeConflict, Field: "email", Message: "there is already an account with this email; sign in instead"}
	} else if err != nil {
		return u, err
	}
	return u, nil
}

type registerBody struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// handleRegisterAccount makes an account when open registration is on.
func (s *Server) handleRegisterAccount(x *c) error {
	var b registerBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if open, err := s.settings.CheckedBool(ctx, "auth.registration", false); err != nil {
		return err
	} else if !open {
		return errForbidden("registration is closed on this install; ask for an invitation")
	}
	if allowed, err := s.emailAllowed(ctx, b.Email); err != nil {
		return err
	} else if !allowed {
		return errForbidden("accounts here are limited to certain email domains")
	}
	if err := s.throttle(ctx, "register:ip:"+s.clientIP(x.r), accountRequestsPerHour, time.Hour); err != nil {
		return err
	}
	if b.Password == "" {
		return &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: "a password is required"}
	}
	u, err := s.newPerson(ctx, b.Name, b.Email, b.Password)
	if err != nil {
		return err
	}
	s.audit(x.r, "", u, "account.registered", "user", u.ID, nil)
	if err := s.startSession(x, u, core.SessionFull); err != nil {
		return err
	}
	return x.json(201, map[string]any{"user": u})
}

type inviteBody struct {
	Email       string `json:"email"`
	Role        string `json:"role"`
	ExpiresDays int    `json:"expires_days"`
	MaxUses     int    `json:"max_uses"`
	// Approval is an approved decision for the member.add the invitation
	// stands for, from one who must get approval to add people.
	Approval string `json:"approval"`
}

// handleCreateInvite makes an invitation: a link that lets someone join this
// workspace with a role. With an email it is for that address only and is
// mailed when the install can send mail.
//
// An invitation adds a member, so it is allowed exactly as member.add is
// (engine.Permit): the role, a credential or membership that may only read,
// the approval the caller may need, whose arguments are {"user": email,
// "role": role}, or {"role": role} for a link for anyone. A caller who
// reaches only some projects admits the new member to those alone, and
// cannot invite an owner.
func (s *Server) handleCreateInvite(x *c) error {
	var b inviteBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	role := core.Role(b.Role)
	if b.Role == "" {
		role = core.RoleMember
	}
	if !role.AtLeast(core.RoleMember) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "role", Message: "unknown role " + b.Role, Allowed: []string{"member", "admin", "owner"}}
	}
	if !x.member.Role.AtLeast(role) {
		return errForbidden("you are a %s and cannot invite a %s", x.member.Role, role)
	}
	if b.ExpiresDays <= 0 {
		b.ExpiresDays = 7
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if b.MaxUses <= 0 || email != "" {
		b.MaxUses = 1
	}
	adds := map[string]any{"role": string(role)}
	if email != "" {
		adds["user"] = email
	}
	reach, err := s.eng.Permit(ctx, x.ws.ID, x.actor, engine.Change{Type: "member.add", Args: plainjson.Marshal(adds), Approval: b.Approval})
	if err != nil {
		return err
	}
	var limit *core.Scope
	if len(reach.Projects) > 0 {
		if role == core.RoleOwner {
			return errForbidden("you reach only some projects here, so you cannot invite an owner, who reaches them all")
		}
		limit = &core.Scope{Projects: reach.Projects}
	}
	token := auth.Random(24)
	now := time.Now()
	inv := core.Invite{ID: id.New(), WorkspaceID: x.ws.ID, Email: email, Role: role, Scope: limit, TokenHash: auth.Hash(token), CreatedBy: x.member.UserID,
		CreatedAt: now.UnixMilli(), ExpiresAt: now.AddDate(0, 0, b.ExpiresDays).UnixMilli(), MaxUses: b.MaxUses}
	if err := s.st.Insert(ctx, inv); err != nil {
		return err
	}
	link := s.cfg.BaseURL + "/invite/" + token
	mailed := false
	if email != "" && s.mailReady(ctx) {
		err := s.sendMail(ctx, email, x.member.Name+" invited you to "+x.ws.Name,
			x.member.Name+" invited you to join "+x.ws.Name+" as "+string(role)+".\n\nOpen this link to accept:\n"+link+
				fmt.Sprintf("\n\nThe invitation is good for %d days.", b.ExpiresDays))
		mailed = err == nil
		if err != nil {
			s.log.Error("invite mail", "err", err)
		}
	}
	s.audit(x.r, x.ws.ID, x.user, "invite.created", "invite", inv.ID, map[string]string{"email": email, "role": string(role)})
	return x.json(201, map[string]any{"invite": inv, "link": link, "mailed": mailed})
}

func (s *Server) handleListInvites(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	var list []core.Invite
	if err := s.st.List(x.ctx(), &list, store.Q{Where: []store.Cond{store.Eq("workspace_id", x.ws.ID), store.Null("revoked_at"),
		store.Gt("expires_at", time.Now().UnixMilli())}, Order: "-created_at"}); err != nil {
		return err
	}
	list = keep(list, func(i core.Invite) bool { return i.Uses < i.MaxUses })
	return x.ok(map[string]any{"invites": list})
}

func (s *Server) handleRevokeInvite(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	if err := x.mayWrite(); err != nil {
		return err
	}
	n, err := s.st.Update(x.ctx(), "invites", map[string]any{"revoked_at": time.Now().UnixMilli()},
		store.Eq("id", x.r.PathValue("id")), store.Eq("workspace_id", x.ws.ID))
	if err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("invitation")
	}
	s.audit(x.r, x.ws.ID, x.user, "invite.revoked", "invite", x.r.PathValue("id"), nil)
	return x.ok(map[string]any{"ok": true})
}

// invite finds the invitation a link's token is for, and its workspace. An
// invitation that is revoked, spent, expired or for a workspace that is gone
// is the engine's not-found error.
func (s *Server) invite(ctx context.Context, token string) (core.Invite, core.Workspace, error) {
	var inv core.Invite
	var ws core.Workspace
	gone := &engine.Error{Code: engine.CodeNotFound, Message: "this invitation is no longer valid; ask for a new one"}
	there, err := store.Find(ctx, s.st, &inv, store.Eq("token_hash", auth.Hash(token)), store.Null("revoked_at"))
	if err != nil {
		return inv, ws, err
	}
	if !there || inv.ExpiresAt < time.Now().UnixMilli() || inv.Uses >= inv.MaxUses {
		return inv, ws, gone
	}
	if there, err = store.Find(ctx, s.st, &ws, store.Eq("id", inv.WorkspaceID), store.Live); err != nil {
		return inv, ws, err
	}
	if !there {
		return inv, ws, gone
	}
	return inv, ws, nil
}

// handleShowInvite says what an invitation is for, before anyone signs in.
func (s *Server) handleShowInvite(x *c) error {
	inv, ws, err := s.invite(x.ctx(), x.r.PathValue("token"))
	if err != nil {
		return err
	}
	// An inviter whose account is gone leaves the name blank.
	var inviter core.User
	if _, err := store.Find(x.ctx(), s.st, &inviter, store.Eq("id", inv.CreatedBy)); err != nil {
		return err
	}
	out := map[string]any{"workspace": map[string]string{"name": ws.Name, "slug": ws.Slug}, "role": inv.Role, "email": inv.Email, "invited_by": inviter.Name}
	if inv.Email != "" {
		var u core.User
		hasAccount, err := store.Find(x.ctx(), s.st, &u, store.Eq("email", inv.Email), store.Live)
		if err != nil {
			return err
		}
		out["has_account"] = hasAccount
	}
	return x.ok(out)
}

// newInvitedPerson makes the account of someone accepting an invitation
// without one, from the name and password sent along, and signs them in.
func (s *Server) newInvitedPerson(x *c, inv core.Invite, b registerBody) (core.User, error) {
	email := b.Email
	if inv.Email != "" {
		email = inv.Email
	}
	if allowed, err := s.emailAllowed(x.ctx(), email); err != nil {
		return core.User{}, err
	} else if !allowed {
		return core.User{}, errForbidden("accounts here are limited to certain email domains")
	}
	if b.Password == "" {
		return core.User{}, &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: "choose a password, or sign in first if you have an account"}
	}
	u, err := s.newPerson(x.ctx(), b.Name, email, b.Password)
	if err != nil {
		return u, err
	}
	return u, s.startSession(x, u, core.SessionFull)
}

// handleAcceptInvite joins the workspace: as the person signed in, or as a new
// account made from the name and password sent along.
func (s *Server) handleAcceptInvite(x *c) error {
	var b registerBody
	if x.r.ContentLength != 0 {
		if err := x.body(&b); err != nil {
			return err
		}
	}
	ctx := x.ctx()
	inv, ws, err := s.invite(ctx, x.r.PathValue("token"))
	if err != nil {
		return err
	}
	var u core.User
	if s.identify(x.ctx(), x) == nil && x.user.Kind == core.KindPerson {
		u = x.user
	} else if u, err = s.newInvitedPerson(x, inv, b); err != nil {
		return err
	}
	if inv.Email != "" && !strings.EqualFold(inv.Email, u.Email) {
		return errForbidden("this invitation is for %s; you are signed in as %s", inv.Email, u.Email)
	}
	if n, err := s.st.Count(ctx, "members", store.Eq("workspace_id", ws.ID), store.Eq("user_id", u.ID), store.Null("removed_at")); err != nil {
		return err
	} else if n > 0 {
		return x.ok(map[string]any{"workspace": ws, "already_member": true})
	}
	if err := s.inviterStillMay(ctx, inv); err != nil {
		return err
	}
	// Count the use first, so a link good for one person admits one.
	n, err := s.st.Incr(ctx, "invites", "uses", 1, store.Eq("id", inv.ID))
	if err != nil || int(n) > inv.MaxUses {
		return &engine.Error{Code: engine.CodeNotFound, Message: "this invitation was already used"}
	}
	adds := map[string]any{"user": u.ID, "role": string(inv.Role)}
	if inv.Scope != nil {
		adds["scope"] = map[string]any{"projects": inv.Scope.Projects}
	}
	err = s.eng.System(ctx, ws.ID, inv.CreatedBy, func(sys *engine.Sys) error {
		return sys.Do("member.add", adds)
	})
	if err != nil {
		return err
	}
	s.audit(x.r, ws.ID, u, "invite.accepted", "invite", inv.ID, nil)
	return x.ok(map[string]any{"workspace": ws, "user": u})
}

// inviterStillMay refuses an invitation whose maker could not make it now:
// gone from the workspace, suspended, or of a role below the one it gives.
// The member it adds is added as the engine itself, on the strength of the
// invitation, so the maker's standing is what admits them.
func (s *Server) inviterStillMay(ctx context.Context, inv core.Invite) error {
	var m core.Member
	there, err := store.Find(ctx, s.st.In(inv.WorkspaceID), &m, store.Eq("user_id", inv.CreatedBy), store.Null("removed_at"))
	if err != nil {
		return err
	}
	if !there || m.SuspendedAt != 0 || !m.Role.AtLeast(core.RoleAdmin) || !m.Role.AtLeast(inv.Role) {
		return &engine.Error{Code: engine.CodeNotFound, Message: "this invitation is no longer valid; ask for a new one"}
	}
	return nil
}
