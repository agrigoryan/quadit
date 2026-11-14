package server

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

const sessionLife = 30 * 24 * time.Hour

// setting reads one install setting into dst; a missing one leaves dst alone.
func (s *Server) setting(ctx context.Context, name string, dst any) bool {
	var st core.Setting
	if err := s.st.Get(ctx, &st, store.Eq("name", name)); err != nil || len(st.Value) == 0 {
		return false
	}
	return json.Unmarshal(st.Value, dst) == nil
}

func (s *Server) settingInt(ctx context.Context, name string, def int) int {
	s.setting(ctx, name, &def)
	return def
}

func (s *Server) settingBool(ctx context.Context, name string, def bool) bool {
	s.setting(ctx, name, &def)
	return def
}

func (s *Server) settingStr(ctx context.Context, name, def string) string {
	s.setting(ctx, name, &def)
	return def
}

// throttle counts an attempt under a name and refuses when there were more
// than max in the window. The count is in the database, so every server
// sharing it sees the same number.
func (s *Server) throttle(ctx context.Context, name string, max int, window time.Duration) error {
	bucket := time.Now().Unix() / int64(window.Seconds())
	var rc core.RateCounter
	err := s.st.Get(ctx, &rc, store.Eq("name", name), store.Eq("bucket", bucket))
	if errors.Is(err, store.ErrNotFound) {
		s.st.Upsert(ctx, core.RateCounter{Name: name, Bucket: bucket, Hits: 1}, "name", "bucket")
		s.st.Delete(ctx, "rate_counters", store.Lt("bucket", bucket-2)) // old windows
		return nil
	}
	if rc.Hits >= max {
		wait := int(int64(window.Seconds()) - time.Now().Unix()%int64(window.Seconds()))
		return &httpError{Status: 429, Code: "rate_limited", RetryAfter: wait, Message: "too many attempts; try again in a few minutes"}
	}
	s.st.Incr(ctx, "rate_counters", "hits", 1, store.Eq("name", name), store.Eq("bucket", bucket))
	return nil
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

func (s *Server) clearCookie(x *c) {
	http.SetCookie(x.w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
}

// hAuthConfig tells the sign-in page what it can offer.
func (s *Server) hAuthConfig(x *c) error {
	ctx := x.ctx()
	people, err := s.st.Count(ctx, "users", store.Eq("kind", core.KindPerson))
	if err != nil {
		return err
	}
	out := map[string]any{
		"setup_needed": people == 0,
		"password":     s.settingBool(ctx, "auth.password", true),
		"passkeys":     s.settingBool(ctx, "auth.passkeys", true),
		"registration": s.settingBool(ctx, "auth.registration", false),
		"version":      s.cfg.Version,
		"name":         s.settingStr(ctx, "install.name", "Quadit"),
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

// hSetup makes the first person and the first workspace on a new install.
// It works once.
func (s *Server) hSetup(x *c) error {
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

// hLogin signs a person in with email and password. When they have a second
// step set up the session waits for it.
func (s *Server) hLogin(x *c) error {
	var b loginBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if !s.settingBool(ctx, "auth.password", true) {
		return errForbidden("signing in with a password is turned off on this install")
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	if err := s.throttle(ctx, "login:ip:"+clientIP(x.r), 30, 15*time.Minute); err != nil {
		return err
	}
	if err := s.throttle(ctx, "login:email:"+email, 10, 15*time.Minute); err != nil {
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
	s.st.Update(x.ctx(), "users", map[string]any{"last_seen_at": time.Now().UnixMilli()}, store.Eq("id", u.ID))
	return x.ok(map[string]any{"user": u})
}

func (s *Server) hLogout(x *c) error {
	if ck, err := x.r.Cookie(sessionCookie); err == nil {
		s.st.Update(x.ctx(), "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("token_hash", auth.Hash(ck.Value)))
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

// hAuthMe says who is signed in and which workspaces they are in.
func (s *Server) hAuthMe(x *c) error {
	ws, err := s.memberships(x.ctx(), x.user.ID)
	if err != nil {
		return err
	}
	passkeys, _ := s.st.Count(x.ctx(), "passkeys", store.Eq("user_id", x.user.ID))
	return x.ok(map[string]any{"user": x.user, "workspaces": ws, "has_password": x.user.PasswordHash != "", "passkeys": passkeys})
}

type profileBody struct {
	Name     *string          `json:"name"`
	Avatar   *string          `json:"avatar"`
	Timezone *string          `json:"timezone"`
	Theme    *string          `json:"theme"`
	Locale   *string          `json:"locale"`
	Notify   *json.RawMessage `json:"notify"`
}

// hProfile changes the signed-in person's own profile.
func (s *Server) hProfile(x *c) error {
	var b profileBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.token != nil {
		return errForbidden("a profile is changed by its person, signed in")
	}
	ctx := x.ctx()
	set := map[string]any{}
	memberSet := map[string]any{}
	if b.Name != nil {
		name := strings.TrimSpace(*b.Name)
		if name == "" {
			return errBad("a name cannot be empty")
		}
		set["name"], memberSet["name"] = name, name
	}
	if b.Avatar != nil {
		set["avatar"], memberSet["avatar"] = *b.Avatar, *b.Avatar
	}
	if b.Timezone != nil {
		if _, err := time.LoadLocation(*b.Timezone); err != nil {
			return errBad("%q is not a time zone: use a name like Europe/Berlin", *b.Timezone)
		}
		set["timezone"] = *b.Timezone
	}
	if b.Theme != nil {
		if !has([]string{"", "light", "dark", "system"}, *b.Theme) {
			return errBad("theme is light, dark or system")
		}
		set["theme"] = *b.Theme
	}
	if b.Locale != nil {
		set["locale"] = *b.Locale
	}
	if b.Notify != nil {
		set["notify"] = *b.Notify
	}
	if len(set) == 0 {
		return s.hAuthMe(x)
	}
	set["updated_at"] = time.Now().UnixMilli()
	if _, err := s.st.Update(ctx, "users", set, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	if len(memberSet) > 0 {
		// The name and avatar are copied onto each membership; tell each
		// workspace so open browsers show the change.
		ms, err := s.memberships(ctx, x.user.ID)
		if err != nil {
			return err
		}
		for _, m := range ms {
			err := s.eng.System(ctx, m.ID, x.user.ID, func(sys *engine.Sys) error {
				if _, err := sys.Tx().Update(ctx, "members", memberSet, store.Eq("user_id", x.user.ID)); err != nil {
					return err
				}
				changes := map[string]core.FieldChange{}
				for k, v := range memberSet {
					changes[k] = core.FieldChange{To: v}
				}
				return sys.Emit("member.updated", "member", x.user.ID, "workspace", m.ID, "", map[string]any{"id": x.user.ID, "changes": changes})
			})
			if err != nil {
				return err
			}
		}
	}
	if err := s.st.Get(ctx, &x.user, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	return s.hAuthMe(x)
}

type passwordBody struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

func (s *Server) hPassword(x *c) error {
	var b passwordBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.sess == nil {
		return errForbidden("a password is changed by its person, signed in")
	}
	if x.user.PasswordHash != "" && !auth.CheckPassword(x.user.PasswordHash, b.Current) {
		return errForbidden("the current password is wrong")
	}
	if err := auth.CheckPasswordRules(b.New); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "new", Message: err.Error()}
	}
	hash, err := auth.HashPassword(b.New)
	if err != nil {
		return err
	}
	ctx := x.ctx()
	if _, err := s.st.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	// Every other browser is signed out.
	s.st.Update(ctx, "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("user_id", x.user.ID), store.Ne("id", x.sess.ID), store.Null("revoked_at"))
	s.audit(x.r, "", x.user, "password.changed", "user", x.user.ID, nil)
	return x.ok(map[string]any{"ok": true})
}

func (s *Server) hSessions(x *c) error {
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

func (s *Server) hSessionRevoke(x *c) error {
	n, err := s.st.Update(x.ctx(), "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()},
		store.Eq("id", x.r.PathValue("id")), store.Eq("user_id", x.user.ID))
	if err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("session")
	}
	return x.ok(map[string]any{"ok": true})
}

type workspaceBody struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// hWorkspaceCreate makes another workspace on the install, owned by the
// person signed in.
func (s *Server) hWorkspaceCreate(x *c) error {
	var b workspaceBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.user.Kind != core.KindPerson || x.token != nil {
		return errForbidden("a workspace is created by a person, signed in")
	}
	if !x.user.IsAdmin && !s.settingBool(x.ctx(), "workspaces.anyone_can_create", true) {
		return errForbidden("only an install admin can create workspaces here")
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

// ---- API tokens ----

type tokenBody struct {
	User        string   `json:"user"` // an agent's @handle, or "me"
	Name        string   `json:"name"`
	ReadOnly    bool     `json:"read_only"`
	Projects    []string `json:"projects"` // keys; empty = every project the member may use
	ExpiresDays int      `json:"expires_days"`
}

// hTokenCreate issues a token for an agent (admins) or for oneself. The
// token is in the answer and nowhere else afterwards.
func (s *Server) hTokenCreate(x *c) error {
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
		if err := x.admin(); err != nil {
			return err
		}
		if m.Kind != core.KindAgent {
			return errForbidden("a person's tokens are made by that person")
		}
	} else if x.member.Kind == core.KindAgent && x.token != nil {
		return errForbidden("an agent cannot issue itself more tokens; ask an admin")
	}
	var scopes []string
	if b.ReadOnly {
		scopes = append(scopes, "read")
	}
	for _, ref := range b.Projects {
		p, err := rs.Project(ref)
		if err != nil {
			return err
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

func (s *Server) hTokens(x *c) error {
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

// hTokenRevoke ends a token at once.
func (s *Server) hTokenRevoke(x *c) error {
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
	s.audit(x.r, x.ws.ID, x.user, "token.revoked", "token", t.ID, nil)
	return x.ok(map[string]any{"ok": true})
}
