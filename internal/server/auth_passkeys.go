package server

// Passkeys: adding them to an account and signing in with them.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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

// passkeyRoutes are the routes of adding, naming and signing in with passkeys.
func (s *Server) passkeyRoutes() []route {
	return []route{
		{"GET /api/v1/auth/passkeys", s.settingUpSecondStep(s.handleListPasskeys), "The account's passkeys.", "", "account"},
		{"POST /api/v1/auth/passkeys/register/start", s.settingUpSecondStep(s.handleStartPasskeyRegistration), "Begin adding a passkey: answers with what the browser's WebAuthn call needs.", "", "account"},
		{"POST /api/v1/auth/passkeys/register/finish", s.settingUpSecondStep(s.handleFinishPasskeyRegistration), "Finish adding a passkey with the browser's answer.", "", "account"},
		{"PATCH /api/v1/auth/passkeys/{id}", s.signedIn(s.handleRenamePasskey), "Rename a passkey. Body: {name}.", "", "account"},
		{"DELETE /api/v1/auth/passkeys/{id}", s.signedIn(s.handleDeletePasskey), "Remove a passkey.", "", "account"},
		{"POST /api/v1/auth/passkeys/login/start", s.public(s.handleStartPasskeySignIn), "Begin signing in with a passkey.", "", "account"},
		{"POST /api/v1/auth/passkeys/login/finish", s.public(s.handleFinishPasskeySignIn), "Finish signing in with a passkey.", "", "account"},
	}
}

// passkeyStateLife is how long the browser has to finish adding a passkey,
// or signing in with one, once started.
const passkeyStateLife = 10 * time.Minute

// webAuthnUser is a person as the WebAuthn library wants to see one.
type webAuthnUser struct {
	u     core.User
	creds []webauthn.Credential
}

func (w webAuthnUser) WebAuthnID() []byte                         { return []byte(w.u.ID) }
func (w webAuthnUser) WebAuthnName() string                       { return w.u.Email }
func (w webAuthnUser) WebAuthnDisplayName() string                { return w.u.Name }
func (w webAuthnUser) WebAuthnCredentials() []webauthn.Credential { return w.creds }

// webauthn builds the relying party for this request. The party is the
// host people reach the server on; a local dev server on another port of
// localhost is let in too.
//
// Every ceremony requires the device to check who holds it (user
// verification: a fingerprint, a face, a PIN), and the check is verified
// here, not taken from the browser: a passkey is then something the person
// has and something they are or know, which is why signing in with one is
// both steps at once (finishSignIn). A device that cannot check, a
// security key with no PIN, adds no passkey and signs nobody in. Asking
// for the check only where it is offered, and counting a passkey that
// skipped it as one step, would leave such a person with no second step to
// give where the install requires two: the passkey is the one they have.
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
	return webauthn.New(&webauthn.Config{RPID: base.Hostname(), RPDisplayName: s.installName(r.Context()), RPOrigins: origins,
		AuthenticatorSelection: protocol.AuthenticatorSelection{UserVerification: protocol.VerificationRequired}})
}

func (s *Server) passkeyUser(ctx context.Context, u core.User) (webAuthnUser, error) {
	var rows []core.Passkey
	if err := s.st.List(ctx, &rows, store.Where(store.Eq("user_id", u.ID))); err != nil {
		return webAuthnUser{}, err
	}
	w := webAuthnUser{u: u}
	for _, row := range rows {
		var cred webauthn.Credential
		if json.Unmarshal(row.Credential, &cred) == nil {
			w.creds = append(w.creds, cred)
		}
	}
	return w, nil
}

func (s *Server) handleListPasskeys(x *c) error {
	var rows []core.Passkey
	if err := s.st.List(x.ctx(), &rows, store.Q{Where: []store.Cond{store.Eq("user_id", x.user.ID)}, Order: "created_at"}); err != nil {
		return err
	}
	return x.ok(map[string]any{"passkeys": rows})
}

func (s *Server) passkeysOn(x *c) error {
	on, err := s.settings.CheckedBool(x.ctx(), "auth.passkeys", true)
	if err != nil {
		return err
	}
	if !on {
		return errForbidden("passkeys are turned off on this install")
	}
	return nil
}

// handleStartPasskeyRegistration begins adding a passkey to the signed-in account.
func (s *Server) handleStartPasskeyRegistration(x *c) error {
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
	for _, cred := range user.creds {
		exclude = append(exclude, cred.Descriptor())
	}
	opts, session, err := wa.BeginRegistration(user, webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithExclusions(exclude))
	if err != nil {
		return err
	}
	state, err := s.oneTime(x.ctx(), core.OneTimePasskeyRegister, x.user.ID, session, passkeyStateLife)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"options": opts, "state": state})
}

// handleFinishPasskeyRegistration stores the passkey the browser made. The body is
// the browser's credential; the state comes in the query.
func (s *Server) handleFinishPasskeyRegistration(x *c) error {
	ctx := x.ctx()
	spent, err := s.useOneTime(ctx, core.OneTimePasskeyRegister, x.r.URL.Query().Get("state"))
	if _, refused := errors.AsType[*engine.Error](err); err != nil && !refused {
		return err
	}
	if err != nil || spent.UserID != x.user.ID {
		return errBad("this passkey setup has expired; start again")
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(spent.Data, &session); err != nil {
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
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(x.r.URL.Query().Get("name"))
	if name == "" {
		name = "Passkey " + time.Now().UTC().Format(time.DateOnly)
	}
	pk := core.Passkey{ID: id.New(), UserID: x.user.ID, Name: name, CredentialID: base64.RawURLEncoding.EncodeToString(cred.ID), Credential: raw,
		CreatedAt: time.Now().UnixMilli()}
	hadOne, err := s.hasSecondStep(ctx, x.user)
	if err != nil {
		return err
	}
	if err := s.st.Insert(ctx, pk); err != nil {
		return &engine.Error{Code: engine.CodeConflict, Message: "this passkey is already registered"}
	}
	if err := s.tookTwoSteps(ctx, x, hadOne); err != nil {
		return err
	}
	s.audit(x.r, "", x.user, "passkey.added", "passkey", pk.ID, nil)
	return x.json(201, pk)
}

func (s *Server) handleRenamePasskey(x *c) error {
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

// signInWayCount counts how a person can still sign in, so the last one is not
// taken away.
func (s *Server) signInWayCount(ctx context.Context, u core.User) (int, error) {
	n := 0
	if u.PasswordHash != "" {
		n++
	}
	passkeys, err := s.st.Count(ctx, "passkeys", store.Eq("user_id", u.ID))
	if err != nil {
		return 0, err
	}
	identities, err := s.st.Count(ctx, "identities", store.Eq("user_id", u.ID))
	if err != nil {
		return 0, err
	}
	return n + passkeys + identities, nil
}

// keepsAWayIn refuses taking a way of signing in from a person who has no
// other; refusal is what they are told then.
func (s *Server) keepsAWayIn(ctx context.Context, u core.User, refusal string) error {
	n, err := s.signInWayCount(ctx, u)
	if err != nil {
		return err
	}
	if n <= 1 {
		return &engine.Error{Code: engine.CodeConflict, Message: refusal}
	}
	return nil
}

func (s *Server) handleDeletePasskey(x *c) error {
	ctx := x.ctx()
	if x.sess == nil {
		return errForbidden("a passkey is removed by its person, signed in")
	}
	if err := s.keepsAWayIn(ctx, x.user, "this is your only way to sign in; set a password or add another passkey first"); err != nil {
		return err
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

// handleStartPasskeySignIn begins a sign-in with a passkey. No name is asked for:
// the passkey says who it belongs to.
func (s *Server) handleStartPasskeySignIn(x *c) error {
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
	state, err := s.oneTime(x.ctx(), core.OneTimePasskeyLogin, "", session, passkeyStateLife)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"options": opts, "state": state})
}

// handleFinishPasskeySignIn checks the passkey the browser signed with and
// signs its person in.
func (s *Server) handleFinishPasskeySignIn(x *c) error {
	ctx := x.ctx()
	if err := s.throttle(ctx, "login:ip:"+s.clientIP(x.r), signInsPerIP, signInWindow); err != nil {
		return err
	}
	spent, err := s.useOneTime(ctx, core.OneTimePasskeyLogin, x.r.URL.Query().Get("state"))
	if _, refused := errors.AsType[*engine.Error](err); err != nil && !refused {
		return err
	}
	if err != nil {
		return errBad("this sign-in has expired; try again")
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(spent.Data, &session); err != nil {
		return err
	}
	wa, err := s.webauthn(x.r)
	if err != nil {
		return err
	}
	var found core.User
	_, cred, err := wa.FinishPasskeyLogin(func(_, userHandle []byte) (webauthn.User, error) {
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
	if err := s.recordPasskeyUse(ctx, cred); err != nil {
		s.log.Error("passkey use not recorded; a copy of it is noticed later", "err", err)
	}
	return s.finishSignIn(x, found, "passkey")
}

// recordPasskeyUse stores a passkey's credential as of its last use, with
// its counter.
func (s *Server) recordPasskeyUse(ctx context.Context, cred *webauthn.Credential) error {
	raw, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	_, err = s.st.Update(ctx, "passkeys", map[string]any{"credential": json.RawMessage(raw), "last_used_at": time.Now().UnixMilli()},
		store.Eq("credential_id", base64.RawURLEncoding.EncodeToString(cred.ID)))
	return err
}
