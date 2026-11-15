package server_test

// What sign-in, accounts and settings do when the database has trouble:
// a limit, a revocation or a setting that cannot be read or written makes
// the request fail, and never lets it through as if all were well.

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

const ownerPassword = "correct-horse-battery"

// in is the site as seen from a subtest, so that a failed call fails it.
func (s *site) in(t *testing.T) *site {
	sub := *s
	sub.t = t
	return &sub
}

// signIn signs the owner in on a new browser.
func (s *site) signIn() *http.Client {
	s.t.Helper()
	b := browser()
	s.call(b, "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": ownerPassword}, 200, nil)
	return b
}

// invitedPerson makes a member of the workspace who does not run the
// install, signed in on a browser of their own, and returns their id.
func (s *site) invitedPerson() (*http.Client, string) {
	s.t.Helper()
	var inv struct{ Link string }
	s.call(s.owner, "", "POST", w+"/invites", M{}, 201, &inv)
	token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
	b := browser()
	var joined struct {
		User struct{ ID string } `json:"user"`
	}
	s.call(b, "", "POST", "/api/v1/auth/invite/"+token, M{"name": "Bea", "email": "bea@example.com", "password": "another-long-password"}, 200, &joined)
	return b, joined.User.ID
}

// ownerID is the id of the person who set the install up.
func (s *site) ownerID() string {
	s.t.Helper()
	var me struct {
		User struct{ ID string } `json:"user"`
	}
	s.call(s.owner, "", "GET", "/api/v1/auth/me", nil, 200, &me)
	return me.User.ID
}

// secondServer starts another server on the same store, as after a restart:
// it has read nothing yet.
func secondServer(t *testing.T, st store.Store) *site {
	t.Helper()
	dir := t.TempDir()
	files, err := blob.NewDisk(dir + "/files")
	if err != nil {
		t.Fatal(err)
	}
	sealer, _ := auth.NewSealer([]byte("a test secret, long enough"))
	hs := httptest.NewUnstartedServer(nil)
	_, port, _ := net.SplitHostPort(hs.Listener.Addr().String())
	base := "http://localhost:" + port
	srv := server.New(server.Config{DataDir: dir, BaseURL: base, Version: "test"}, st, files, sealer)
	hs.Config.Handler = srv.Handler()
	hs.Start()
	ctx, stop := context.WithCancel(context.Background())
	go srv.Run(ctx)
	t.Cleanup(func() { stop(); hs.Close() })
	return &site{t: t, url: base, dir: dir, srv: srv}
}

func TestSignInIsRefusedWhenAttemptsCannotBeCounted(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		login := M{"email": "owner@example.com", "password": ownerPassword}
		t.Run("the count cannot be read", func(t *testing.T) {
			s := s.in(t)
			fs.faults.set("get rate_counters")
			defer fs.faults.clear()
			s.call(browser(), "", "POST", "/api/v1/auth/login", login, 429, nil)
		})
		t.Run("a first attempt cannot be stored", func(t *testing.T) {
			s := s.in(t)
			fs.faults.set("upsert rate_counters")
			defer fs.faults.clear()
			s.call(browser(), "", "POST", "/api/v1/auth/register", M{"name": "Cy", "email": "cy@example.com", "password": "another-long-password"}, 403, nil)
			s.call(browser(), "", "POST", "/oauth/register", M{"client_name": "C", "redirect_uris": []string{"http://localhost:9/cb"}}, 429, nil)
		})
		t.Run("a later attempt cannot be added", func(t *testing.T) {
			s := s.in(t)
			s.call(browser(), "", "POST", "/api/v1/auth/login", login, 200, nil)
			fs.faults.set("incr rate_counters")
			defer fs.faults.clear()
			s.call(browser(), "", "POST", "/api/v1/auth/login", login, 429, nil)
		})
	})
}

func TestRequiredSecondStepHoldsWhenSettingsCannotBeRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.require_2fa", true, 200, nil)
		// A server that has not read the setting yet takes it as on.
		again := secondServer(t, fs)
		again.owner = again.signIn()
		fs.faults.set("get settings")
		defer fs.faults.clear()
		again.call(again.owner, "", "GET", w+"/me", nil, 403, nil)
	})
}

func TestAccessSettingsFailClosedWhenTheyCannotBeRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		bea, _ := s.invitedPerson()
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/workspaces.anyone_can_create", false, 200, nil)
		again := secondServer(t, fs)
		beaAgain := browser()
		again.call(beaAgain, "", "POST", "/api/v1/auth/login", M{"email": "bea@example.com", "password": "another-long-password"}, 200, nil)
		fs.faults.set("get settings")
		defer fs.faults.clear()
		s.call(bea, "", "POST", "/api/v1/workspaces", M{"name": "Side"}, 403, nil)
		again.call(beaAgain, "", "POST", "/api/v1/workspaces", M{"name": "Side"}, 500, nil)
		// Whether passwords are on cannot be read either.
		third := secondServer(t, fs)
		third.call(browser(), "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": ownerPassword}, 500, nil)
	})
}

func TestPasswordChangesFailWhenOtherSessionsCannotBeEnded(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		t.Run("signing out", func(t *testing.T) {
			s := s.in(t)
			b := s.signIn()
			fs.faults.set("update sessions")
			defer fs.faults.clear()
			s.call(b, "", "POST", "/api/v1/auth/logout", nil, 500, nil)
			fs.faults.clear()
		})
		t.Run("a change", func(t *testing.T) {
			s := s.in(t)
			other := s.signIn()
			fs.faults.set("update sessions")
			defer fs.faults.clear()
			s.call(s.owner, "", "POST", "/api/v1/auth/password", M{"current": ownerPassword, "new": "a-brand-new-password"}, 500, nil)
			fs.faults.clear()
			// Nothing changed: the old password still works.
			s.call(other, "", "GET", "/api/v1/auth/me", nil, 200, nil)
			s.signIn()
		})
		t.Run("a reset", func(t *testing.T) {
			s := s.in(t)
			other := s.owner
			token := auth.Random(32)
			now := time.Now()
			if err := st.Insert(context.Background(), core.OneTimeToken{ID: id.New(), Kind: "reset", TokenHash: auth.Hash(token), UserID: s.ownerID(),
				CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(time.Hour).UnixMilli()}); err != nil {
				t.Fatal(err)
			}
			fs.faults.set("update sessions")
			defer fs.faults.clear()
			s.call(browser(), "", "POST", "/api/v1/auth/reset/confirm", M{"token": token, "password": "a-brand-new-password"}, 500, nil)
			fs.faults.clear()
			s.call(other, "", "GET", "/api/v1/auth/me", nil, 200, nil)
			s.signIn()
		})
	})
}

func TestDisablingAPersonFailsWhenTheirAccessCannotBeEnded(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		bea, beaID := s.invitedPerson()
		for _, table := range []string{"sessions", "api_tokens"} {
			fs.faults.set("update " + table)
			s.call(s.owner, "", "PATCH", "/api/v1/admin/users/"+beaID, M{"disabled": true}, 500, nil)
			fs.faults.clear()
		}
		// Nothing was half done: Bea is not disabled and still signed in.
		s.call(bea, "", "GET", "/api/v1/auth/me", nil, 200, nil)
		s.call(s.owner, "", "PATCH", "/api/v1/admin/users/"+beaID, M{"disabled": true}, 200, nil)
		s.call(bea, "", "GET", "/api/v1/auth/me", nil, 401, nil)
	})
}

func TestSavingASettingKeepsItsSecretsWhenTheOldValueCannotBeRead(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		mail := M{"host": "smtp.example.com", "from": "q@example.com", "password": "hunter2"}
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/mail", mail, 200, nil)
		mail["password"] = "********"
		fs.faults.set("get settings")
		defer fs.faults.clear()
		s.call(s.owner, "", "PUT", "/api/v1/admin/settings/mail", mail, 500, nil)
		fs.faults.clear()
		var out struct {
			Settings map[string]struct {
				Value map[string]any `json:"value"`
			} `json:"settings"`
		}
		s.call(s.owner, "", "GET", "/api/v1/admin/settings", nil, 200, &out)
		if got := out.Settings["mail"].Value["password"]; got != "********" {
			t.Fatalf("the mail password is %v after a failed save; want it kept (masked)", got)
		}
	})
}

// oauthTokens runs the OAuth flow of an MCP client and returns its refresh
// token and client id.
func (s *site) oauthTokens(t *testing.T) (refresh, clientID string) {
	t.Helper()
	var cl struct {
		ID string `json:"client_id"`
	}
	redirect := "http://localhost:9999/callback"
	s.call(nil, "", "POST", "/oauth/register", M{"client_name": "Test Client", "redirect_uris": []string{redirect}}, 201, &cl)
	verifier := "a-long-random-verifier-string-for-pkce-0123456789"
	sum := sha256.Sum256([]byte(verifier))
	page, err := s.owner.Get(s.url + "/oauth/authorize?" + url.Values{"response_type": {"code"}, "client_id": {cl.ID}, "redirect_uri": {redirect},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}}.Encode())
	if err != nil {
		t.Fatal(err)
	}
	html, _ := io.ReadAll(page.Body)
	page.Body.Close()
	field := func(after string) string {
		rest := string(html)[strings.Index(string(html), after)+len(after):]
		return rest[:strings.IndexAny(rest, `":`)]
	}
	noFollow := *s.owner
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	done, err := noFollow.PostForm(s.url+"/oauth/authorize", url.Values{"request": {field(`name="request" value="`)},
		"workspace": {field(`<option value="`)}, "answer": {"allow"}})
	if err != nil {
		t.Fatal(err)
	}
	done.Body.Close()
	loc, _ := url.Parse(done.Header.Get("Location"))
	var tok struct {
		Refresh string `json:"refresh_token"`
	}
	s.tokenCall(t, url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")}, "client_id": {cl.ID},
		"redirect_uri": {redirect}, "code_verifier": {verifier}}, 200, &tok)
	return tok.Refresh, cl.ID
}

// tokenCall posts to the OAuth token endpoint, checking the status.
func (s *site) tokenCall(t *testing.T, form url.Values, want int, out any) {
	t.Helper()
	resp, err := http.PostForm(s.url+"/oauth/token", form)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("token: status %d, want %d: %s", resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatal(err)
		}
	}
}

func TestARefreshFailsWhenTheOldTokenCannotBeRevoked(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		refresh, clientID := s.oauthTokens(t)
		form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID}}
		fs.faults.set("update api_tokens")
		defer fs.faults.clear()
		s.tokenCall(t, form, 400, nil)
		fs.faults.clear()
		// The refresh token was not spent, so it works once, now.
		s.tokenCall(t, form, 200, nil)
		s.tokenCall(t, form, 400, nil)
	})
}

func TestAccountChecksFailWhenTheyCannotCount(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		fs := newFaultyStore(st)
		s := newSite(t, fs)
		var inv struct{ Link string }
		s.call(s.owner, "", "POST", w+"/invites", M{}, 201, &inv)
		cases := []struct {
			name, fault, method, path string
			body                      any
		}{
			{"the account page", "count passkeys", "GET", "/api/v1/auth/me", nil},
			{"a new address in use", "count users", "PATCH", "/api/v1/auth/me", M{"email": "new@example.com", "password": ownerPassword}},
			{"the last passkey", "count passkeys", "DELETE", "/api/v1/auth/passkeys/x", nil},
			{"the last connected account", "count identities", "DELETE", "/api/v1/auth/identities/x", nil},
			{"the last admin", "count users", "PATCH", "/api/v1/admin/users/" + s.ownerID(), M{"is_admin": false}},
			{"turning passwords off", "count passkeys", "PUT", "/api/v1/admin/settings/auth.password", false},
			{"an invitation to a member", "count members", "POST", "/api/v1/auth/invite/" + inv.Link[strings.LastIndex(inv.Link, "/")+1:], nil},
			{"an admin joining", "count members", "POST", "/api/v1/admin/workspaces/games/join", nil},
			{"the health panel", "count jobs", "GET", "/api/v1/admin/health", nil},
			{"the list of workspaces", "count tasks", "GET", "/api/v1/admin/workspaces", nil},
			{"an invitation", "get invites", "GET", "/api/v1/auth/invite/" + inv.Link[strings.LastIndex(inv.Link, "/")+1:], nil},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				s := s.in(t)
				fs.faults.set(tc.fault)
				defer fs.faults.clear()
				s.call(s.owner, "", tc.method, tc.path, tc.body, 500, nil)
			})
		}
		t.Run("turning codes off where two steps are required", func(t *testing.T) {
			s := s.in(t)
			s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.require_2fa", true, 200, nil)
			defer s.call(s.owner, "", "PUT", "/api/v1/admin/settings/auth.require_2fa", []byte("null"), 200, nil)
			fs.faults.set("count passkeys")
			defer fs.faults.clear()
			s.call(s.owner, "", "POST", "/api/v1/auth/totp/disable", M{"password": ownerPassword}, 500, nil)
		})
	})
}

func TestASecretRequestWhoseAnswerBreaksOffIsNotOK(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		api := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
			// The answer promises more than it sends, then the line drops.
			conn, buf, err := http.NewResponseController(rw).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npart")
			buf.Flush()
			conn.Close()
		}))
		defer api.Close()
		s.change(s.owner, "", "secret.set", M{"name": "KEY", "value": "sk-1", "hosts": []string{"http://" + strings.TrimPrefix(api.URL, "http://")}})
		var out struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		s.call(s.owner, "", "POST", w+"/secrets/KEY/request", M{"url": api.URL + "/x"}, 200, &out)
		if out.OK || out.Error == "" {
			t.Fatalf("an answer cut short reads as %+v; want ok false with the error", out)
		}
	})
}

// spendFirst is a store in which, once armed, another refresh spends a token
// just before this one revokes it: the moment two refreshes with one token
// race for.
type spendFirst struct {
	store.Store
	armed atomic.Bool
}

func (s *spendFirst) Update(ctx context.Context, table string, set map[string]any, where ...store.Cond) (int64, error) {
	if table == "api_tokens" && s.armed.CompareAndSwap(true, false) {
		if _, err := s.Store.Update(ctx, table, map[string]any{"revoked_at": time.Now().UnixMilli()}, where...); err != nil {
			return 0, err
		}
	}
	return s.Store.Update(ctx, table, set, where...)
}

func TestARefreshTokenSpentByAnotherRefreshIsRefused(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		racing := &spendFirst{Store: st}
		s := newSite(t, racing)
		refresh, clientID := s.oauthTokens(t)
		racing.armed.Store(true)
		s.tokenCall(t, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {clientID}}, 400, nil)
	})
}
