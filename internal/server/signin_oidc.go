package server

// Sign-in with an OpenID Connect provider: Google, or one given by its issuer.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// oidcSignIn is sign-in with an OpenID Connect provider. Google is one
// whose name and address are known; the general one is given its issuer in
// the admin area.
type oidcSignIn struct {
	id string
	// name and issuer are set for a provider that is the same everywhere;
	// left empty, they are read from the setting.
	name, issuer string
}

func (p oidcSignIn) ID() string { return p.id }

func (p oidcSignIn) Configured(cfg *oauthSetting) bool {
	if p.issuer != "" {
		// A known provider says itself whether it verified an address.
		cfg.Name, cfg.Issuer, cfg.TrustEmail = p.name, p.issuer, false
		return true
	}
	if cfg.Name == "" {
		cfg.Name = "Single sign-on"
	}
	return cfg.Issuer != ""
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

func (p oidcSignIn) Endpoint(ctx context.Context, cfg oauthSetting) (oauth2.Endpoint, []string, error) {
	op, err := oidcProvider(ctx, cfg.Issuer)
	if err != nil {
		return oauth2.Endpoint{}, nil, err
	}
	return op.Endpoint(), []string{oidc.ScopeOpenID, "email", "profile"}, nil
}

// Identity checks the identity token that came with the access token: that
// the provider signed it, for this server, for this sign-in.
func (p oidcSignIn) Identity(ctx context.Context, cfg oauthSetting, _ *oauth2.Config, tok *oauth2.Token, nonce string) (outsider, error) {
	var who outsider
	// Read already, when the exchange that gave tok was set up.
	op, err := oidcProvider(ctx, cfg.Issuer)
	if err != nil {
		return who, err
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return who, errors.New("the provider sent no identity token")
	}
	idt, err := op.Verifier(&oidc.Config{ClientID: cfg.ClientID}).Verify(ctx, raw)
	if err != nil {
		return who, fmt.Errorf("the identity token did not verify: %w", err)
	}
	if idt.Nonce != nonce {
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
	who = outsider{Subject: idt.Subject, Email: strings.ToLower(claims.Email), Name: claims.Name, Verified: emailVerified(claims.Verified, cfg.TrustEmail)}
	if who.Name == "" {
		who.Name = claims.Username
	}
	return who, nil
}

// emailVerified says whether the provider's address is taken as verified:
// when the provider says so, or, when it says nothing, when the admin trusts
// its addresses.
func emailVerified(said *bool, trust bool) bool {
	if said == nil {
		return trust
	}
	return *said
}
