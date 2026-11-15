package server

// Sign-in with a password, sessions, and the signed-in person's own account.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// The routes of the second step, password reset, registration and
// invitations: auth_totp.go, auth_reset.go, auth_invites.go.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /api/v1/auth/second-step", s.firstStepPassed(s.handleFinishSecondStep))
		m.HandleFunc("POST /api/v1/auth/totp/start", s.signedIn(s.handleStartTwoStepSetup))
		m.HandleFunc("POST /api/v1/auth/totp/enable", s.signedIn(s.handleEnableTwoStep))
		m.HandleFunc("POST /api/v1/auth/totp/disable", s.signedIn(s.handleDisableTwoStep))
		m.HandleFunc("POST /api/v1/auth/recovery-codes", s.signedIn(s.handleRenewRecoveryCodes))
		m.HandleFunc("POST /api/v1/auth/reset/request", s.public(s.handleRequestPasswordReset))
		m.HandleFunc("POST /api/v1/auth/reset/confirm", s.public(s.handleConfirmPasswordReset))
		m.HandleFunc("POST /api/v1/auth/register", s.public(s.handleRegisterAccount))
		m.HandleFunc("GET /api/v1/auth/invite/{token}", s.public(s.handleShowInvite))
		m.HandleFunc("POST /api/v1/auth/invite/{token}", s.public(s.handleAcceptInvite))
		const w = "/api/v1/w/{ws}"
		m.HandleFunc("GET "+w+"/invites", s.workspaceMember(s.handleListInvites))
		m.HandleFunc("POST "+w+"/invites", s.workspaceMember(s.handleCreateInvite))
		m.HandleFunc("DELETE "+w+"/invites/{id}", s.workspaceMember(s.handleRevokeInvite))
	})
}

const sessionLife = 30 * 24 * time.Hour

// Sign-in attempts are counted in windows of signInWindow: at most
// signInsPerIP from one address, and signInsPerEmail for one account.
const (
	signInWindow    = 15 * time.Minute
	signInsPerIP    = 30
	signInsPerEmail = 10
)

// accountRequestsPerHour is how many registrations, or requests for a reset
// link, one address may make in an hour.
const accountRequestsPerHour = 10

// throttle counts an attempt under a name and refuses when there were more
// than limit in the window. The count is in the database, so every server
// sharing it sees the same number. An attempt that cannot be counted is
// refused: a limit that cannot be checked lets nobody through.
func (s *Server) throttle(ctx context.Context, name string, limit int, window time.Duration) error {
	bucket := time.Now().Unix() / int64(window.Seconds())
	var counter core.RateCounter
	err := s.st.Get(ctx, &counter, store.Eq("name", name), store.Eq("bucket", bucket))
	switch {
	case errors.Is(err, store.ErrNotFound):
		if err := s.st.Upsert(ctx, core.RateCounter{Name: name, Bucket: bucket, Hits: 1}, "name", "bucket"); err != nil {
			return s.uncounted(name, err)
		}
		if _, err := s.st.Delete(ctx, "rate_counters", store.Lt("bucket", bucket-2)); err != nil {
			s.log.Warn("old rate-limit windows not cleared; the next first attempt tries again", "err", err)
		}
		return nil
	case err != nil:
		return s.uncounted(name, err)
	}
	if counter.Hits >= limit {
		wait := int(int64(window.Seconds()) - time.Now().Unix()%int64(window.Seconds()))
		return &httpError{Status: 429, Code: "rate_limited", RetryAfter: wait, Message: "too many attempts; try again in a few minutes"}
	}
	if _, err := s.st.Incr(ctx, "rate_counters", "hits", 1, store.Eq("name", name), store.Eq("bucket", bucket)); err != nil {
		return s.uncounted(name, err)
	}
	return nil
}

// uncounted logs why an attempt could not be counted and refuses it.
func (s *Server) uncounted(name string, err error) error {
	kind, _, _ := strings.Cut(name, ":")
	s.log.Error("an attempt could not be counted, so it is refused", "limit", kind, "err", err)
	return &httpError{Status: 429, Code: "rate_limited", RetryAfter: uncountedRetry,
		Message: "attempts cannot be counted right now; try again in a few minutes"}
}

// uncountedRetry is how long, in seconds, a client is asked to wait when an
// attempt could not be counted.
const uncountedRetry = 60

// oneTime makes a short-lived secret and stores its hash with some data.
func (s *Server) oneTime(ctx context.Context, kind, userID string, data any, life time.Duration) (string, error) {
	token := auth.Random(32)
	now := time.Now()
	row := core.OneTimeToken{ID: id.New(), Kind: kind, TokenHash: auth.Hash(token), UserID: userID, CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(life).UnixMilli()}
	if data != nil {
		row.Data, _ = json.Marshal(data)
	}
	return token, s.st.Insert(ctx, row)
}

// useOneTime spends a one-time secret. It works once and only while fresh.
//
//nolint:unparam // keep is in the signature picture.go calls too; dropping it belongs to the unit that owns that file
func (s *Server) useOneTime(ctx context.Context, kind, token string, keep bool) (core.OneTimeToken, error) {
	var spent core.OneTimeToken
	err := s.st.Get(ctx, &spent, store.Eq("token_hash", auth.Hash(token)), store.Eq("kind", kind), store.Null("used_at"))
	if err != nil || spent.ExpiresAt < time.Now().UnixMilli() {
		return spent, &engine.Error{Code: engine.CodeNotFound, Message: "this link is no longer valid; ask for a new one"}
	}
	if !keep {
		n, err := s.st.Update(ctx, "one_time_tokens", map[string]any{"used_at": time.Now().UnixMilli()}, store.Eq("id", spent.ID), store.Null("used_at"))
		if err != nil || n != 1 {
			return spent, &engine.Error{Code: engine.CodeNotFound, Message: "this link was already used"}
		}
	}
	return spent, nil
}

// startSession signs a person in on this browser.
func (s *Server) startSession(x *c, u core.User, stage string) error {
	token := auth.Random(32)
	now := time.Now()
	ua := x.r.UserAgent()
	if len(ua) > 200 {
		ua = ua[:200]
	}
	sess := core.Session{ID: id.New(), TokenHash: auth.Hash(token), UserID: u.ID, Stage: stage, IP: clientIP(x.r), UserAgent: ua,
		CreatedAt: now.UnixMilli(), LastSeenAt: now.UnixMilli(), ExpiresAt: now.Add(sessionLife).UnixMilli()}
	if err := s.st.Insert(x.ctx(), sess); err != nil {
		return err
	}
	http.SetCookie(x.w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: strings.HasPrefix(s.cfg.BaseURL, "https://"), Expires: now.Add(sessionLife)})
	x.sess = &sess
	return nil
}

// clearCookie takes the session cookie off this browser.
func (s *Server) clearCookie(x *c) {
	http.SetCookie(x.w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
}

// handleShowSignInOptions tells the sign-in page what it can offer.
func (s *Server) handleShowSignInOptions(x *c) error {
	ctx := x.ctx()
	people, err := s.st.Count(ctx, "users", store.Eq("kind", core.KindPerson))
	if err != nil {
		return err
	}
	out := map[string]any{
		"setup_needed":                 people == 0,
		"password":                     s.settingBool(ctx, "auth.password", true),
		"passkeys":                     s.settingBool(ctx, "auth.passkeys", true),
		"registration":                 s.settingBool(ctx, "auth.registration", false),
		"anyone_can_create_workspaces": s.settingBool(ctx, "workspaces.anyone_can_create", true),
		"require_2fa":                  s.settingBool(ctx, "auth.require_2fa", false),
		"mail":                         s.mailReady(ctx),
		"version":                      s.cfg.Version,
		"name":                         s.settingStr(ctx, "install.name", "Quadit"),
	}
	out["providers"] = s.providerList(ctx)
	return x.ok(out)
}

type setupBody struct {
	Name          string `json:"name"`
	Email         string `json:"email"`
	Password      string `json:"password"`
	WorkspaceName string `json:"workspace_name"`
	WorkspaceSlug string `json:"workspace_slug"`
}

// handleSetUpInstall makes the first person and the first workspace on a new install.
// It works once.
func (s *Server) handleSetUpInstall(x *c) error {
	var b setupBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if n, err := s.st.Count(ctx, "users", store.Eq("kind", core.KindPerson)); err != nil || n > 0 {
		return &engine.Error{Code: engine.CodeConflict, Message: "this install is already set up; sign in instead"}
	}
	if err := auth.CheckPasswordRules(b.Password); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: err.Error()}
	}
	if b.WorkspaceSlug == "" {
		b.WorkspaceSlug = slugFrom(b.WorkspaceName)
	}
	ws, owner, err := s.eng.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: b.Name, OwnerEmail: b.Email, WorkspaceSlug: b.WorkspaceSlug, WorkspaceName: b.WorkspaceName})
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(b.Password)
	if err != nil {
		return err
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", owner.ID)); err != nil {
		return err
	}
	s.audit(x.r, ws.ID, owner, "install.setup", "workspace", ws.ID, nil)
	if err := s.startSession(x, owner, "full"); err != nil {
		return err
	}
	return x.json(201, map[string]any{"user": owner, "workspace": ws})
}

func slugFrom(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = strings.Trim(out[:40], "-")
	}
	if len(out) < 2 {
		out = "team"
	}
	return out
}

type loginBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// handleSignIn signs a person in with email and password. When they have a second
// step set up the session waits for it.
func (s *Server) handleSignIn(x *c) error {
	var b loginBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if on, err := s.checkedSettingBool(ctx, "auth.password", true); err != nil {
		return err
	} else if !on {
		return errForbidden("signing in with a password is turned off on this install")
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if err := s.throttle(ctx, "login:ip:"+clientIP(x.r), signInsPerIP, signInWindow); err != nil {
		return err
	}
	if err := s.throttle(ctx, "login:email:"+email, signInsPerEmail, signInWindow); err != nil {
		return err
	}
	var u core.User
	err := s.st.Get(ctx, &u, store.Eq("email", email), store.Live)
	if err != nil || u.Kind != core.KindPerson || u.PasswordHash == "" || !auth.CheckPassword(u.PasswordHash, b.Password) {
		if err != nil {
			auth.CheckPassword("$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", b.Password) // same time as a real check
		}
		s.audit(x.r, "", core.User{ID: u.ID, Name: email}, "signin.failed", "user", u.ID, nil)
		return errUnauthorized("wrong email or password")
	}
	if u.DisabledAt != 0 {
		return errUnauthorized("this account is disabled")
	}
	return s.finishSignIn(x, u, "password")
}

// finishSignIn starts the session after the first step, asking for the
// second when the person has one.
func (s *Server) finishSignIn(x *c, u core.User, method string) error {
	stage := "full"
	if u.TOTPAt != 0 && method != "passkey" {
		stage = "mfa"
	}
	if err := s.startSession(x, u, stage); err != nil {
		return err
	}
	if stage == "mfa" {
		return x.ok(map[string]any{"second_step": true})
	}
	s.audit(x.r, "", u, "signin", "user", u.ID, map[string]string{"method": method})
	if _, err := s.st.Update(x.ctx(), "users", map[string]any{"last_seen_at": time.Now().UnixMilli()}, store.Eq("id", u.ID)); err != nil {
		s.log.Warn("last seen not recorded at sign-in", "err", err) // the next request records it
	}
	return x.ok(map[string]any{"user": u})
}

// handleSignOut ends the browser's session. When the session cannot be
// ended the cookie is still cleared, and the answer says it failed.
func (s *Server) handleSignOut(x *c) error {
	if ck, err := x.r.Cookie(sessionCookie); err == nil {
		if _, err := s.st.Update(x.ctx(), "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("token_hash", auth.Hash(ck.Value))); err != nil {
			s.clearCookie(x)
			return err
		}
		s.accessChanged()
	}
	s.clearCookie(x)
	return x.ok(map[string]any{"ok": true})
}

type membership struct {
	ID     string    `json:"id"`
	Slug   string    `json:"slug"`
	Name   string    `json:"name"`
	Icon   string    `json:"icon,omitempty"`
	Role   core.Role `json:"role"`
	Handle string    `json:"handle"`
}

func (s *Server) memberships(ctx context.Context, userID string) ([]membership, error) {
	var ms []core.Member
	if err := s.st.List(ctx, &ms, store.Where(store.Eq("user_id", userID), store.Null("removed_at"))); err != nil {
		return nil, err
	}
	out := []membership{}
	for _, m := range ms {
		var ws core.Workspace
		if err := s.st.Get(ctx, &ws, store.Eq("id", m.WorkspaceID), store.Live); err == nil {
			out = append(out, membership{ID: ws.ID, Slug: ws.Slug, Name: ws.Name, Icon: ws.Icon, Role: m.Role, Handle: m.Handle})
		}
	}
	return out, nil
}

// handleShowAccount says who is signed in and which workspaces they are in.
func (s *Server) handleShowAccount(x *c) error {
	ws, err := s.memberships(x.ctx(), x.user.ID)
	if err != nil {
		return err
	}
	passkeys, err := s.st.Count(x.ctx(), "passkeys", store.Eq("user_id", x.user.ID))
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"user": x.user, "workspaces": ws, "has_password": x.user.PasswordHash != "", "passkeys": passkeys})
}

type profileBody struct {
	Name     *string          `json:"name"`
	Avatar   *string          `json:"avatar"`
	Timezone *string          `json:"timezone"`
	Theme    *string          `json:"theme"`
	Locale   *string          `json:"locale"`
	Notify   *json.RawMessage `json:"notify"`
	// Email changes the sign-in address; Password must then be the current
	// password, when the account has one.
	Email    *string `json:"email"`
	Password string  `json:"password"`
}

// handleUpdateProfile changes the signed-in person's own profile.
func (s *Server) handleUpdateProfile(x *c) error {
	var b profileBody
	if err := x.body(&b); err != nil {
		return err
	}
	if !x.hasFullAccess() || x.user.Kind != core.KindPerson {
		return errForbidden("a profile is changed by its person: signed in, or with a personal token that is not narrowed")
	}
	ctx := x.ctx()
	set, memberSet, err := profileChanges(b)
	if err != nil {
		return err
	}
	if err := s.changeEmail(x, b, set); err != nil {
		return err
	}
	if len(set) == 0 {
		return s.handleShowAccount(x)
	}
	set["updated_at"] = time.Now().UnixMilli()
	if _, err := s.st.Update(ctx, "users", set, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	if len(memberSet) > 0 {
		if err := s.copyToMemberships(ctx, x.user.ID, memberSet); err != nil {
			return err
		}
	}
	if err := s.st.Get(ctx, &x.user, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	return s.handleShowAccount(x)
}

// profileChanges checks a profile change and gives the columns it sets on
// the person, and those of them also copied onto each membership. The
// email address is changeEmail's.
func profileChanges(b profileBody) (set, memberSet map[string]any, err error) {
	set, memberSet = map[string]any{}, map[string]any{}
	if b.Name != nil {
		name := strings.TrimSpace(*b.Name)
		if name == "" {
			return nil, nil, errBad("a name cannot be empty")
		}
		set["name"], memberSet["name"] = name, name
	}
	if b.Avatar != nil {
		set["avatar"], memberSet["avatar"] = *b.Avatar, *b.Avatar
	}
	if b.Timezone != nil {
		if _, err := time.LoadLocation(*b.Timezone); err != nil {
			return nil, nil, errBad("%q is not a time zone: use a name like Europe/Berlin", *b.Timezone)
		}
		set["timezone"] = *b.Timezone
	}
	if b.Theme != nil {
		if !has([]string{"", "light", "dark", "system"}, *b.Theme) {
			return nil, nil, errBad("theme is light, dark or system")
		}
		set["theme"] = *b.Theme
	}
	if b.Locale != nil {
		set["locale"] = *b.Locale
	}
	if b.Notify != nil {
		set["notify"] = *b.Notify
	}
	return set, memberSet, nil
}

// changeEmail checks a new sign-in address, confirmed with the current
// password, and adds it to set. The change is written to the audit log.
func (s *Server) changeEmail(x *c, b profileBody, set map[string]any) error {
	if b.Email == nil || strings.EqualFold(strings.TrimSpace(*b.Email), x.user.Email) {
		return nil
	}
	email := strings.ToLower(strings.TrimSpace(*b.Email))
	if !strings.Contains(email, "@") || strings.ContainsAny(email, " \t\n<>") {
		return &engine.Error{Code: engine.CodeInvalid, Field: "email", Message: "that is not an email address"}
	}
	if x.user.PasswordHash != "" && !auth.CheckPassword(x.user.PasswordHash, b.Password) {
		return &engine.Error{Code: engine.CodeForbidden, Field: "password", Message: "confirm with your current password"}
	}
	if n, err := s.st.Count(x.ctx(), "users", store.Eq("email", email), store.Live); err != nil {
		return err
	} else if n > 0 {
		return &engine.Error{Code: engine.CodeConflict, Field: "email", Message: "another account uses this address"}
	}
	set["email"] = email
	s.audit(x.r, "", x.user, "email.changed", "user", x.user.ID, map[string]string{"from": x.user.Email, "to": email})
	return nil
}

// copyToMemberships copies a person's name and avatar onto each of their
// memberships, telling each workspace so open browsers show the change.
func (s *Server) copyToMemberships(ctx context.Context, userID string, memberSet map[string]any) error {
	ms, err := s.memberships(ctx, userID)
	if err != nil {
		return err
	}
	for _, m := range ms {
		err := s.eng.System(ctx, m.ID, userID, func(sys *engine.Sys) error {
			if _, err := sys.Tx().Update(ctx, "members", memberSet, store.Eq("user_id", userID)); err != nil {
				return err
			}
			changes := map[string]core.FieldChange{}
			for k, v := range memberSet {
				changes[k] = core.FieldChange{To: v}
			}
			return sys.Emit("member.updated", "member", userID, "workspace", m.ID, "", map[string]any{"id": userID, "changes": changes})
		})
		if err != nil {
			return err
		}
	}
	return nil
}

type passwordBody struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

// handleChangePassword changes the signed-in person's password, confirmed
// with the current one, and signs out their other browsers.
func (s *Server) handleChangePassword(x *c) error {
	var b passwordBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.sess == nil {
		return errForbidden("a password is changed by its person, signed in")
	}
	if x.user.PasswordHash != "" && !auth.CheckPassword(x.user.PasswordHash, b.Current) {
		return &engine.Error{Code: engine.CodeForbidden, Field: "current", Message: "the current password is wrong"}
	}
	if err := auth.CheckPasswordRules(b.New); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "new", Message: err.Error()}
	}
	hash, err := auth.HashPassword(b.New)
	if err != nil {
		return err
	}
	// Every other browser is signed out, in the same write: the password
	// does not change while they stay signed in.
	err = s.setPassword(x.ctx(), x.user.ID, hash, store.Ne("id", x.sess.ID))
	if err != nil {
		return err
	}
	s.accessChanged()
	s.audit(x.r, "", x.user, "password.changed", "user", x.user.ID, nil)
	return x.ok(map[string]any{"ok": true})
}

// setPassword changes a person's password and, in the same write, ends
// their sessions; which narrows the sessions that end.
func (s *Server) setPassword(ctx context.Context, userID, hash string, which ...store.Cond) error {
	return s.st.Atomic(ctx, func(db store.DB) error {
		if _, err := db.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", userID)); err != nil {
			return err
		}
		where := append([]store.Cond{store.Eq("user_id", userID)}, which...)
		_, err := db.Update(ctx, "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, append(where, store.Null("revoked_at"))...)
		return err
	})
}

func (s *Server) handleListSessions(x *c) error {
	var ss []core.Session
	now := time.Now().UnixMilli()
	if err := s.st.List(x.ctx(), &ss, store.Q{Where: []store.Cond{store.Eq("user_id", x.user.ID), store.Null("revoked_at"), store.Gt("expires_at", now)}, Order: "-last_seen_at"}); err != nil {
		return err
	}
	type out struct {
		core.Session
		Current bool `json:"current"`
	}
	list := make([]out, len(ss))
	for i, se := range ss {
		list[i] = out{Session: se, Current: x.sess != nil && se.ID == x.sess.ID}
	}
	return x.ok(map[string]any{"sessions": list})
}

func (s *Server) handleRevokeSession(x *c) error {
	n, err := s.st.Update(x.ctx(), "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()},
		store.Eq("id", x.r.PathValue("id")), store.Eq("user_id", x.user.ID))
	if err != nil {
		return err
	}
	s.accessChanged()
	if n == 0 {
		return errNotFound("session")
	}
	return x.ok(map[string]any{"ok": true})
}

type workspaceBody struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// handleCreateWorkspace makes another workspace on the install, owned by the
// person signed in.
func (s *Server) handleCreateWorkspace(x *c) error {
	var b workspaceBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.user.Kind != core.KindPerson || !x.hasFullAccess() {
		return errForbidden("a workspace is created by a person: signed in, or with a personal token that is not narrowed")
	}
	if !x.user.IsAdmin {
		if anyone, err := s.checkedSettingBool(x.ctx(), "workspaces.anyone_can_create", true); err != nil {
			return err
		} else if !anyone {
			return errForbidden("only an install admin can create workspaces here")
		}
	}
	if b.Slug == "" {
		b.Slug = slugFrom(b.Name)
	}
	ws, _, err := s.eng.Bootstrap(x.ctx(), engine.BootstrapArgs{OwnerID: x.user.ID, WorkspaceSlug: b.Slug, WorkspaceName: b.Name})
	if err != nil {
		return err
	}
	s.audit(x.r, ws.ID, x.user, "workspace.created", "workspace", ws.ID, nil)
	return x.json(201, ws)
}
