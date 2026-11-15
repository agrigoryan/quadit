package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
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
		m.HandleFunc("GET /api/v1/auth/oauth/{provider}/start", s.open(s.hOAuthStart))
		m.HandleFunc("GET /api/v1/auth/oauth/{provider}/callback", s.open(s.hOAuthCallback))
		m.HandleFunc("GET /api/v1/auth/identities", s.signed(s.hIdentities))
		m.HandleFunc("DELETE /api/v1/auth/identities/{id}", s.signed(s.hIdentityDelete))
	})
	providerList0 = func(s *Server, ctx context.Context) []map[string]string {
		out := []map[string]string{}
		for _, pid := range []string{"google", "github", "oidc"} {
			if cfg, ok := s.oauthConfig(ctx, pid); ok {
				out = append(out, map[string]string{"id": pid, "name": cfg.Name})
			}
		}
		return out
	}
}

// oauthSetting is one outside sign-in provider as set in the admin area.
type oauthSetting struct {
	Enabled      bool   `json:"enabled"`
	Name         string `json:"name"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Issuer       string `json:"issuer"` // OpenID Connect providers
	// For GitHub Enterprise, or tests: where the provider lives.
	AuthURL  string `json:"auth_url"`
	TokenURL string `json:"token_url"`
	APIURL   string `json:"api_url"`
}

func (s *Server) oauthConfig(ctx context.Context, provider string) (oauthSetting, bool) {
	var cfg oauthSetting
	if !has([]string{"google", "github", "oidc"}, provider) {
		return cfg, false
	}
	s.setting(ctx, "auth."+provider, &cfg)
	if !cfg.Enabled || cfg.ClientID == "" {
		return cfg, false
	}
	switch provider {
	case "google":
		cfg.Name, cfg.Issuer = "Google", "https://accounts.google.com"
	case "github":
		cfg.Name = "GitHub"
		if cfg.AuthURL == "" {
			cfg.AuthURL, cfg.TokenURL, cfg.APIURL = "https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token", "https://api.github.com"
		}
	case "oidc":
		if cfg.Name == "" {
			cfg.Name = "Single sign-on"
		}
		if cfg.Issuer == "" {
			return cfg, false
		}
	}
	return cfg, true
}

var (
	oidcMu        sync.Mutex
	oidcProviders = map[string]*oidc.Provider{}
)

// oidcProvider reads a provider's published configuration, once.
func oidcProvider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	oidcMu.Lock()
	defer oidcMu.Unlock()
	if p, ok := oidcProviders[issuer]; ok {
		return p, nil
	}
	p, err := oidc.NewProvider(context.WithoutCancel(ctx), issuer)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", issuer, err)
	}
	oidcProviders[issuer] = p
	return p, nil
}

func (s *Server) oauth2Config(ctx context.Context, provider string, cfg oauthSetting) (*oauth2.Config, *oidc.Provider, error) {
	oc := &oauth2.Config{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret,
		RedirectURL: s.cfg.BaseURL + "/api/v1/auth/oauth/" + provider + "/callback"}
	if provider == "github" {
		oc.Endpoint = oauth2.Endpoint{AuthURL: cfg.AuthURL, TokenURL: cfg.TokenURL}
		oc.Scopes = []string{"read:user", "user:email"}
		return oc, nil, nil
	}
	p, err := oidcProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, nil, err
	}
	oc.Endpoint = p.Endpoint()
	oc.Scopes = []string{oidc.ScopeOpenID, "email", "profile"}
	return oc, p, nil
}

type oauthState struct {
	Provider string `json:"provider"`
	Verifier string `json:"verifier"`
	Nonce    string `json:"nonce"`
	Next     string `json:"next"`
	Invite   string `json:"invite"`
	LinkUser string `json:"link_user"`
}

// hOAuthStart sends the browser to the provider to sign in.
func (s *Server) hOAuthStart(x *c) error {
	ctx := x.ctx()
	provider := x.r.PathValue("provider")
	cfg, ok := s.oauthConfig(ctx, provider)
	if !ok {
		return errNotFound("sign-in provider " + provider)
	}
	oc, _, err := s.oauth2Config(ctx, provider, cfg)
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

// outsider is who the provider says signed in.
type outsider struct {
	Subject  string
	Email    string
	Verified bool
	Name     string
}

func (s *Server) oauthIdentity(ctx context.Context, provider string, cfg oauthSetting, st oauthState, code string) (outsider, error) {
	var who outsider
	oc, p, err := s.oauth2Config(ctx, provider, cfg)
	if err != nil {
		return who, err
	}
	tok, err := oc.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return who, fmt.Errorf("the provider refused the sign-in: %w", err)
	}
	if provider == "github" {
		return githubIdentity(ctx, oc.Client(ctx, tok), cfg.APIURL)
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return who, errors.New("the provider sent no identity token")
	}
	idt, err := p.Verifier(&oidc.Config{ClientID: cfg.ClientID}).Verify(ctx, raw)
	if err != nil {
		return who, fmt.Errorf("the identity token did not verify: %w", err)
	}
	if idt.Nonce != st.Nonce {
		return who, errors.New("the identity token belongs to another sign-in")
	}
	var claims struct {
		Email    string `json:"email"`
		Verified *bool  `json:"email_verified"`
		Name     string `json:"name"`
		Username string `json:"preferred_username"`
	}
	if err := idt.Claims(&claims); err != nil {
		return who, err
	}
	who = outsider{Subject: idt.Subject, Email: strings.ToLower(claims.Email), Name: claims.Name, Verified: claims.Verified == nil || *claims.Verified}
	if who.Name == "" {
		who.Name = claims.Username
	}
	return who, nil
}

func githubIdentity(ctx context.Context, hc *http.Client, api string) (outsider, error) {
	var who outsider
	get := func(path string, dst any) error {
		req, _ := http.NewRequestWithContext(ctx, "GET", api+path, nil)
		req.Header.Set("Accept", "application/vnd.github+json")
		resp, err := hc.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if resp.StatusCode != 200 {
			return fmt.Errorf("GitHub answered %s", resp.Status)
		}
		return json.Unmarshal(body, dst)
	}
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
		Name  string `json:"name"`
	}
	if err := get("/user", &u); err != nil {
		return who, err
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	who = outsider{Subject: fmt.Sprint(u.ID), Name: u.Name}
	if who.Name == "" {
		who.Name = u.Login
	}
	if err := get("/user/emails", &emails); err != nil {
		// GitHub hides the list from a sign-in that was not given the
		// "user:email" permission, and says "not found".
		return who, fmt.Errorf("GitHub did not give this account's email addresses (%w); the sign-in must be allowed to read them (the user:email permission)", err)
	}
	for _, e := range emails {
		if e.Verified && (e.Primary || who.Email == "") {
			who.Email, who.Verified = strings.ToLower(e.Email), true
		}
	}
	return who, nil
}

// hOAuthCallback is where the provider sends the browser back. It finds or
// makes the account, signs it in, and returns to the app.
func (s *Server) hOAuthCallback(x *c) error {
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
	cfg, ok := s.oauthConfig(ctx, provider)
	if !ok || st.Provider != provider {
		return back("This sign-in provider is not available.")
	}
	who, err := s.oauthIdentity(ctx, provider, cfg, st, q.Get("code"))
	if err != nil {
		s.log.Error("oauth sign-in", "provider", provider, "err", err)
		return back("The provider could not confirm who you are.")
	}
	var u core.User
	var ident core.Identity
	link := func(userID string) error {
		return s.st.Insert(ctx, core.Identity{ID: id.New(), UserID: userID, Provider: provider, Subject: who.Subject, Email: who.Email, CreatedAt: time.Now().UnixMilli()})
	}
	switch err := s.st.Get(ctx, &ident, store.Eq("provider", provider), store.Eq("subject", who.Subject)); {
	case err == nil:
		if st.LinkUser != "" && st.LinkUser != ident.UserID {
			return back("That " + cfg.Name + " account is already connected to someone else.")
		}
		if err := s.st.Get(ctx, &u, store.Eq("id", ident.UserID), store.Live); err != nil {
			return back("That account no longer exists.")
		}
	case st.LinkUser != "":
		if err := s.st.Get(ctx, &u, store.Eq("id", st.LinkUser), store.Live); err != nil {
			return back("Sign in first, then connect the provider.")
		}
		if err := link(u.ID); err != nil {
			return err
		}
		s.audit(x.r, "", u, "identity.linked", "user", u.ID, map[string]string{"provider": provider})
	default:
		if who.Email == "" || !who.Verified {
			return back("Your " + cfg.Name + " account has no verified email address.")
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
				return back("There is no account for " + who.Email + ". Ask for an invitation.")
			}
			name := who.Name
			if name == "" {
				name = strings.SplitN(who.Email, "@", 2)[0]
			}
			if u, err = s.newPerson(ctx, name, who.Email, ""); err != nil {
				return back("An account could not be made for " + who.Email + ".")
			}
			s.audit(x.r, "", u, "account.registered", "user", u.ID, map[string]string{"provider": provider})
		}
		if err := link(u.ID); err != nil {
			return err
		}
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

func (s *Server) hIdentities(x *c) error {
	var rows []core.Identity
	if err := s.st.List(x.ctx(), &rows, store.Q{Where: []store.Cond{store.Eq("user_id", x.user.ID)}, Order: "created_at"}); err != nil {
		return err
	}
	return x.ok(map[string]any{"identities": rows})
}

func (s *Server) hIdentityDelete(x *c) error {
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
