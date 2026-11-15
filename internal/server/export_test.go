package server

import (
	"context"

	"golang.org/x/oauth2"
)

// LimitFactor is how far the request limits are scaled from their defaults
// (1 = the defaults), for tests.
func (s *Server) LimitFactor() float64 {
	s.limits.mu.Lock()
	defer s.limits.mu.Unlock()
	return s.limits.factor
}

// RoutePatterns are the patterns of every route the server answers, as
// the mux has them.
func (s *Server) RoutePatterns() []string {
	var patterns []string
	for _, rt := range s.allRoutes() {
		patterns = append(patterns, rt.pattern)
	}
	return patterns
}

// GitHubTimeout is how long one request to GitHub may take, for tests to shorten.
var GitHubTimeout = &githubTimeout

// GitHubIdentity reads who a GitHub token belongs to, the way sign-in with
// GitHub does, for a test against the real service.
func GitHubIdentity(ctx context.Context, token, api string) (subject, name string, hasVerifiedEmail bool, err error) {
	hc := oauth2.NewClient(ctx, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: token}))
	who, err := githubIdentity(ctx, hc, api, "test")
	return who.Subject, who.Name, who.Email != "" && who.Verified, err
}

// GoogleEndpoints asks Google where sign-in happens, as sign-in with Google
// does when it starts.
func (s *Server) GoogleEndpoints(ctx context.Context) (authURL, tokenURL string, err error) {
	oc, err := s.oauth2Config(ctx, signInProviderFor("google"), oauthSetting{ClientID: "test", Issuer: "https://accounts.google.com"})
	if err != nil {
		return "", "", err
	}
	return oc.Endpoint.AuthURL, oc.Endpoint.TokenURL, nil
}
