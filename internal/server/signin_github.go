package server

// Sign-in with GitHub.

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"golang.org/x/oauth2"
)

// githubSignIn is sign-in with GitHub, which is OAuth 2 without an identity
// token: who signed in is asked of GitHub's API with the access token.
type githubSignIn struct{}

func (githubSignIn) ID() string { return "github" }

func (githubSignIn) Configured(cfg *oauthSetting) bool {
	cfg.Name = "GitHub"
	if cfg.AuthURL == "" {
		cfg.AuthURL, cfg.TokenURL, cfg.APIURL = "https://github.com/login/oauth/authorize", "https://github.com/login/oauth/access_token", "https://api.github.com"
	}
	return true
}

func (githubSignIn) Endpoint(_ context.Context, cfg oauthSetting) (oauth2.Endpoint, []string, error) {
	return oauth2.Endpoint{AuthURL: cfg.AuthURL, TokenURL: cfg.TokenURL}, []string{"read:user", "user:email"}, nil
}

func (githubSignIn) Identity(ctx context.Context, cfg oauthSetting, oc *oauth2.Config, tok *oauth2.Token, _ string) (outsider, error) {
	return githubIdentity(ctx, oc.Client(ctx, tok), cfg.APIURL, cfg.version)
}

// githubIdentity asks GitHub whose token hc carries: the account, and the
// address GitHub has verified for it. version is this server's.
func githubIdentity(ctx context.Context, hc *http.Client, api, version string) (outsider, error) {
	var who outsider
	gh := newGitHubClient(hc, api, version)
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
		Name  string `json:"name"`
	}
	if err := gh.call(ctx, "GET", "/user", nil, &u); err != nil {
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
	if err := gh.call(ctx, "GET", "/user/emails", nil, &emails); err != nil {
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
