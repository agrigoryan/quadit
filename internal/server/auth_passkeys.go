package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/auth/passkeys", s.signed(s.hPasskeys))
		m.HandleFunc("POST /api/v1/auth/passkeys/register/start", s.signed(s.hPasskeyRegisterStart))
		m.HandleFunc("POST /api/v1/auth/passkeys/register/finish", s.signed(s.hPasskeyRegisterFinish))
		m.HandleFunc("PATCH /api/v1/auth/passkeys/{id}", s.signed(s.hPasskeyRename))
		m.HandleFunc("DELETE /api/v1/auth/passkeys/{id}", s.signed(s.hPasskeyDelete))
		m.HandleFunc("POST /api/v1/auth/passkeys/login/start", s.open(s.hPasskeyLoginStart))
		m.HandleFunc("POST /api/v1/auth/passkeys/login/finish", s.open(s.hPasskeyLoginFinish))
	})
}

// waUser is a person as the WebAuthn library wants to see one.
type waUser struct {
	u     core.User
	creds []webauthn.Credential
}

func (w waUser) WebAuthnID() []byte                         { return []byte(w.u.ID) }
func (w waUser) WebAuthnName() string                       { return w.u.Email }
func (w waUser) WebAuthnDisplayName() string                { return w.u.Name }
func (w waUser) WebAuthnCredentials() []webauthn.Credential { return w.creds }

// webauthn builds the relying party for this request. The party is the
// host people reach the server on; a local dev server on another port of
// localhost is let in too.
func (s *Server) webauthn(r *http.Request) (*webauthn.WebAuthn, error) {
	base, err := url.Parse(s.cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	origins := []string{base.Scheme + "://" + base.Host}
	if o := r.Header.Get("Origin"); o != "" {
		if ou, err := url.Parse(o); err == nil && ou.Hostname() == base.Hostname() && (ou.Hostname() == "localhost" || ou.Hostname() == "127.0.0.1") {
			origins = append(origins, o)
		}
	}
	if net.ParseIP(base.Hostname()) != nil {
		return nil, &engine.Error{Code: engine.CodeConflict, Message: "passkeys need the server to be reached by a name, not an IP address: " +
			"start it with --url set to its name (http://localhost:4780 works for a local install)"}
	}
	return webauthn.New(&webauthn.Config{RPID: base.Hostname(), RPDisplayName: s.settingStr(r.Context(), "install.name", "Quadit"), RPOrigins: origins})
}

func (s *Server) passkeyUser(ctx context.Context, u core.User) (waUser, error) {
	var rows []core.Passkey
	if err := s.st.List(ctx, &rows, store.Where(store.Eq("user_id", u.ID))); err != nil {
		return waUser{}, err
	}
	w := waUser{u: u}
	for _, row := range rows {
		var cred webauthn.Credential
		if json.Unmarshal(row.Credential, &cred) == nil {
			w.creds = append(w.creds, cred)
		}
	}
	return w, nil
}

func (s *Server) hPasskeys(x *c) error {
	var rows []core.Passkey
	if err := s.st.List(x.ctx(), &rows, store.Q{Where: []store.Cond{store.Eq("user_id", x.user.ID)}, Order: "created_at"}); err != nil {
		return err
	}
	return x.ok(map[string]any{"passkeys": rows})
}

func (s *Server) passkeysOn(x *c) error {
	if !s.settingBool(x.ctx(), "auth.passkeys", true) {
		return errForbidden("passkeys are turned off on this install")
	}
	return nil
}

// hPasskeyRegisterStart begins adding a passkey to the signed-in account.
func (s *Server) hPasskeyRegisterStart(x *c) error {
	if err := s.passkeysOn(x); err != nil {
		return err
	}
	if x.sess == nil {
		return errForbidden("a passkey is added by its person, signed in")
	}
	wa, err := s.webauthn(x.r)
	if err != nil {
		return err
	}
	user, err := s.passkeyUser(x.ctx(), x.user)
	if err != nil {
		return err
	}
	var exclude []protocol.CredentialDescriptor
	for _, c := range user.creds {
		exclude = append(exclude, c.Descriptor())
	}
	opts, session, err := wa.BeginRegistration(user, webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithExclusions(exclude))
	if err != nil {
		return err
	}
	state, err := s.oneTime(x.ctx(), "passkey_register", x.user.ID, session, 10*time.Minute)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"options": opts, "state": state})
}

// hPasskeyRegisterFinish stores the passkey the browser made. The body is
// the browser's credential; the state comes in the query.
func (s *Server) hPasskeyRegisterFinish(x *c) error {
	ctx := x.ctx()
	ot, err := s.useOneTime(ctx, "passkey_register", x.r.URL.Query().Get("state"), false)
	if err != nil || ot.UserID != x.user.ID {
		return errBad("this passkey setup has expired; start again")
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(ot.Data, &session); err != nil {
		return err
	}
	wa, err := s.webauthn(x.r)
	if err != nil {
		return err
	}
	user, err := s.passkeyUser(ctx, x.user)
	if err != nil {
		return err
	}
	cred, err := wa.FinishRegistration(user, session, x.r)
	if err != nil {
		return errBad("the passkey could not be verified: %v", err)
	}
	raw, _ := json.Marshal(cred)
	name := strings.TrimSpace(x.r.URL.Query().Get("name"))
	if name == "" {
		name = "Passkey " + time.Now().UTC().Format("2006-01-02")
	}
	pk := core.Passkey{ID: id.New(), UserID: x.user.ID, Name: name, CredentialID: base64.RawURLEncoding.EncodeToString(cred.ID), Credential: raw,
		CreatedAt: time.Now().UnixMilli()}
	if err := s.st.Insert(ctx, pk); err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: "this passkey is already registered"}
	}
	s.audit(x.r, "", x.user, "passkey.added", "passkey", pk.ID, nil)
	return x.json(201, pk)
}

func (s *Server) hPasskeyRename(x *c) error {
	var b struct {
		Name string `json:"name"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	n, err := s.st.Update(x.ctx(), "passkeys", map[string]any{"name": strings.TrimSpace(b.Name)}, store.Eq("id", x.r.PathValue("id")), store.Eq("user_id", x.user.ID))
	if err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("passkey")
	}
	return x.ok(map[string]any{"ok": true})
}

// waysIn counts how a person can still sign in, so the last one is not
// taken away.
func (s *Server) waysIn(ctx context.Context, u core.User) int {
	n := 0
	if u.PasswordHash != "" {
		n++
	}
	p, _ := s.st.Count(ctx, "passkeys", store.Eq("user_id", u.ID))
	i, _ := s.st.Count(ctx, "identities", store.Eq("user_id", u.ID))
	return n + p + i
}

func (s *Server) hPasskeyDelete(x *c) error {
	ctx := x.ctx()
	if x.sess == nil {
		return errForbidden("a passkey is removed by its person, signed in")
	}
	if s.waysIn(ctx, x.user) <= 1 {
		return &engine.Error{Code: engine.CodeConflict, Message: "this is your only way to sign in; set a password or add another passkey first"}
	}
	n, err := s.st.Delete(ctx, "passkeys", store.Eq("id", x.r.PathValue("id")), store.Eq("user_id", x.user.ID))
	if err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("passkey")
	}
	s.audit(x.r, "", x.user, "passkey.removed", "passkey", x.r.PathValue("id"), nil)
	return x.ok(map[string]any{"ok": true})
}

// hPasskeyLoginStart begins a sign-in with a passkey. No name is asked for:
// the passkey says who it belongs to.
func (s *Server) hPasskeyLoginStart(x *c) error {
	if err := s.passkeysOn(x); err != nil {
		return err
	}
	wa, err := s.webauthn(x.r)
	if err != nil {
		return err
	}
	opts, session, err := wa.BeginDiscoverableLogin()
	if err != nil {
		return err
	}
	state, err := s.oneTime(x.ctx(), "passkey_login", "", session, 10*time.Minute)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"options": opts, "state": state})
}

func (s *Server) hPasskeyLoginFinish(x *c) error {
	ctx := x.ctx()
	if err := s.throttle(ctx, "login:ip:"+clientIP(x.r), 30, 15*time.Minute); err != nil {
		return err
	}
	ot, err := s.useOneTime(ctx, "passkey_login", x.r.URL.Query().Get("state"), false)
	if err != nil {
		return errBad("this sign-in has expired; try again")
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(ot.Data, &session); err != nil {
		return err
	}
	wa, err := s.webauthn(x.r)
	if err != nil {
		return err
	}
	var found core.User
	_, cred, err := wa.FinishPasskeyLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
		if err := s.st.Get(ctx, &found, store.Eq("id", string(userHandle)), store.Live); err != nil {
			return nil, err
		}
		return s.passkeyUser(ctx, found)
	}, session, x.r)
	if err != nil || found.ID == "" {
		s.audit(x.r, "", core.User{}, "signin.failed", "user", "", map[string]string{"method": "passkey"})
		return errUnauthorized("that passkey is not known here")
	}
	if found.DisabledAt != 0 {
		return errUnauthorized("this account is disabled")
	}
	// Keep the use counter, which lets a copied passkey be noticed.
	raw, _ := json.Marshal(cred)
	s.st.Update(ctx, "passkeys", map[string]any{"credential": json.RawMessage(raw), "last_used_at": time.Now().UnixMilli()},
		store.Eq("credential_id", base64.RawURLEncoding.EncodeToString(cred.ID)))
	return s.finishSignIn(x, found, "passkey")
}
