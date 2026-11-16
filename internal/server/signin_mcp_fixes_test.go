package server_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/agrigoryan/quadit/internal/server"
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

// TestGitHubSignInGivesUp: a GitHub that takes the token but never says
// who it belongs to ends the sign-in, as any other failure to confirm who
// signed in does, within the time GitHub is given.
func TestGitHubSignInGivesUp(t *testing.T) {
	was := *server.GitHubTimeout
	*server.GitHubTimeout = 300 * time.Millisecond
	t.Cleanup(func() { *server.GitHubTimeout = was })
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		mux := http.NewServeMux()
		mux.HandleFunc("/login/oauth/authorize", func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			http.Redirect(w, r, q.Get("redirect_uri")+"?code=the-code&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
		})
		mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"access_token":"gho_fake123","token_type":"bearer","scope":"read:user,user:email"}`))
		})
		mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
			// Silent until the asker gives up, or long past the time it has.
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
				json.NewEncoder(w).Encode(M{"id": 1, "login": "slow"})
			}
		})
		gh := httptest.NewServer(mux)
		t.Cleanup(gh.Close)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.github", M{"enabled": true, "client_id": "Iv1.abc", "client_secret": "s3cret",
			"auth_url": gh.URL + "/login/oauth/authorize", "token_url": gh.URL + "/login/oauth/access_token", "api_url": gh.URL}, 200, nil)
		start := time.Now()
		resp, err := browser().Get(s.url + "/api/v1/auth/oauth/github/start")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		want := "/login?error=" + url.QueryEscape("The provider could not confirm who you are.")
		if got := resp.Request.URL.RequestURI(); got != want {
			t.Fatalf("sign-in ended at %s after %s, want %s", got, time.Since(start), want)
		}
		if took := time.Since(start); took > 3*time.Second {
			t.Fatalf("the sign-in waited %s for GitHub", took)
		}
	})
}

// mcpPost sends one body to /mcp as the bearer of token.
func mcpPost(t *testing.T, s *site, token, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, s.url+"/mcp", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, string(raw)
}

// mcpAgentToken is a token of an agent of the test site.
func mcpAgentToken(s *site) string {
	s.change(s.owner, "", "agent.create", M{"name": "Writer", "handle": "writer"})
	var tok struct{ Token string }
	s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@writer"}, 201, &tok)
	return tok.Token
}

// TestMCPToolListIsStable: tools/list answers the same, byte for byte,
// every time it is asked, so a client can tell nothing changed.
func TestMCPToolListIsStable(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	token := mcpAgentToken(s)
	_, first := mcpPost(t, s, token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if !strings.Contains(first, `"secret_request"`) {
		t.Fatalf("tools/list = %.200s", first)
	}
	for i := range 50 {
		if _, again := mcpPost(t, s, token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); again != first {
			t.Fatalf("tools/list answered differently the %d. time", i+2)
		}
	}
}

// TestMCPParseErrorIsJSON: a body that is not JSON-RPC is answered with the
// parse error, as JSON.
func TestMCPParseErrorIsJSON(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	resp, body := mcpPost(t, s, mcpAgentToken(s), `this is not json`)
	if !strings.Contains(body, "-32700") {
		t.Fatalf("answer = %s", body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("the parse error came as %q", ct)
	}
}
