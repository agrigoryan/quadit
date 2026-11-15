package server

import (
	"context"
	"fmt"
	"strings"

	"golang.org/x/oauth2"
)

// Sign-in with an outside provider is laid out like this:
//
//	auth_oauth.go       the routes: start, callback, a person's connected accounts
//	signin_provider.go  the signInProvider interface, the list of providers,
//	                    and what every provider shares: its setting, the
//	                    OAuth 2 exchange
//	signin_oidc.go      OpenID Connect: Google, and any provider given by its issuer
//	signin_github.go    GitHub

// signInProvider is one outside service people can sign in with. Each kind
// is in its own file; adding one means writing that file, naming it in
// signInProviders below, and adding its setting to the tables of settings
// (settingSecrets and settingShapes).
type signInProvider interface {
	// ID is the name the provider goes by: its setting is "auth.<id>", its
	// routes are under /api/v1/auth/oauth/<id>/, and a connected account
	// is stored under it.
	ID() string
	// Configured fills in what the provider knows without being told (its
	// name, where it lives) and reports whether the setting is enough to
	// sign in with.
	Configured(cfg *oauthSetting) bool
	// Endpoint says where the browser is sent and where its code is
	// exchanged, and what the provider is asked to share.
	Endpoint(ctx context.Context, cfg oauthSetting) (oauth2.Endpoint, []string, error)
	// Identity reads who signed in, from the token the provider gave for
	// the code. nonce is the one this sign-in was started with.
	Identity(ctx context.Context, cfg oauthSetting, oc *oauth2.Config, tok *oauth2.Token, nonce string) (outsider, error)
}

var signInProviders = []signInProvider{
	oidcSignIn{id: "google", name: "Google", issuer: "https://accounts.google.com"},
	githubSignIn{},
	oidcSignIn{id: "oidc"},
}

// signInProviderFor finds a provider by its id; nil when there is none.
func signInProviderFor(provider string) signInProvider {
	for _, p := range signInProviders {
		if p.ID() == provider {
			return p
		}
	}
	return nil
}

// signInSetting reports whether a setting is that of a sign-in provider.
func signInSetting(name string) bool {
	id, ok := strings.CutPrefix(name, "auth.")
	return ok && signInProviderFor(id) != nil
}

// oauthSetting is one outside sign-in provider as set in the admin area.
type oauthSetting struct {
	Enabled      bool   `json:"enabled"`
	Name         string `json:"name"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Issuer       string `json:"issuer"` // OpenID Connect providers
	// TrustEmail takes the address of a general OpenID Connect provider as
	// verified when the provider does not say whether it is.
	TrustEmail bool `json:"trust_email"`
	// For GitHub Enterprise, or tests: where the provider lives.
	AuthURL  string `json:"auth_url"`
	TokenURL string `json:"token_url"`
	APIURL   string `json:"api_url"`
	// version is this server's, for a provider asked with a client that
	// says who is asking; it is not stored.
	version string
}

// outsider is who the provider says signed in.
type outsider struct {
	Subject  string
	Email    string
	Verified bool
	Name     string
}

// signInWith gives a provider and its setting, when it is turned on and set
// up enough to sign in with.
func (s *Server) signInWith(ctx context.Context, provider string) (signInProvider, oauthSetting, bool) {
	var cfg oauthSetting
	p := signInProviderFor(provider)
	if p == nil {
		return nil, cfg, false
	}
	s.setting(ctx, "auth."+provider, &cfg)
	cfg.version = s.cfg.Version
	if !cfg.Enabled || cfg.ClientID == "" {
		return p, cfg, false
	}
	return p, cfg, p.Configured(&cfg)
}

// oauthConfig is signInWith for those who need only the setting.
func (s *Server) oauthConfig(ctx context.Context, provider string) (oauthSetting, bool) {
	_, cfg, ok := s.signInWith(ctx, provider)
	return cfg, ok
}

// providerList names the outside sign-in providers that are turned on.
func (s *Server) providerList(ctx context.Context) []map[string]string {
	out := []map[string]string{}
	for _, p := range signInProviders {
		if cfg, ok := s.oauthConfig(ctx, p.ID()); ok {
			out = append(out, map[string]string{"id": p.ID(), "name": cfg.Name})
		}
	}
	return out
}

// oauth2Config is this server as a client of the provider: who it says it
// is, where the provider sends the browser back, and where the provider
// lives.
func (s *Server) oauth2Config(ctx context.Context, p signInProvider, cfg oauthSetting) (*oauth2.Config, error) {
	oc := &oauth2.Config{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret,
		RedirectURL: s.cfg.BaseURL + "/api/v1/auth/oauth/" + p.ID() + "/callback"}
	var err error
	if oc.Endpoint, oc.Scopes, err = p.Endpoint(ctx, cfg); err != nil {
		return nil, err
	}
	return oc, nil
}

// oauthIdentity trades the code the provider sent the browser back with
// for who signed in.
func (s *Server) oauthIdentity(ctx context.Context, p signInProvider, cfg oauthSetting, st oauthState, code string) (outsider, error) {
	var who outsider
	oc, err := s.oauth2Config(ctx, p, cfg)
	if err != nil {
		return who, err
	}
	tok, err := oc.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return who, fmt.Errorf("the provider refused the sign-in: %w", err)
	}
	return p.Identity(ctx, cfg, oc, tok, st.Nonce)
}
