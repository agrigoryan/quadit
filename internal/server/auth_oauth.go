package server

import (
	"context"
	"encoding/json"
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

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/auth/oauth/{provider}/start", s.open(s.handleStartProviderSignIn))
		m.HandleFunc("GET /api/v1/auth/oauth/{provider}/callback", s.open(s.handleFinishProviderSignIn))
		m.HandleFunc("GET /api/v1/auth/identities", s.signed(s.handleListIdentities))
		m.HandleFunc("DELETE /api/v1/auth/identities/{id}", s.signed(s.handleUnlinkIdentity))
	})
}

type oauthState struct {
	Provider string `json:"provider"`
	Verifier string `json:"verifier"`
	Nonce    string `json:"nonce"`
	Next     string `json:"next"`
	Invite   string `json:"invite"`
	LinkUser string `json:"link_user"`
}

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
		return err
	}
	st := oauthState{Provider: provider, Verifier: oauth2.GenerateVerifier(), Nonce: id.New(), Next: x.r.URL.Query().Get("next"), Invite: x.r.URL.Query().Get("invite")}
	if !strings.HasPrefix(st.Next, "/") || strings.HasPrefix(st.Next, "//") {
		st.Next = "/"
	}
	// Someone already signed in is adding this provider to their account.
	if s.identify(x) == nil && x.sess != nil && x.r.URL.Query().Has("link") {
		st.LinkUser = x.user.ID
	}
	state, err := s.oneTime(ctx, "oauth", "", st, 15*time.Minute)
	if err != nil {
		return err
	}
	http.Redirect(x.w, x.r, oc.AuthCodeURL(state, oauth2.S256ChallengeOption(st.Verifier), oidc.Nonce(st.Nonce)), http.StatusFound)
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
		return back("The sign-in was cancelled.")
	}
	ot, err := s.useOneTime(ctx, "oauth", q.Get("state"), false)
	if err != nil {
		return back("This sign-in has expired. Try again.")
	}
	var st oauthState
	json.Unmarshal(ot.Data, &st)
	p, cfg, ok := s.signInWith(ctx, provider)
	if !ok || st.Provider != provider {
		return back("This sign-in provider is not available.")
	}
	who, err := s.oauthIdentity(ctx, p, cfg, st, q.Get("code"))
	if err != nil {
		s.log.Error("oauth sign-in", "provider", provider, "err", err)
		return back("The provider could not confirm who you are.")
	}
	u, refusal, err := s.oauthAccount(ctx, x, provider, cfg.Name, st, who)
	if err != nil {
		return err
	}
	if refusal != "" {
		return back(refusal)
	}
	if u.DisabledAt != 0 || u.Kind != core.KindPerson {
		return back("This account is disabled.")
	}
	if st.LinkUser == "" {
		stage := "full"
		if u.TOTPAt != 0 {
			stage = "mfa"
		}
		if err := s.startSession(x, u, stage); err != nil {
			return err
		}
		if stage == "mfa" {
			http.Redirect(x.w, x.r, "/login?second_step=1&next="+url.QueryEscape(st.Next), http.StatusFound)
			return nil
		}
		s.audit(x.r, "", u, "signin", "user", u.ID, map[string]string{"method": provider})
	}
	next := st.Next
	if st.Invite != "" {
		next = "/invite/" + st.Invite
	}
	http.Redirect(x.w, x.r, next, http.StatusFound)
	return nil
}

// oauthAccount finds the account a sign-in belongs to: the one the
// provider's account is already connected to, the one that is connecting
// it, or the one with the address the provider vouches for. Where there is
// none, it makes one if an invitation or open registration allows. refusal,
// when not empty, is what the person is told instead of being signed in.
func (s *Server) oauthAccount(ctx context.Context, x *c, provider, providerName string, st oauthState, who outsider) (core.User, string, error) {
	var u core.User
	var ident core.Identity
	link := func(userID string) error {
		return s.st.Insert(ctx, core.Identity{ID: id.New(), UserID: userID, Provider: provider, Subject: who.Subject, Email: who.Email, CreatedAt: time.Now().UnixMilli()})
	}
	switch err := s.st.Get(ctx, &ident, store.Eq("provider", provider), store.Eq("subject", who.Subject)); {
	case err == nil:
		if st.LinkUser != "" && st.LinkUser != ident.UserID {
			return u, "That " + providerName + " account is already connected to someone else.", nil
		}
		if err := s.st.Get(ctx, &u, store.Eq("id", ident.UserID), store.Live); err != nil {
			return u, "That account no longer exists.", nil
		}
	case st.LinkUser != "":
		if err := s.st.Get(ctx, &u, store.Eq("id", st.LinkUser), store.Live); err != nil {
			return u, "Sign in first, then connect the provider.", nil
		}
		if err := link(u.ID); err != nil {
			return u, "", err
		}
		s.audit(x.r, "", u, "identity.linked", "user", u.ID, map[string]string{"provider": provider})
	default:
		if who.Email == "" || !who.Verified {
			return u, "Your " + providerName + " account has no verified email address.", nil
		}
		if err := s.st.Get(ctx, &u, store.Eq("email", who.Email), store.Live); err != nil {
			// Nobody here yet: allowed only by an invitation or open registration.
			invited := false
			if st.Invite != "" {
				if inv, _, ierr := s.invite(ctx, st.Invite); ierr == nil && (inv.Email == "" || strings.EqualFold(inv.Email, who.Email)) {
					invited = true
				}
			}
			if !invited && (!s.settingBool(ctx, "auth.registration", false) || !s.emailAllowed(ctx, who.Email)) {
				return u, "There is no account for " + who.Email + ". Ask for an invitation.", nil
			}
			name := who.Name
			if name == "" {
				name = strings.SplitN(who.Email, "@", 2)[0]
			}
			if u, err = s.newPerson(ctx, name, who.Email, ""); err != nil {
				return u, "An account could not be made for " + who.Email + ".", nil
			}
			s.audit(x.r, "", u, "account.registered", "user", u.ID, map[string]string{"provider": provider})
		}
		if err := link(u.ID); err != nil {
			return u, "", err
		}
	}
	return u, "", nil
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
	if s.waysIn(ctx, x.user) <= 1 {
		return &engine.Error{Code: engine.CodeConflict, Message: "this is your only way to sign in; set a password or add a passkey first"}
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
