package server

// Sign-in with an outside provider: its routes, the account it signs in to, connected accounts.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// providerSignInRoutes are the routes of signing in with Google, GitHub or OpenID Connect, and of the accounts linked that way.
func (s *Server) providerSignInRoutes() []route {
	return []route{
		{"GET /api/v1/auth/oauth/{provider}/start", s.public(s.handleStartProviderSignIn), "Begin signing in with a provider: google, github or oidc.", "", "account"},
		{"GET /api/v1/auth/oauth/{provider}/callback", s.public(s.handleFinishProviderSignIn), "Where a provider sends the browser back after sign-in.", "", "account"},
		{"GET /api/v1/auth/identities", s.signedIn(s.handleListIdentities), "The provider accounts (Google, GitHub, OpenID Connect) linked to this one.", "", "account"},
		{"DELETE /api/v1/auth/identities/{id}", s.signedIn(s.handleUnlinkIdentity), "Unlink a provider account.", "", "account"},
	}
}

type oauthState struct {
	Provider string `json:"provider"`
	Verifier string `json:"verifier"`
	Nonce    string `json:"nonce"`
	Next     string `json:"next"`
	Invite   string `json:"invite"`
	LinkUser string `json:"link_user"`
}

// couldNotConfirm is what a person is told when the provider did not say,
// or could not be asked, who signed in.
const couldNotConfirm = "The provider could not confirm who you are."

// handleStartProviderSignIn sends the browser to the provider to sign in.
func (s *Server) handleStartProviderSignIn(x *c) error {
	ctx := x.ctx()
	provider := x.r.PathValue("provider")
	p, cfg, ok := s.signInWith(ctx, provider)
	if !ok {
		return errNotFound("sign-in provider " + provider)
	}
	oc, err := s.oauth2Config(ctx, p, cfg)
	if err != nil {
		// The provider did not say where it lives: the browser goes back to
		// the sign-in page, as when the provider cannot say who signed in.
		s.log.Error("oauth sign-in", "provider", provider, "err", err)
		http.Redirect(x.w, x.r, "/login?error="+url.QueryEscape(couldNotConfirm), http.StatusFound)
		return nil
	}
	state := oauthState{Provider: provider, Verifier: oauth2.GenerateVerifier(), Nonce: id.New(), Next: x.r.URL.Query().Get("next"), Invite: x.r.URL.Query().Get("invite")}
	if !strings.HasPrefix(state.Next, "/") || strings.HasPrefix(state.Next, "//") {
		state.Next = "/"
	}
	// Someone already signed in is adding this provider to their account.
	if s.identify(x.ctx(), x) == nil && x.sess != nil && x.r.URL.Query().Has("link") {
		state.LinkUser = x.user.ID
	}
	stateToken, err := s.oneTime(ctx, core.OneTimeOAuth, "", state, approvalLife)
	if err != nil {
		return err
	}
	http.Redirect(x.w, x.r, oc.AuthCodeURL(stateToken, oauth2.S256ChallengeOption(state.Verifier), oidc.Nonce(state.Nonce)), http.StatusFound)
	return nil
}

// handleFinishProviderSignIn is where the provider sends the browser back. It finds or
// makes the account, signs it in, and returns to the app.
func (s *Server) handleFinishProviderSignIn(x *c) error {
	ctx := x.ctx()
	provider := x.r.PathValue("provider")
	back := func(msg string) error {
		http.Redirect(x.w, x.r, "/login?error="+url.QueryEscape(msg), http.StatusFound)
		return nil
	}
	q := x.r.URL.Query()
	if e := q.Get("error"); e != "" {
		return back("The sign-in was cancelled.") //nolint:misspell // the words the person is shown, kept as they are
	}
	spent, err := s.useOneTime(ctx, core.OneTimeOAuth, q.Get("state"), false)
	if _, refused := errors.AsType[*engine.Error](err); err != nil && !refused {
		return err
	}
	if err != nil {
		return back("This sign-in has expired. Try again.")
	}
	var state oauthState
	if err := json.Unmarshal(spent.Data, &state); err != nil {
		s.log.Error("oauth sign-in: the stored state does not read", "provider", provider, "err", err)
		return back("This sign-in has expired. Try again.")
	}
	p, cfg, ok := s.signInWith(ctx, provider)
	if !ok || state.Provider != provider {
		return back("This sign-in provider is not available.")
	}
	who, err := s.oauthIdentity(ctx, p, cfg, state, q.Get("code"))
	if err != nil {
		s.log.Error("oauth sign-in", "provider", provider, "err", err)
		return back(couldNotConfirm)
	}
	u, refusal, err := s.oauthAccount(x, providerSignIn{provider: provider, providerName: cfg.Name, state: state, who: who})
	if err != nil {
		return err
	}
	if refusal != "" {
		return back(refusal)
	}
	if u.DisabledAt != 0 || u.Kind != core.KindPerson {
		return back("This account is disabled.")
	}
	if state.LinkUser == "" {
		secondStep, err := s.signIn(x, u, provider, false)
		if err != nil {
			return err
		}
		if secondStep {
			http.Redirect(x.w, x.r, "/login?second_step=1&next="+url.QueryEscape(state.Next), http.StatusFound)
			return nil
		}
	}
	next := state.Next
	if state.Invite != "" {
		next = "/invite/" + state.Invite
	}
	http.Redirect(x.w, x.r, next, http.StatusFound)
	return nil
}

// providerSignIn is one sign-in coming back from a provider: who the
// provider says signed in, and what the sign-in was started for.
type providerSignIn struct {
	provider     string // the provider's id
	providerName string
	state        oauthState
	who          outsider
}

// oauthAccount finds the account a sign-in belongs to: the one the
// provider's account is already connected to, the one that is connecting
// it, or the one with the address the provider vouches for. Where there is
// none, it makes one if an invitation or open registration allows. refusal,
// when not empty, is what the person is told instead of being signed in.
func (s *Server) oauthAccount(x *c, in providerSignIn) (u core.User, refusal string, err error) {
	var ident core.Identity
	there, err := store.Find(x.ctx(), s.st, &ident, store.Eq("provider", in.provider), store.Eq("subject", in.who.Subject))
	switch {
	case err != nil:
		return u, "", err
	case there:
		return s.connectedAccount(x.ctx(), in, ident)
	case in.state.LinkUser != "":
		return s.connectingAccount(x, in)
	default:
		return s.accountByEmail(x, in)
	}
}

// connectedAccount is the account a provider's account is connected to.
func (s *Server) connectedAccount(ctx context.Context, in providerSignIn, ident core.Identity) (u core.User, refusal string, err error) {
	if in.state.LinkUser != "" && in.state.LinkUser != ident.UserID {
		return u, "That " + in.providerName + " account is already connected to someone else.", nil
	}
	there, err := store.Find(ctx, s.st, &u, store.Eq("id", ident.UserID), store.Live)
	if err != nil {
		return u, "", err
	}
	if !there {
		return u, "That account no longer exists.", nil
	}
	return u, "", nil
}

// connectingAccount is the signed-in account that is connecting the
// provider's account, which is connected to it now.
func (s *Server) connectingAccount(x *c, in providerSignIn) (u core.User, refusal string, err error) {
	ctx := x.ctx()
	there, err := store.Find(ctx, s.st, &u, store.Eq("id", in.state.LinkUser), store.Live)
	if err != nil {
		return u, "", err
	}
	if !there {
		return u, "Sign in first, then connect the provider.", nil
	}
	if err := s.linkIdentity(ctx, in, u.ID); err != nil {
		return u, "", err
	}
	s.audit(x.r, "", u, "identity.linked", "user", u.ID, map[string]string{"provider": in.provider})
	return u, "", nil
}

// accountByEmail is the account with the address the provider vouches for,
// made when there is none and an invitation or open registration allows.
// The provider's account is connected to it.
func (s *Server) accountByEmail(x *c, in providerSignIn) (u core.User, refusal string, err error) {
	if in.who.Email == "" || !in.who.Verified {
		return u, "Your " + in.providerName + " account has no verified email address.", nil
	}
	there, err := store.Find(x.ctx(), s.st, &u, store.Eq("email", in.who.Email), store.Live)
	if err != nil {
		return u, "", err
	}
	if !there {
		// Nobody here yet: allowed only by an invitation or open registration.
		if u, refusal, err = s.newProviderAccount(x, in); err != nil || refusal != "" {
			return u, refusal, err
		}
	}
	if err := s.linkIdentity(x.ctx(), in, u.ID); err != nil {
		return u, "", err
	}
	return u, "", nil
}

// newProviderAccount makes an account for someone a provider vouches for,
// when an invitation or open registration allows.
func (s *Server) newProviderAccount(x *c, in providerSignIn) (u core.User, refusal string, err error) {
	ctx := x.ctx()
	email := in.who.Email
	invited, err := s.invitedAs(ctx, in.state.Invite, email)
	if err != nil {
		return u, "", err
	}
	if !invited {
		open, err := s.settings.CheckedBool(ctx, "auth.registration", false)
		if err != nil {
			return u, "", err
		}
		allowed := false
		if open {
			if allowed, err = s.emailAllowed(ctx, email); err != nil {
				return u, "", err
			}
		}
		if !allowed {
			return u, "There is no account for " + email + ". Ask for an invitation.", nil
		}
	}
	name := in.who.Name
	if name == "" {
		name = strings.SplitN(email, "@", 2)[0]
	}
	if u, err = s.newPerson(ctx, name, email, ""); err != nil {
		s.log.Warn("oauth sign-in: no account made", "provider", in.provider, "err", err)
		return u, "An account could not be made for " + email + ".", nil
	}
	s.audit(x.r, "", u, "account.registered", "user", u.ID, map[string]string{"provider": in.provider})
	return u, "", nil
}

// invitedAs reports whether an invitation's token, when there is one, lets
// in the person with this address.
func (s *Server) invitedAs(ctx context.Context, token, email string) (bool, error) {
	if token == "" {
		return false, nil
	}
	inv, _, err := s.invite(ctx, token)
	var refusal *engine.Error
	if errors.As(err, &refusal) && refusal.Code == engine.CodeNotFound {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return inv.Email == "" || strings.EqualFold(inv.Email, email), nil
}

// linkIdentity connects the provider's account to a person's.
func (s *Server) linkIdentity(ctx context.Context, in providerSignIn, userID string) error {
	return s.st.Insert(ctx, core.Identity{ID: id.New(), UserID: userID, Provider: in.provider, Subject: in.who.Subject, Email: in.who.Email, CreatedAt: time.Now().UnixMilli()})
}

func (s *Server) handleListIdentities(x *c) error {
	var rows []core.Identity
	if err := s.st.List(x.ctx(), &rows, store.Q{Where: []store.Cond{store.Eq("user_id", x.user.ID)}, Order: "created_at"}); err != nil {
		return err
	}
	return x.ok(map[string]any{"identities": rows})
}

func (s *Server) handleUnlinkIdentity(x *c) error {
	ctx := x.ctx()
	if x.sess == nil {
		return errForbidden("a connected account is removed by its person, signed in")
	}
	if err := s.keepsAWayIn(ctx, x.user, "this is your only way to sign in; set a password or add a passkey first"); err != nil {
		return err
	}
	n, err := s.st.Delete(ctx, "identities", store.Eq("id", x.r.PathValue("id")), store.Eq("user_id", x.user.ID))
	if err != nil {
		return err
	}
	if n == 0 {
		return errNotFound("connected account")
	}
	s.audit(x.r, "", x.user, "identity.unlinked", "user", x.user.ID, nil)
	return x.ok(map[string]any{"ok": true})
}
