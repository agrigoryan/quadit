package server_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

const appKey = "a2V5LW9mLXRoZS1hcHAtdGhhdC1ydW5zLXRoaXMtc2VydmVyLTEyMzQ"

// theApp is a client as the desktop app's main process is one: it keeps
// cookies, carries key in X-Quadit-App-Key, and says nothing a page would
// (Sec-Fetch-Site, Origin), or says it comes from another site, as no page
// of the server's own does: the key is its authority, not the page.
func theApp(key, site string) *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Transport: appTransport{key: key, site: site}}
}

type appTransport struct{ key, site string }

func (a appTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if a.key != "" {
		r.Header.Set("X-Quadit-App-Key", a.key)
	}
	if a.site != "" {
		r.Header.Set("Sec-Fetch-Site", a.site)
	}
	if r.Body != nil && r.Body != http.NoBody {
		r.Header.Set("Content-Type", "application/json")
	}
	return http.DefaultTransport.RoundTrip(r)
}

// signInOptions is what GET /api/v1/auth/config says of setting up.
type signInOptions struct {
	SetupNeeded bool `json:"setup_needed"`
	SetupByApp  bool `json:"setup_by_app"`
}

// TestTheAppThatRunsTheServerSetsItUp: on a server the desktop app runs
// (--app-key-stdin), the sign-in options say the app sets it up, and only
// a request with the app's key may: with the person's name, making an owner
// with no email and no password, recorded as the local owner, with daily
// backups on as stored settings. The app then signs that owner in with its
// key, from its own process, whatever such a request says of pages; nothing
// else is taken on the key. The owner can add a password and an email to
// sign in from a browser.
func TestTheAppThatRunsTheServerSetsItUp(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		body := M{"name": "Aram Grigoryan", "workspace_name": "Personal"}

		var options signInOptions
		s.call(t, nil, "", "GET", "/api/v1/auth/config", nil, 200, &options)
		if !options.SetupNeeded || !options.SetupByApp {
			t.Fatalf("the sign-in options before set-up: %+v", options)
		}

		t.Run("nothing but the app sets it up", func(t *testing.T) {
			if out := s.call(t, browser(), "", "POST", "/api/v1/auth/setup", M{"name": "Eve", "email": "eve@example.com", "password": "correct-horse-battery", "workspace_name": "Eve"}, 403, nil); !strings.Contains(out, "set up by the app that runs it") {
				t.Errorf("the form on a server the app runs: %s", out)
			}
			s.call(t, theApp("d3Jvbmcta2V5LXdyb25nLWtleS13cm9uZy1rZXktd3Jvbmcta2V5LXdy", ""), "", "POST", "/api/v1/auth/setup", body, 403, nil)
			s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/setup", M{"name": "Aram", "email": "aram@example.com", "workspace_name": "Personal"}, 400, nil)
		})

		app := theApp(appKey, "cross-site")
		var made struct {
			User      map[string]any
			Workspace struct{ Slug string }
		}
		s.call(t, app, "", "POST", "/api/v1/auth/setup", body, 201, &made)
		if made.Workspace.Slug != "personal" || made.User["name"] != "Aram Grigoryan" || made.User["email"] != nil || made.User["is_admin"] != true {
			t.Fatalf("the app's set-up made %+v", made)
		}
		ownerID, _ := made.User["id"].(string)
		var account struct {
			HasPassword bool `json:"has_password"`
		}
		s.call(t, app, "", "GET", "/api/v1/auth/me", nil, 200, &account)
		if account.HasPassword {
			t.Fatal("the owner the app made has a password")
		}
		s.call(t, app, "", "POST", "/api/v1/auth/setup", body, 409, nil)
		s.call(t, nil, "", "GET", "/api/v1/auth/config", nil, 200, &options)
		if options.SetupNeeded || !options.SetupByApp {
			t.Fatalf("the sign-in options after set-up: %+v", options)
		}

		t.Run("daily backups are a setting, the local owner is the server's own", func(t *testing.T) {
			var listed struct {
				Settings map[string]struct {
					FromEnv bool            `json:"from_env"`
					Value   json.RawMessage `json:"value"`
				}
			}
			s.call(t, app, "", "GET", "/api/v1/admin/settings", nil, 200, &listed)
			if owner, there := listed.Settings["install.local_owner"]; there {
				t.Errorf("the admin area lists install.local_owner: %+v", owner)
			}
			admin := s.signedInAs(t, app)
			s.call(t, admin, "", "PUT", "/api/v1/admin/settings/install.local_owner", `"someone-else"`, 400, nil)
			var backup struct {
				Enabled bool
				Keep    int
			}
			if err := json.Unmarshal(listed.Settings["backup"].Value, &backup); err != nil || !backup.Enabled || backup.Keep != 14 || listed.Settings["backup"].FromEnv {
				t.Errorf("the backup setting is %s (%v), want daily backups on", listed.Settings["backup"].Value, err)
			}
			// The person may turn them off.
			s.call(t, app, "", "PUT", "/api/v1/admin/settings/backup", M{"enabled": false}, 403, nil) // a write from no page of the server's: not taken on the key
			s.call(t, admin, "", "PUT", "/api/v1/admin/settings/backup", M{"enabled": false}, 200, nil)
		})

		t.Run("the app signs the local owner in", func(t *testing.T) {
			window := theApp(appKey, "")
			s.call(t, window, "", "POST", "/api/v1/auth/app-session", nil, 204, nil)
			var me struct{ User struct{ ID string } }
			s.call(t, window, "", "GET", "/api/v1/auth/me", nil, 200, &me)
			if me.User.ID != ownerID {
				t.Fatalf("the app's session is %s's, want the local owner %s", me.User.ID, ownerID)
			}
			s.call(t, theApp("", ""), "", "POST", "/api/v1/auth/app-session", nil, 403, nil)
			s.call(t, theApp(strings.ToUpper(appKey), ""), "", "POST", "/api/v1/auth/app-session", nil, 403, nil)
		})

		t.Run("a password and an email to sign in from a browser", func(t *testing.T) {
			owner := s.signedInAs(t, app)
			s.call(t, owner, "", "PATCH", "/api/v1/auth/me", M{"email": "aram@example.com"}, 200, nil)
			s.call(t, owner, "", "POST", "/api/v1/auth/password", M{"new": "correct-horse-battery"}, 200, nil)
			s.call(t, browser(), "", "POST", "/api/v1/auth/login", M{"email": "aram@example.com", "password": "correct-horse-battery"}, 200, nil)
		})
	})
}

// signedInAs gives a browser on the server's own pages that holds the
// session of client.
func (s *site) signedInAs(t *testing.T, client *http.Client) *http.Client {
	t.Helper()
	at, err := url.Parse(s.url)
	if err != nil {
		t.Fatal(err)
	}
	b := browser()
	b.Jar.SetCookies(at, client.Jar.Cookies(at))
	return b
}

// TestAWrongAppKeyIsCountedAsAFailedSignIn: a wrong key is counted as a
// failed sign-in is, and after as many as one address may make, more are
// refused; the right key is never counted, nor held back by the sign-ins
// counted from the same address.
func TestAWrongAppKeyIsCountedAsAFailedSignIn(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/setup", M{"name": "Aram", "workspace_name": "Personal"}, 201, nil)
		for range 30 {
			s.call(t, theApp("guess", ""), "", "POST", "/api/v1/auth/app-session", nil, 403, nil)
		}
		s.call(t, theApp("guess", ""), "", "POST", "/api/v1/auth/app-session", nil, 429, nil)
		s.call(t, browser(), "", "POST", "/api/v1/auth/login", M{"email": "a@example.com", "password": "wrong-password"}, 429, nil)
		for range 3 {
			s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 204, nil)
		}
	})
}

// TestAppSessionNeedsAnAppThatSetTheServerUp: a server no app runs has no
// app session, whatever a request carries, and says so in its sign-in
// options; one set up with the form before an app ran it has no local
// owner to sign in.
func TestAppSessionNeedsAnAppThatSetTheServerUp(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		formed := newSite(t, st)
		var options signInOptions
		formed.call(t, nil, "", "GET", "/api/v1/auth/config", nil, 200, &options)
		if options.SetupByApp {
			t.Fatal("a server no app runs says the app sets it up")
		}
		formed.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 404, nil)

		keyed := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		keyed.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 409, nil)
	})
}

// TestAnOwnerWithNoEmail: the owner the app makes has no email address,
// and nothing that names an account by its address breaks for that: an
// authenticator app lists it by its name, the member list leaves the
// address out, an invitation for an address says who is signed in, the
// test mail asks where to go, the export is made, and signing in with no
// address finds nobody.
func TestAnOwnerWithNoEmail(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		app := theApp(appKey, "")
		s.call(t, app, "", "POST", "/api/v1/auth/setup", M{"name": "Aram Grigoryan", "workspace_name": "Games"}, 201, nil)
		owner := s.signedInAs(t, app)

		var totp struct{ URL string }
		s.call(t, owner, "", "POST", "/api/v1/auth/totp/start", M{}, 200, &totp)
		if !strings.HasPrefix(totp.URL, "otpauth://totp/Quadit:Aram%20Grigoryan?") {
			t.Errorf("the authenticator lists the account as %s", totp.URL)
		}

		var members struct{ Members []map[string]any }
		s.call(t, owner, "", "GET", w+"/list/members", nil, 200, &members)
		if len(members.Members) != 1 || members.Members[0]["handle"] != "aram-grigoryan" {
			t.Fatalf("members = %+v", members.Members)
		}
		if email, there := members.Members[0]["email"]; there {
			t.Errorf("the member list shows the owner's address as %q", email)
		}

		var inv struct{ Link string }
		s.call(t, owner, "", "POST", w+"/invites", M{"email": "bea@example.com", "role": "member"}, 201, &inv)
		token := inv.Link[strings.LastIndex(inv.Link, "/")+1:]
		if out := s.call(t, owner, "", "POST", "/api/v1/auth/invite/"+token, M{}, 403, nil); !strings.Contains(out, "signed in as Aram Grigoryan") {
			t.Errorf("an invitation for another address: %s", out)
		}

		s.call(t, owner, "", "POST", "/api/v1/admin/mail/test", M{}, 400, nil)
		s.call(t, owner, "", "GET", w+"/export", nil, 200, nil)
		s.call(t, browser(), "", "POST", "/api/v1/auth/login", M{"email": "", "password": ""}, 401, nil)
	})
}

// TestTheFormStillSetsUpWithAnEmail: on a server no app runs, the set-up
// form makes an owner who signs in with an email and a password, and one
// without an email is refused rather than made unable to sign in.
func TestTheFormStillSetsUpWithAnEmail(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, nil)
		form := M{"name": "Aram", "email": " ", "password": "correct-horse-battery", "workspace_name": "Games"}
		if out := s.call(t, browser(), "", "POST", "/api/v1/auth/setup", form, 400, nil); !strings.Contains(out, `"field":"email"`) {
			t.Errorf("a set-up with no email: %s", out)
		}
		form["email"] = "aram@example.com"
		s.call(t, browser(), "", "POST", "/api/v1/auth/setup", form, 201, nil)
		s.call(t, browser(), "", "POST", "/api/v1/auth/login", M{"email": "aram@example.com", "password": "correct-horse-battery"}, 200, nil)
	})
}

// TestTheAppsSetUpIsOneWrite: the owner, the workspace, the local owner and
// daily backups are written together or not at all, and the session comes
// after. A set-up whose settings cannot be written leaves the install as it
// was, not set up, and trying again sets it up.
func TestTheAppsSetUpIsOneWrite(t *testing.T) {
	testdb.Each(t, func(t *testing.T, plain store.Store) {
		st := newFaultyStore(plain)
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		body := M{"name": "Aram", "workspace_name": "Personal"}

		st.faults.set("upsert settings")
		app := theApp(appKey, "")
		s.call(t, app, "", "POST", "/api/v1/auth/setup", body, 500, nil)
		var options signInOptions
		s.call(t, nil, "", "GET", "/api/v1/auth/config", nil, 200, &options)
		if !options.SetupNeeded {
			t.Fatal("a set-up that failed left the install set up")
		}
		s.call(t, app, "", "GET", "/api/v1/auth/me", nil, 401, nil)

		st.faults.clear()
		s.call(t, app, "", "POST", "/api/v1/auth/setup", body, 201, nil)
		s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 204, nil)
	})
}

// TestTheLocalOwnerMustBeALivePerson: an app session is made only for a
// person who is there; a local owner who was deleted, or an id that is not
// a person's, is answered as an install with no local owner.
func TestTheLocalOwnerMustBeALivePerson(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		var made struct{ User struct{ ID string } }
		app := theApp(appKey, "")
		s.call(t, app, "", "POST", "/api/v1/auth/setup", M{"name": "Aram", "workspace_name": "Games"}, 201, &made)
		owner := s.signedInAs(t, app)
		bot := s.change(t, owner, "", "agent.create", M{"name": "Ops bot", "handle": "ops"})["ref"].(string)
		ctx := context.Background()

		if _, err := st.Update(ctx, "settings", map[string]any{"value": []byte(`"` + bot + `"`)}, store.Eq("name", "install.local_owner")); err != nil {
			t.Fatal(err)
		}
		s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 409, nil)

		if _, err := st.Update(ctx, "settings", map[string]any{"value": []byte(`"` + made.User.ID + `"`)}, store.Eq("name", "install.local_owner")); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Update(ctx, "users", map[string]any{"deleted_at": time.Now().UnixMilli()}, store.Eq("id", made.User.ID)); err != nil {
			t.Fatal(err)
		}
		s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 409, nil)
	})
}

// TestTheServerProvesItHoldsTheAppKey: before the app sends its server the
// key or a cookie, the server proves it holds the key: the HMAC-SHA256 of
// the app's nonce under the key, in lower-case hex. Asked without a key or
// a session, from anywhere; a nonce out of bounds is refused, and a server
// no app runs has nothing to prove.
func TestTheServerProvesItHoldsTheAppKey(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		nonce := "bm9uY2Utb2YtdGhlLWFwcC10aGF0LXJ1bnMtdGhlLXNlcnZlcg"
		mac := hmac.New(sha256.New, []byte(appKey))
		mac.Write([]byte(nonce))
		want := hex.EncodeToString(mac.Sum(nil))

		var got struct{ Proof string }
		asker := theApp("", "cross-site")
		s.call(t, asker, "", "POST", "/api/v1/auth/app-proof", M{"nonce": nonce}, 200, &got)
		if got.Proof != want {
			t.Fatalf("the proof is %q, want %q", got.Proof, want)
		}
		at, _ := url.Parse(s.url)
		if cookies := asker.Jar.Cookies(at); len(cookies) != 0 {
			t.Errorf("a proof came with cookies: %v", cookies)
		}
		for _, bad := range []any{strings.Repeat("a", 21), strings.Repeat("a", 129), "not+base64url/at=all+here", nil} {
			s.call(t, asker, "", "POST", "/api/v1/auth/app-proof", M{"nonce": bad}, 400, nil)
		}
		s.call(t, asker, "", "POST", "/api/v1/auth/app-proof", M{"nonce": strings.Repeat("a", 22)}, 200, nil)
		s.call(t, asker, "", "POST", "/api/v1/auth/app-proof", M{"nonce": strings.Repeat("a", 128)}, 200, nil)

		plain := startSite(t, st, nil, nil)
		plain.call(t, theApp("", ""), "", "POST", "/api/v1/auth/app-proof", M{"nonce": nonce}, 404, nil)
	})
}

// TestOnlyTheKeyedPostsSkipThePageCheck: the key stands in for the page a
// browser's write comes from only on the posts the app makes with it; any
// other write to those addresses from another site's page is refused as
// every such write is.
func TestOnlyTheKeyedPostsSkipThePageCheck(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		for _, path := range []string{"/api/v1/auth/setup", "/api/v1/auth/app-session", "/api/v1/auth/app-proof"} {
			if out := s.call(t, theApp(appKey, "cross-site"), "", "PUT", path, M{}, 403, nil); !strings.Contains(out, "another site's page") {
				t.Errorf("PUT %s from another site's page: %s", path, out)
			}
		}
	})
}

// TestTheAppIsADoorForItsLocalOwner: the local owner of a server the app
// runs always has a way in, the app, so changing the sign-in methods never
// locks them out; anyone else still needs one of the methods left on.
func TestTheAppIsADoorForItsLocalOwner(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		app := theApp(appKey, "")
		s.call(t, app, "", "POST", "/api/v1/auth/setup", M{"name": "Aram", "workspace_name": "Games"}, 201, nil)
		s.call(t, s.signedInAs(t, app), "", "PUT", "/api/v1/admin/settings/auth.passkeys", false, 200, nil)

		formed := newSite(t, testdb.SQLite(t))
		formed.call(t, formed.owner, "", "PUT", "/api/v1/admin/settings/auth.passkeys", false, 200, nil)
		formed.call(t, formed.owner, "", "PUT", "/api/v1/admin/settings/auth.password", false, 409, nil)
	})
}
