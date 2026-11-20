package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"

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

		t.Run("the local owner and daily backups are settings", func(t *testing.T) {
			var listed struct {
				Settings map[string]struct {
					FromEnv bool            `json:"from_env"`
					Value   json.RawMessage `json:"value"`
				}
			}
			s.call(t, app, "", "GET", "/api/v1/admin/settings", nil, 200, &listed)
			if owner := listed.Settings["install.local_owner"]; string(owner.Value) != `"`+ownerID+`"` || owner.FromEnv {
				t.Errorf("install.local_owner is %+v, want the owner %s", owner, ownerID)
			}
			var backup struct {
				Enabled bool
				Keep    int
			}
			if err := json.Unmarshal(listed.Settings["backup"].Value, &backup); err != nil || !backup.Enabled || backup.Keep != 14 || listed.Settings["backup"].FromEnv {
				t.Errorf("the backup setting is %s (%v), want daily backups on", listed.Settings["backup"].Value, err)
			}
			// The person may turn them off.
			s.call(t, app, "", "PUT", "/api/v1/admin/settings/backup", M{"enabled": false}, 403, nil) // a write from no page of the server's: not taken on the key
			s.call(t, s.signedInAs(t, app), "", "PUT", "/api/v1/admin/settings/backup", M{"enabled": false}, 200, nil)
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

// TestAppSessionsAreCountedAsSignIns: a wrong key is a failed sign-in, and
// after as many as one address may make, the right one waits too.
func TestAppSessionsAreCountedAsSignIns(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := startSite(t, st, nil, func(cfg *server.Config) { cfg.AppKey = appKey })
		s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/setup", M{"name": "Aram", "workspace_name": "Personal"}, 201, nil)
		for range 30 {
			s.call(t, theApp("guess", ""), "", "POST", "/api/v1/auth/app-session", nil, 403, nil)
		}
		s.call(t, theApp(appKey, ""), "", "POST", "/api/v1/auth/app-session", nil, 429, nil)
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
