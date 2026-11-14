package server_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

func browser() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func TestSecondStepInvitesAndSettings(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)

		// Two-step codes: set up, sign in again, and the session waits.
		var setup struct{ Secret, URL string }
		s.call(s.owner, "", "POST", "/api/v1/auth/totp/start", M{}, 200, &setup)
		if !strings.HasPrefix(setup.URL, "otpauth://totp/") {
			t.Fatalf("setup = %+v", setup)
		}
		s.call(s.owner, "", "POST", "/api/v1/auth/totp/enable", M{"code": "000000"}, 400, nil)
		var enabled struct {
			Codes []string `json:"recovery_codes"`
		}
		s.call(s.owner, "", "POST", "/api/v1/auth/totp/enable", M{"code": auth.TOTPCode(setup.Secret, time.Now())}, 200, &enabled)
		if len(enabled.Codes) != 10 {
			t.Fatalf("recovery codes = %v", enabled.Codes)
		}
		b := browser()
		var first struct {
			SecondStep bool `json:"second_step"`
		}
		s.call(b, "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": "correct-horse-battery"}, 200, &first)
		if !first.SecondStep {
			t.Fatal("sign-in did not ask for the second step")
		}
		if out := s.call(b, "", "GET", "/api/v1/auth/me", nil, 401, nil); !strings.Contains(out, "second_step") {
			t.Fatalf("half-signed-in session got in: %s", out)
		}
		s.call(b, "", "POST", "/api/v1/auth/second-step", M{"code": "123456"}, 401, nil)
		// A recovery code works, once.
		s.call(b, "", "POST", "/api/v1/auth/second-step", M{"code": enabled.Codes[0]}, 200, nil)
		s.call(b, "", "GET", "/api/v1/auth/me", nil, 200, nil)
		b2 := browser()
		s.call(b2, "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": "correct-horse-battery"}, 200, nil)
		s.call(b2, "", "POST", "/api/v1/auth/second-step", M{"code": enabled.Codes[0]}, 401, nil)

		// Settings: secrets go in, never come back, and members cannot look.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/mail", M{"host": "smtp.example.com", "from": "q@example.com", "password": "hunter2"}, 200, nil)
		if out := s.call(s.owner, "", "GET", "/api/v1/admin/settings", nil, 200, nil); strings.Contains(out, "hunter2") || !strings.Contains(out, "smtp.example.com") {
			t.Fatalf("settings leak or lose values: %s", out)
		}
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/nope", M{}, 400, nil)

		// An invitation: a stranger opens the link and joins with a role.
		var inv struct{ Link string }
		s.call(s.owner, "", "POST", w+"/invites", M{"role": "admin"}, 201, &inv)
		token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
		guest := browser()
		if out := s.call(guest, "", "GET", "/api/v1/auth/invite/"+token, nil, 200, nil); !strings.Contains(out, `"name":"Games"`) {
			t.Fatalf("invite = %s", out)
		}
		s.call(guest, "", "POST", "/api/v1/auth/invite/"+token, M{"name": "Bea", "email": "bea@example.com", "password": "another-long-password"}, 200, nil)
		var me struct{ Role, Handle string }
		s.call(guest, "", "GET", w+"/me", nil, 200, &me)
		if me.Role != "admin" || me.Handle != "@bea" {
			t.Fatalf("joined as %+v", me)
		}
		// The link was for one person.
		s.call(browser(), "", "POST", "/api/v1/auth/invite/"+token, M{"name": "Cy", "email": "cy@example.com", "password": "another-long-password"}, 404, nil)
		// Bea is a workspace admin, not an install admin.
		s.call(guest, "", "GET", "/api/v1/admin/settings", nil, 403, nil)
		s.call(guest, "", "GET", w+"/audit", nil, 200, nil)

		// Registration is closed until the switch is on, then limited by domain.
		reg := M{"name": "Dee", "email": "dee@elsewhere.org", "password": "another-long-password"}
		s.call(nil, "", "POST", "/api/v1/auth/register", reg, 403, nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.registration", true, 200, nil)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.allowed_domains", []string{"example.com"}, 200, nil)
		s.call(nil, "", "POST", "/api/v1/auth/register", reg, 403, nil)
		reg["email"] = "dee@example.com"
		s.call(browser(), "", "POST", "/api/v1/auth/register", reg, 201, nil)

		// Requiring the second step locks out those without one.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.require_2fa", true, 200, nil)
		if out := s.call(guest, "", "GET", w+"/me", nil, 403, nil); !strings.Contains(out, "second_step_required") {
			t.Fatalf("require_2fa not enforced: %s", out)
		}
		s.call(s.owner, "", "GET", w+"/me", nil, 200, nil)

		// The audit log saw it all, and exports.
		out := s.call(s.owner, "", "GET", "/api/v1/admin/audit?limit=500", nil, 200, nil)
		for _, want := range []string{"install.setup", "second_step.enabled", "invite.accepted", "setting.changed", "signin"} {
			if !strings.Contains(out, want) {
				t.Errorf("audit log misses %s", want)
			}
		}
		if csv := s.call(s.owner, "", "GET", "/api/v1/admin/audit?format=csv", nil, 200, nil); !strings.HasPrefix(csv, "time,actor,action") {
			t.Fatalf("csv export = %.80s", csv)
		}
		// Passkey sign-in starts without knowing who is asking.
		if out := s.call(nil, "", "POST", "/api/v1/auth/passkeys/login/start", M{}, 200, nil); !strings.Contains(out, "challenge") {
			t.Fatalf("passkey start = %s", out)
		}
		// No mail server: a reset says how to get one done by hand.
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/mail", M{}, 200, nil)
		if out := s.call(nil, "", "POST", "/api/v1/auth/reset/request", M{"email": "owner@example.com"}, 409, nil); !strings.Contains(out, "reset-password") {
			t.Fatalf("reset without mail = %s", out)
		}
	})
}

// fakeOIDC is a tiny OpenID Connect provider: it signs in whoever asks as
// one fixed person.
func fakeOIDC(t *testing.T, email string) *httptest.Server {
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
		// The code carries the nonce so the token endpoint can echo it.
		http.Redirect(w, r, q.Get("redirect_uri")+"?state="+url.QueryEscape(q.Get("state"))+"&code="+url.QueryEscape(q.Get("nonce")), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		now := time.Now()
		raw, err := jwt.Signed(signer).Claims(M{"iss": srv.URL, "sub": "subject-1", "aud": "quadit-client", "exp": now.Add(time.Hour).Unix(),
			"iat": now.Unix(), "nonce": r.Form.Get("code"), "email": email, "email_verified": true, "name": "Eve Example"}).Serialize()
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

func TestSingleSignOn(t *testing.T) {
	s := newSite(t, testdb.SQLite(t))
	idp := fakeOIDC(t, "eve@example.com")
	s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.oidc", M{"enabled": true, "name": "Company SSO", "issuer": idp.URL,
		"client_id": "quadit-client", "client_secret": "s3cret"}, 200, nil)
	if out := s.call(nil, "", "GET", "/api/v1/auth/config", nil, 200, nil); !strings.Contains(out, "Company SSO") {
		t.Fatalf("provider not offered: %s", out)
	}
	// A stranger with no invitation is turned away.
	b := browser()
	resp, err := b.Get(s.url + "/api/v1/auth/oauth/oidc/start")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !strings.Contains(resp.Request.URL.String(), "/login?error=") {
		t.Fatalf("uninvited sign-in ended at %s", resp.Request.URL)
	}
	// With an invitation the same sign-in makes the account and comes back
	// to the invitation.
	var inv struct{ Link string }
	s.call(s.owner, "", "POST", w+"/invites", M{"email": "eve@example.com"}, 201, &inv)
	token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
	resp, err = b.Get(s.url + "/api/v1/auth/oauth/oidc/start?invite=" + token)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !strings.HasSuffix(resp.Request.URL.Path, "/invite/"+token) {
		t.Fatalf("invited sign-in ended at %s", resp.Request.URL)
	}
	s.call(b, "", "POST", "/api/v1/auth/invite/"+token, nil, 200, nil)
	var me struct{ Name, Role string }
	s.call(b, "", "GET", w+"/me", nil, 200, &me)
	if me.Name != "Eve Example" || me.Role != "member" {
		t.Fatalf("signed in as %+v", me)
	}
	// Next time the identity is known and no invitation is needed.
	b2 := browser()
	resp, _ = b2.Get(s.url + "/api/v1/auth/oauth/oidc/start")
	resp.Body.Close()
	s.call(b2, "", "GET", "/api/v1/auth/me", nil, 200, nil)
	// It is her only way in, so it cannot be removed.
	var ids struct {
		Identities []struct{ ID string }
	}
	s.call(b2, "", "GET", "/api/v1/auth/identities", nil, 200, &ids)
	s.call(b2, "", "DELETE", "/api/v1/auth/identities/"+ids.Identities[0].ID, nil, 409, nil)
}
