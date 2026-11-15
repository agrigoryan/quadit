package server_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// fakeOIDCSaying is an OpenID Connect provider that signs in whoever asks as
// subject with email, and says of the address what verified says: true,
// false, or, when nil, nothing at all.
func fakeOIDCSaying(t *testing.T, subject, email string, verified *bool) *httptest.Server {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(M{"issuer": srv.URL, "authorization_endpoint": srv.URL + "/auth", "token_endpoint": srv.URL + "/token",
			"jwks_uri": srv.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		http.Redirect(w, r, q.Get("redirect_uri")+"?state="+url.QueryEscape(q.Get("state"))+"&code="+url.QueryEscape(q.Get("nonce")), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		now := time.Now()
		claims := M{"iss": srv.URL, "sub": subject, "aud": "quadit-client", "exp": now.Add(time.Hour).Unix(),
			"iat": now.Unix(), "nonce": r.Form.Get("code"), "email": email, "name": "Mallory"}
		if verified != nil {
			claims["email_verified"] = *verified
		}
		raw, err := jwt.Signed(signer).Claims(claims).Serialize()
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(M{"access_token": "at", "token_type": "Bearer", "id_token": raw, "expires_in": 3600})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// TestOIDCUnsaidVerificationIsNotTrusted: a provider that does not say an
// address is verified does not get to sign in as the account with that
// address, unless the admin said its addresses can be trusted.
func TestOIDCUnsaidVerificationIsNotTrusted(t *testing.T) {
	yes, no := true, false
	refused := "/login?error=" + url.QueryEscape("Your Company SSO account has no verified email address.")
	for _, tc := range []struct {
		name     string
		verified *bool
		trust    bool
		signedIn bool
	}{
		{"not said", nil, false, false},
		{"not said, trusted", nil, true, true},
		{"false, trusted", &no, true, false},
		{"true", &yes, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testdb.Each(t, func(t *testing.T, st store.Store) {
				s := newSite(t, st)
				// The owner's own address, claimed through the provider.
				idp := fakeOIDCSaying(t, "subject-"+tc.name, "owner@example.com", tc.verified)
				setting := M{"enabled": true, "name": "Company SSO", "issuer": idp.URL, "client_id": "quadit-client", "client_secret": "s3cret"}
				if tc.trust {
					setting["trust_email"] = true
				}
				s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.oidc", setting, 200, nil)
				b := browser()
				resp, err := b.Get(s.url + "/api/v1/auth/oauth/oidc/start")
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if tc.signedIn {
					s.call(b, "", "GET", "/api/v1/auth/me", nil, 200, nil)
					return
				}
				if got := resp.Request.URL.RequestURI(); got != refused {
					t.Fatalf("sign-in ended at %s, want %s", got, refused)
				}
				s.call(b, "", "GET", "/api/v1/auth/me", nil, 401, nil)
			})
		})
	}
}

// TestOIDCConnectedAccountNeedsNoVerifiedAddress: someone whose account is
// already connected to the provider signs in with it, whatever the provider
// says of the address, as before.
func TestOIDCConnectedAccountNeedsNoVerifiedAddress(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		idp := fakeOIDCSaying(t, "subject-owner", "someone@elsewhere.org", nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.oidc", M{"enabled": true, "name": "Company SSO", "issuer": idp.URL,
			"client_id": "quadit-client", "client_secret": "s3cret"}, 200, nil)
		// The owner, signed in, connects the provider to the account.
		resp, err := s.owner.Get(s.url + "/api/v1/auth/oauth/oidc/start?link=1")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		var ids struct {
			Identities []struct{ Provider string }
		}
		s.call(s.owner, "", "GET", "/api/v1/auth/identities", nil, 200, &ids)
		if len(ids.Identities) != 1 || ids.Identities[0].Provider != "oidc" {
			t.Fatalf("connected accounts: %+v", ids)
		}
		// Later the provider alone signs the owner in.
		b := browser()
		resp, _ = b.Get(s.url + "/api/v1/auth/oauth/oidc/start")
		resp.Body.Close()
		var me struct{ Email string }
		s.call(b, "", "GET", "/api/v1/auth/me", nil, 200, &me)
	})
}
