package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// fakeGitHub answers the three calls sign-in with GitHub makes, in the
// shapes GitHub itself uses: the token comes back form-encoded unless JSON
// is asked for, a person's name may be null, and the address is read from
// the list of emails.
func fakeGitHub(t *testing.T, seen *[]string) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		*seen = append(*seen, "scope="+q.Get("scope"))
		back, _ := url.Parse(q.Get("redirect_uri"))
		v := url.Values{"code": {"the-code"}, "state": {q.Get("state")}}
		back.RawQuery = v.Encode()
		http.Redirect(w, r, back.String(), http.StatusFound)
	})
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("code") != "the-code" || r.Form.Get("client_id") == "" && r.Header.Get("Authorization") == "" {
			http.Error(w, "bad_verification_code", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
		w.Write([]byte("access_token=gho_fake123&scope=read%3Auser%2Cuser%3Aemail&token_type=bearer"))
	})
	api := func(path string, body any) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasSuffix(r.Header.Get("Authorization"), "gho_fake123") {
				http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
				return
			}
			*seen = append(*seen, path)
			json.NewEncoder(w).Encode(body)
		})
	}
	api("/user", M{"id": 583231, "login": "octocat", "name": nil, "email": nil})
	api("/user/emails", []M{
		{"email": "old@example.com", "primary": false, "verified": true, "visibility": nil},
		{"email": "Octo@Example.com", "primary": true, "verified": true, "visibility": "private"},
		{"email": "unverified@example.com", "primary": false, "verified": false, "visibility": nil},
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// TestSignInWithGitHub walks sign-in with GitHub from the first redirect to
// a signed-in member, against a stand-in that speaks as GitHub does.
func TestSignInWithGitHub(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		var seen []string
		gh := fakeGitHub(t, &seen)
		s.call(t, s.owner, "", "PUT", "/api/v1/admin/settings/auth.github", M{"enabled": true, "client_id": "Iv1.abc", "client_secret": "s3cret",
			"auth_url": gh.URL + "/login/oauth/authorize", "token_url": gh.URL + "/login/oauth/access_token", "api_url": gh.URL}, 200, nil)
		if out := s.call(t, nil, "", "GET", "/api/v1/auth/config", nil, 200, nil); !strings.Contains(out, "GitHub") {
			t.Fatalf("GitHub is not offered: %s", out)
		}
		if out := s.call(t, s.owner, "", "GET", "/api/v1/admin/settings", nil, 200, nil); strings.Contains(out, "s3cret") {
			t.Fatalf("the client secret is shown: %s", out)
		}
		// Someone invited by the address GitHub vouches for.
		var inv struct{ Link string }
		s.call(t, s.owner, "", "POST", w+"/invites", M{"email": "octo@example.com"}, 201, &inv)
		token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
		b := browser()
		resp, err := b.Get(s.url + "/api/v1/auth/oauth/github/start?invite=" + token)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if !strings.HasSuffix(resp.Request.URL.Path, "/invite/"+token) {
			t.Fatalf("sign-in with GitHub ended at %s", resp.Request.URL)
		}
		s.call(t, b, "", "POST", "/api/v1/auth/invite/"+token, nil, 200, nil)
		var me struct{ Name, Role string }
		s.call(t, b, "", "GET", w+"/me", nil, 200, &me)
		if me.Name != "octocat" || me.Role != "member" {
			t.Fatalf("signed in as %+v (a person with no name on GitHub goes by their login)", me)
		}
		if got := strings.Join(seen, " "); !strings.Contains(got, "user:email") || !strings.Contains(got, "/user/emails") {
			t.Fatalf("what GitHub was asked: %s", got)
		}
		// The second time GitHub alone is enough.
		b2 := browser()
		resp, _ = b2.Get(s.url + "/api/v1/auth/oauth/github/start")
		resp.Body.Close()
		s.call(t, b2, "", "GET", "/api/v1/auth/me", nil, 200, nil)
	})
}

// TestRealProviders checks the two public services themselves, as far as
// that goes without an account: that Google's sign-in addresses are found
// the way sign-in finds them, and, given a GitHub token, that GitHub's own
// answers are read correctly.
//
//	QUADIT_TEST_GOOGLE=1  QUADIT_TEST_GITHUB_TOKEN=$(gh auth token)
func TestRealProviders(t *testing.T) {
	if os.Getenv("QUADIT_TEST_GOOGLE") == "" && os.Getenv("QUADIT_TEST_GITHUB_TOKEN") == "" {
		t.Skip("QUADIT_TEST_GOOGLE and QUADIT_TEST_GITHUB_TOKEN are not set")
	}
	ctx := context.Background()
	if os.Getenv("QUADIT_TEST_GOOGLE") != "" {
		s := newSite(t, testdb.SQLite(t))
		auth, token, err := s.srv.GoogleEndpoints(ctx)
		if err != nil {
			t.Fatalf("Google's sign-in addresses: %v", err)
		}
		if !strings.HasPrefix(auth, "https://accounts.google.com/") || !strings.Contains(token, "googleapis.com") {
			t.Fatalf("Google's sign-in addresses are %s and %s", auth, token)
		}
	}
	if tok := os.Getenv("QUADIT_TEST_GITHUB_TOKEN"); tok != "" {
		subject, name, verified, err := server.GitHubIdentity(ctx, tok, "https://api.github.com")
		if subject == "" || subject == "0" || name == "" {
			t.Fatalf("GitHub's answer gave no id or no name (%v)", err)
		}
		switch {
		case err == nil && !verified:
			t.Fatal("GitHub listed no verified address for this account")
		case err != nil && !strings.Contains(err.Error(), "user:email"):
			t.Fatalf("GitHub's answer could not be read: %v", err)
		case err != nil:
			// A token made for other work (the gh command's) may not read
			// addresses; the sign-in app asks for that permission itself.
			t.Log("who the token belongs to was read; its addresses need the user:email permission, which this token lacks")
		}
	}
}
