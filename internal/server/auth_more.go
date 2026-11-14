package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/auth/second-step", s.half(s.hSecondStep))
		m.HandleFunc("POST /api/v1/auth/totp/start", s.signed(s.hTOTPStart))
		m.HandleFunc("POST /api/v1/auth/totp/enable", s.signed(s.hTOTPEnable))
		m.HandleFunc("POST /api/v1/auth/totp/disable", s.signed(s.hTOTPDisable))
		m.HandleFunc("POST /api/v1/auth/recovery-codes", s.signed(s.hRecoveryCodes))
		m.HandleFunc("POST /api/v1/auth/reset/request", s.open(s.hResetRequest))
		m.HandleFunc("POST /api/v1/auth/reset/confirm", s.open(s.hResetConfirm))
		m.HandleFunc("POST /api/v1/auth/register", s.open(s.hRegister))
		m.HandleFunc("GET /api/v1/auth/invite/{token}", s.open(s.hInviteShow))
		m.HandleFunc("POST /api/v1/auth/invite/{token}", s.open(s.hInviteAccept))
		const w = "/api/v1/w/{ws}"
		m.HandleFunc("GET "+w+"/invites", s.in(s.hInvites))
		m.HandleFunc("POST "+w+"/invites", s.in(s.hInviteCreate))
		m.HandleFunc("DELETE "+w+"/invites/{id}", s.in(s.hInviteRevoke))
	})
}

// oneTime makes a short-lived secret and stores its hash with some data.
func (s *Server) oneTime(ctx context.Context, kind, userID string, data any, life time.Duration) (string, error) {
	token := auth.Random(32)
	now := time.Now()
	ot := core.OneTimeToken{ID: id.New(), Kind: kind, TokenHash: auth.Hash(token), UserID: userID, CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(life).UnixMilli()}
	if data != nil {
		ot.Data, _ = json.Marshal(data)
	}
	return token, s.st.Insert(ctx, ot)
}

// useOneTime spends a one-time secret. It works once and only while fresh.
func (s *Server) useOneTime(ctx context.Context, kind, token string, keep bool) (core.OneTimeToken, error) {
	var ot core.OneTimeToken
	err := s.st.Get(ctx, &ot, store.Eq("token_hash", auth.Hash(token)), store.Eq("kind", kind), store.Null("used_at"))
	if err != nil || ot.ExpiresAt < time.Now().UnixMilli() {
		return ot, &engine.Error{Code: engine.CodeNotFound, Message: "this link is no longer valid; ask for a new one"}
	}
	if !keep {
		n, err := s.st.Update(ctx, "one_time_tokens", map[string]any{"used_at": time.Now().UnixMilli()}, store.Eq("id", ot.ID), store.Null("used_at"))
		if err != nil || n != 1 {
			return ot, &engine.Error{Code: engine.CodeNotFound, Message: "this link was already used"}
		}
	}
	return ot, nil
}

// ---- two-step verification ----

// checkSecond accepts an authenticator code or a recovery code.
func (s *Server) checkSecond(ctx context.Context, u core.User, code string) bool {
	code = strings.TrimSpace(code)
	if u.TOTPSecret == "" || code == "" {
		return false
	}
	secret, err := s.sealer.Open(u.TOTPSecret)
	if err != nil {
		return false
	}
	if step, ok := auth.CheckTOTP(secret, code, time.Now()); ok {
		// A code works once: remember the step it was used in.
		mark := core.OneTimeToken{ID: id.New(), Kind: "totp_used", TokenHash: auth.Hash(fmt.Sprintf("totp:%s:%d", u.ID, step)), UserID: u.ID,
			CreatedAt: time.Now().UnixMilli(), ExpiresAt: time.Now().Add(5 * time.Minute).UnixMilli()}
		return s.st.Insert(ctx, mark) == nil
	}
	n, err := s.st.Update(ctx, "recovery_codes", map[string]any{"used_at": time.Now().UnixMilli()},
		store.Eq("user_id", u.ID), store.Eq("code_hash", auth.Hash(strings.ToLower(code))), store.Null("used_at"))
	return err == nil && n == 1
}

type codeBody struct {
	Code     string `json:"code"`
	Password string `json:"password"`
}

// hSecondStep finishes a sign-in that is waiting for its second step.
func (s *Server) hSecondStep(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.sess == nil || x.sess.Stage == "full" {
		return x.ok(map[string]any{"user": x.user})
	}
	ctx := x.ctx()
	if err := s.throttle(ctx, "mfa:"+x.user.ID, 8, 15*time.Minute); err != nil {
		return err
	}
	if !s.checkSecond(ctx, x.user, b.Code) {
		s.audit(x.r, "", x.user, "signin.second_step_failed", "user", x.user.ID, nil)
		return errUnauthorized("that code is not right; codes change every 30 seconds")
	}
	if _, err := s.st.Update(ctx, "sessions", map[string]any{"stage": "full"}, store.Eq("id", x.sess.ID)); err != nil {
		return err
	}
	s.audit(x.r, "", x.user, "signin", "user", x.user.ID, map[string]string{"method": "password+code"})
	return x.ok(map[string]any{"user": x.user})
}

// hTOTPStart makes a new secret for the person to add to their app. It is
// not in force until they prove the app works with hTOTPEnable.
func (s *Server) hTOTPStart(x *c) error {
	if x.sess == nil {
		return errForbidden("two-step verification is set up by its person, signed in")
	}
	if x.user.TOTPAt != 0 {
		return &engine.Error{Code: engine.CodeConflict, Message: "two-step verification is already on; turn it off first to set up a new app"}
	}
	secret := auth.NewTOTPSecret()
	sealed, err := s.sealer.Seal(secret)
	if err != nil {
		return err
	}
	if _, err := s.st.Update(x.ctx(), "users", map[string]any{"totp_secret": sealed}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	issuer := s.settingStr(x.ctx(), "install.name", "Quadit")
	return x.ok(map[string]any{"secret": secret, "url": auth.TOTPURL(issuer, x.user.Email, secret)})
}

func (s *Server) newRecoveryCodes(ctx context.Context, userID string) ([]string, error) {
	codes := auth.NewRecoveryCodes()
	err := s.st.Atomic(ctx, func(db store.DB) error {
		if _, err := db.Delete(ctx, "recovery_codes", store.Eq("user_id", userID)); err != nil {
			return err
		}
		for _, code := range codes {
			if err := db.Insert(ctx, core.RecoveryCode{ID: id.New(), UserID: userID, CodeHash: auth.Hash(code), CreatedAt: time.Now().UnixMilli()}); err != nil {
				return err
			}
		}
		return nil
	})
	return codes, err
}

// hTOTPEnable turns two-step verification on once a code from the app
// checks out, and returns the recovery codes, shown this once.
func (s *Server) hTOTPEnable(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if x.sess == nil || x.user.TOTPSecret == "" || x.user.TOTPAt != 0 {
		return errBad("start the setup first")
	}
	secret, err := s.sealer.Open(x.user.TOTPSecret)
	if err != nil {
		return err
	}
	if _, ok := auth.CheckTOTP(secret, b.Code, time.Now()); !ok {
		return errBad("that code is not right; check the time on your phone and try the next code")
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"totp_at": time.Now().UnixMilli()}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	codes, err := s.newRecoveryCodes(ctx, x.user.ID)
	if err != nil {
		return err
	}
	s.audit(x.r, "", x.user, "second_step.enabled", "user", x.user.ID, nil)
	return x.ok(map[string]any{"recovery_codes": codes})
}

func (s *Server) hTOTPDisable(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if x.sess == nil {
		return errForbidden("two-step verification is changed by its person, signed in")
	}
	if !s.checkSecond(ctx, x.user, b.Code) && !(x.user.PasswordHash != "" && auth.CheckPassword(x.user.PasswordHash, b.Password)) {
		return errForbidden("confirm with a current code or your password")
	}
	if s.settingBool(ctx, "auth.require_2fa", false) {
		if n, _ := s.st.Count(ctx, "passkeys", store.Eq("user_id", x.user.ID)); n == 0 {
			return errForbidden("this install requires two-step verification; add a passkey before turning codes off")
		}
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"totp_at": 0, "totp_secret": ""}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	s.st.Delete(ctx, "recovery_codes", store.Eq("user_id", x.user.ID))
	s.audit(x.r, "", x.user, "second_step.disabled", "user", x.user.ID, nil)
	return x.ok(map[string]any{"ok": true})
}

// hRecoveryCodes replaces the recovery codes with ten new ones.
func (s *Server) hRecoveryCodes(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.sess == nil || x.user.TOTPAt == 0 {
		return errBad("two-step verification is not on")
	}
	if !s.checkSecond(x.ctx(), x.user, b.Code) {
		return errForbidden("confirm with a current code")
	}
	codes, err := s.newRecoveryCodes(x.ctx(), x.user.ID)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"recovery_codes": codes})
}

// ---- password reset ----

type resetRequestBody struct {
	Email string `json:"email"`
}

// hResetRequest mails a reset link. The answer is the same whether or not
// the address has an account, so it tells an outsider nothing.
func (s *Server) hResetRequest(x *c) error {
	var b resetRequestBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if err := s.throttle(ctx, "reset:ip:"+clientIP(x.r), 10, time.Hour); err != nil {
		return err
	}
	if !s.mailReady(ctx) {
		return &httpError{Status: 409, Code: "no_mail", Message: "this install has no mail server; ask whoever runs it to reset your password with: quadit admin reset-password <email>"}
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	var u core.User
	if err := s.st.Get(ctx, &u, store.Eq("email", email), store.Live); err == nil && u.Kind == core.KindPerson && u.DisabledAt == 0 {
		token, err := s.oneTime(ctx, "reset", u.ID, nil, time.Hour)
		if err != nil {
			return err
		}
		link := s.cfg.BaseURL + "/reset/" + token
		go func() {
			if err := s.sendMail(context.Background(), u.Email, "Reset your password",
				"Someone asked to reset the password for this address.\n\nOpen this link within an hour to choose a new one:\n"+link+
					"\n\nIf it was not you, ignore this message; nothing has changed."); err != nil {
				s.log.Error("reset mail", "err", err)
			}
		}()
		s.audit(x.r, "", u, "password.reset_requested", "user", u.ID, nil)
	}
	return x.ok(map[string]any{"ok": true})
}

type resetConfirmBody struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (s *Server) hResetConfirm(x *c) error {
	var b resetConfirmBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if err := auth.CheckPasswordRules(b.Password); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: err.Error()}
	}
	ot, err := s.useOneTime(ctx, "reset", b.Token, false)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(b.Password)
	if err != nil {
		return err
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", ot.UserID)); err != nil {
		return err
	}
	s.st.Update(ctx, "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("user_id", ot.UserID), store.Null("revoked_at"))
	s.audit(x.r, "", core.User{ID: ot.UserID}, "password.reset", "user", ot.UserID, nil)
	return x.ok(map[string]any{"ok": true})
}

// ---- registration and invitations ----

// emailAllowed checks an address against the allowed-domains list.
func (s *Server) emailAllowed(ctx context.Context, email string) bool {
	var domains []string
	s.setting(ctx, "auth.allowed_domains", &domains)
	if len(domains) == 0 {
		return true
	}
	at := strings.LastIndex(email, "@")
	for _, d := range domains {
		if at >= 0 && strings.EqualFold(email[at+1:], strings.TrimPrefix(strings.TrimSpace(d), "@")) {
			return true
		}
	}
	return false
}

// newPerson makes a person's account.
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
	if err := s.st.Insert(ctx, u); err != nil {
		return u, &engine.Error{Code: engine.CodeConflict, Field: "email", Message: "there is already an account with this email; sign in instead"}
	}
	return u, nil
}

type registerBody struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// hRegister makes an account when open registration is on.
func (s *Server) hRegister(x *c) error {
	var b registerBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if !s.settingBool(ctx, "auth.registration", false) {
		return errForbidden("registration is closed on this install; ask for an invitation")
	}
	if !s.emailAllowed(ctx, b.Email) {
		return errForbidden("accounts here are limited to certain email domains")
	}
	if err := s.throttle(ctx, "register:ip:"+clientIP(x.r), 10, time.Hour); err != nil {
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
	if err := s.startSession(x, u, "full"); err != nil {
		return err
	}
	return x.json(201, map[string]any{"user": u})
}

type inviteBody struct {
	Email       string `json:"email"`
	Role        string `json:"role"`
	ExpiresDays int    `json:"expires_days"`
	MaxUses     int    `json:"max_uses"`
}

// hInviteCreate makes an invitation: a link that lets someone join this
// workspace with a role. With an email it is for that address only and is
// mailed when the install can send mail.
func (s *Server) hInviteCreate(x *c) error {
	var b inviteBody
	if err := x.body(&b); err != nil {
		return err
	}
	if err := x.admin(); err != nil {
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
	token := auth.Random(24)
	now := time.Now()
	inv := core.Invite{ID: id.New(), WorkspaceID: x.ws.ID, Email: email, Role: role, TokenHash: auth.Hash(token), CreatedBy: x.member.UserID,
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

func (s *Server) hInvites(x *c) error {
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

func (s *Server) hInviteRevoke(x *c) error {
	if err := x.admin(); err != nil {
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

func (s *Server) invite(ctx context.Context, token string) (core.Invite, core.Workspace, error) {
	var inv core.Invite
	var ws core.Workspace
	gone := &engine.Error{Code: engine.CodeNotFound, Message: "this invitation is no longer valid; ask for a new one"}
	if err := s.st.Get(ctx, &inv, store.Eq("token_hash", auth.Hash(token)), store.Null("revoked_at")); err != nil {
		return inv, ws, gone
	}
	if inv.ExpiresAt < time.Now().UnixMilli() || inv.Uses >= inv.MaxUses {
		return inv, ws, gone
	}
	if err := s.st.Get(ctx, &ws, store.Eq("id", inv.WorkspaceID), store.Live); err != nil {
		return inv, ws, gone
	}
	return inv, ws, nil
}

// hInviteShow says what an invitation is for, before anyone signs in.
func (s *Server) hInviteShow(x *c) error {
	inv, ws, err := s.invite(x.ctx(), x.r.PathValue("token"))
	if err != nil {
		return err
	}
	var inviter core.User
	s.st.Get(x.ctx(), &inviter, store.Eq("id", inv.CreatedBy))
	out := map[string]any{"workspace": map[string]string{"name": ws.Name, "slug": ws.Slug}, "role": inv.Role, "email": inv.Email, "invited_by": inviter.Name}
	if inv.Email != "" {
		var u core.User
		out["has_account"] = s.st.Get(x.ctx(), &u, store.Eq("email", inv.Email), store.Live) == nil
	}
	return x.ok(out)
}

// hInviteAccept joins the workspace: as the person signed in, or as a new
// account made from the name and password sent along.
func (s *Server) hInviteAccept(x *c) error {
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
	if s.identify(x) == nil && x.user.Kind == core.KindPerson {
		u = x.user
	} else {
		email := b.Email
		if inv.Email != "" {
			email = inv.Email
		}
		if !s.emailAllowed(ctx, email) {
			return errForbidden("accounts here are limited to certain email domains")
		}
		if b.Password == "" {
			return &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: "choose a password, or sign in first if you have an account"}
		}
		if u, err = s.newPerson(ctx, b.Name, email, b.Password); err != nil {
			return err
		}
		if err := s.startSession(x, u, "full"); err != nil {
			return err
		}
	}
	if inv.Email != "" && !strings.EqualFold(inv.Email, u.Email) {
		return errForbidden("this invitation is for %s; you are signed in as %s", inv.Email, u.Email)
	}
	if n, _ := s.st.Count(ctx, "members", store.Eq("workspace_id", ws.ID), store.Eq("user_id", u.ID), store.Null("removed_at")); n > 0 {
		return x.ok(map[string]any{"workspace": ws, "already_member": true})
	}
	// Count the use first, so a link good for one person admits one.
	n, err := s.st.Incr(ctx, "invites", "uses", 1, store.Eq("id", inv.ID))
	if err != nil || int(n) > inv.MaxUses {
		return &engine.Error{Code: engine.CodeNotFound, Message: "this invitation was already used"}
	}
	err = s.eng.System(ctx, ws.ID, inv.CreatedBy, func(sys *engine.Sys) error {
		return sys.Do("member.add", map[string]any{"user": u.ID, "role": string(inv.Role)})
	})
	if err != nil {
		return err
	}
	s.audit(x.r, ws.ID, u, "invite.accepted", "invite", inv.ID, nil)
	return x.ok(map[string]any{"workspace": ws, "user": u})
}
