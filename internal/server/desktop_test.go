package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// desktopFlow is one sign-in the desktop app starts: the secrets it keeps
// and the challenge it shows the server.
type desktopFlow struct {
	state, verifier, challenge string
}

func newDesktopFlow() desktopFlow {
	verifier := auth.Random(48)
	sum := sha256.Sum256([]byte(verifier))
	return desktopFlow{state: auth.Random(32), verifier: verifier, challenge: base64.RawURLEncoding.EncodeToString(sum[:])}
}

// form is what the confirm page posts when the person presses Continue.
func (f desktopFlow) form(userID string) url.Values {
	return url.Values{"state": {f.state}, "challenge": {f.challenge}, "user": {userID}}
}

// noRedirects is a browser that stops at each redirect, so the test sees
// where it points.
func noRedirects() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// desktopApp is the desktop app's window: a browser with the app's user
// agent, that stops at redirects.
type desktopApp struct{ hc *http.Client }

// appUserAgent is the user agent of the app's windows.
const appUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0 Safari/537.36 QuaditDesktop/0.1.0"

// get loads a page as the app's own hand-off does: the main process loads
// it in the window, with the hand-off header, and no page sent it there.
func (a desktopApp) get(t *testing.T, rawURL string) (*http.Response, string) {
	t.Helper()
	return a.getWith(t, rawURL, map[string]string{"X-Quadit-Handoff": "1", "Sec-Fetch-Site": "none"})
}

// getWith loads a page in the app's window with these headers besides its user agent.
func (a desktopApp) getWith(t *testing.T, rawURL string, header map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	req.Header.Set("User-Agent", appUserAgent)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := a.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

// post sends a form as the browser does, with extra headers.
func post(t *testing.T, hc *http.Client, rawURL string, form url.Values, header map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

// approve presses Continue as the browser hc and returns the code from the
// deep link it is sent to, checking the link's server and state.
func approve(t *testing.T, s *site, hc *http.Client, f desktopFlow, userID string) string {
	t.Helper()
	// The browser's cookies, stopping at the redirect to the app.
	stops := &http.Client{Jar: hc.Jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, body := post(t, stops, s.url+"/desktop/connect", f.form(userID), map[string]string{"Sec-Fetch-Site": "same-origin"})
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("continue: status %d: %s", resp.StatusCode, body)
	}
	link, err := url.Parse(resp.Header.Get("Location"))
	if err != nil || link.Scheme != "quadit" || link.Host != "connect" {
		t.Fatalf("continue went to %q, not the app", resp.Header.Get("Location"))
	}
	q := link.Query()
	if q.Get("server") != s.url || q.Get("state") != f.state || q.Get("code") == "" {
		t.Fatalf("the deep link carries server %q state %q code %q", q.Get("server"), q.Get("state"), q.Get("code"))
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("the answer that carries the code may be kept: Cache-Control %q", cc)
	}
	return q.Get("code")
}

// finishURL is where the app sends its window with the code and the verifier.
func finishURL(s *site, code, verifier string) string {
	return s.url + "/desktop/finish?" + url.Values{"code": {code}, "verifier": {verifier}}.Encode()
}

// TestTheDesktopAppSignsInThroughTheBrowser: the desktop app opens the
// system browser at /desktop/connect; whoever is signed in there presses
// Continue, the browser hands the app a one-time code, and the app trades
// the code and its verifier at /desktop/finish for a session of its own.
func TestTheDesktopAppSignsInThroughTheBrowser(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		ownerID := s.ownerID()
		app := func() desktopApp { return desktopApp{hc: noRedirects()} }

		t.Run("a browser signed out signs in first and comes back", func(t *testing.T) {
			f := newDesktopFlow()
			hc := noRedirects()
			resp, _ := post(t, hc, s.url+"/desktop/connect", f.form(ownerID), nil)
			if resp.StatusCode != http.StatusSeeOther {
				t.Fatalf("signed out: status %d", resp.StatusCode)
			}
			back, _ := url.Parse(resp.Header.Get("Location"))
			next := back.Query().Get("next")
			if back.Path != "/login" || !strings.HasPrefix(next, "/desktop/connect?") || !strings.Contains(next, "challenge="+f.challenge) || !strings.Contains(next, "state="+f.state) {
				t.Fatalf("signed out: sent to %q", resp.Header.Get("Location"))
			}
			s.call(hc, "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": "correct-horse-battery"}, 200, nil)
			code := approve(t, s, hc, f, ownerID)

			a := app()
			resp, body := a.get(t, finishURL(s, code, f.verifier))
			if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/" {
				t.Fatalf("finish: status %d to %q: %s", resp.StatusCode, resp.Header.Get("Location"), body)
			}
			// The window is signed in, as a password sign-in signs a browser in.
			var me struct{ User struct{ ID string } }
			s.call(a.hc, "", "GET", "/api/v1/auth/me", nil, 200, &me)
			if me.User.ID != ownerID {
				t.Fatalf("the app is signed in as %q", me.User.ID)
			}
			var sessions struct {
				Sessions []struct {
					UserAgent string `json:"user_agent"`
					Current   bool
				}
			}
			s.call(a.hc, "", "GET", "/api/v1/auth/sessions", nil, 200, &sessions)
			found := false
			for _, se := range sessions.Sessions {
				found = found || (se.Current && strings.HasSuffix(se.UserAgent, "QuaditDesktop/0.1.0"))
			}
			if !found {
				t.Fatalf("the app's session is not listed with the app's user agent: %+v", sessions.Sessions)
			}
			if out := s.call(s.owner, "", "GET", "/api/v1/admin/audit?action=signin", nil, 200, nil); !strings.Contains(out, `"method":"desktop"`) {
				t.Fatalf("the sign-in is not in the audit log: %s", out)
			}
		})

		t.Run("a code works once", func(t *testing.T) {
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			if resp, _ := app().get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusFound {
				t.Fatalf("first use: status %d", resp.StatusCode)
			}
			resp, body := app().get(t, finishURL(s, code, f.verifier))
			if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, "Start again from the Quadit app") || resp.Header.Get("Set-Cookie") != "" {
				t.Fatalf("second use: status %d, cookie %q: %s", resp.StatusCode, resp.Header.Get("Set-Cookie"), body)
			}
		})

		t.Run("a wrong verifier is refused and spends the code", func(t *testing.T) {
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			if resp, _ := app().get(t, finishURL(s, code, newDesktopFlow().verifier)); resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("wrong verifier: status %d", resp.StatusCode)
			}
			if resp, _ := app().get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("the right verifier after a wrong one: status %d", resp.StatusCode)
			}
		})

		t.Run("an expired code is refused", func(t *testing.T) {
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			if _, err := st.Update(context.Background(), "one_time_tokens", map[string]any{"expires_at": time.Now().Add(-time.Second).UnixMilli()},
				store.Eq("token_hash", auth.Hash(code))); err != nil {
				t.Fatal(err)
			}
			if resp, _ := app().get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("expired: status %d", resp.StatusCode)
			}
		})

		t.Run("of finishes racing with one code exactly one signs in", func(t *testing.T) {
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			const racers = 6
			statuses := make(chan int, racers)
			var wg sync.WaitGroup
			for range racers {
				wg.Go(func() {
					resp, _ := app().get(t, finishURL(s, code, f.verifier))
					statuses <- resp.StatusCode
				})
			}
			wg.Wait()
			close(statuses)
			won := 0
			for status := range statuses {
				switch status {
				case http.StatusFound:
					won++
				case http.StatusBadRequest:
				default:
					t.Errorf("a racer got status %d", status)
				}
			}
			if won != 1 {
				t.Fatalf("%d racers signed in", won)
			}
		})

		t.Run("only the app's window can trade a code, so no page signs a browser in as someone else", func(t *testing.T) {
			// A code someone made for their own account, opened in another person's browser by a link or a page of theirs.
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			hc := noRedirects()
			req, _ := http.NewRequest(http.MethodGet, finishURL(s, code, f.verifier), nil)
			req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh) Chrome/142.0 Safari/537.36")
			resp, err := hc.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusForbidden || resp.Header.Get("Set-Cookie") != "" {
				t.Fatalf("a browser: status %d, cookie %q", resp.StatusCode, resp.Header.Get("Set-Cookie"))
			}
			a := app()
			for name, header := range map[string]map[string]string{
				"sent by another site":          {"X-Quadit-Handoff": "1", "Sec-Fetch-Site": "cross-site"},
				"sent by a sibling site":        {"X-Quadit-Handoff": "1", "Sec-Fetch-Site": "same-site"},
				"sent by the server's own page": {"X-Quadit-Handoff": "1", "Sec-Fetch-Site": "same-origin"},
				// A quadit://open link, or anything else that makes the app's window load the
				// address: it looks like the app, but only the app's own hand-off adds the header.
				"loaded in the app's window by a link": {"Sec-Fetch-Site": "none"},
				"with another hand-off header":         {"X-Quadit-Handoff": "yes"},
			} {
				if resp, body := a.getWith(t, finishURL(s, code, f.verifier), header); resp.StatusCode != http.StatusForbidden || resp.Header.Get("Set-Cookie") != "" {
					t.Fatalf("%s: status %d, cookie %q: %s", name, resp.StatusCode, resp.Header.Get("Set-Cookie"), body)
				}
			}
			// Refused before it was spent: the app's own window still gets in.
			if resp, _ := a.get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusFound {
				t.Fatalf("the app after the refusals: status %d", resp.StatusCode)
			}
		})

		t.Run("what is refused as not the app counts against no one's sign-ins", func(t *testing.T) {
			// More than an address's sign-ins allowed: refusing them must not lock the app out.
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			for range 40 {
				if resp, _ := app().getWith(t, finishURL(s, code, f.verifier), nil); resp.StatusCode != http.StatusForbidden {
					t.Fatalf("not the hand-off: status %d", resp.StatusCode)
				}
			}
			if resp, body := app().get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusFound {
				t.Fatalf("the app after the refusals: status %d: %s", resp.StatusCode, body)
			}
		})

		t.Run("a page of another site cannot press Continue", func(t *testing.T) {
			f := newDesktopFlow()
			resp, body := post(t, s.owner, s.url+"/desktop/connect", f.form(ownerID), map[string]string{"Sec-Fetch-Site": "cross-site"})
			if resp.StatusCode != http.StatusForbidden || strings.Contains(resp.Header.Get("Location"), "quadit:") {
				t.Fatalf("cross-site: status %d to %q: %s", resp.StatusCode, resp.Header.Get("Location"), body)
			}
		})

		t.Run("a token cannot get a session", func(t *testing.T) {
			var tok struct{ Token string }
			s.call(s.owner, "", "POST", w+"/tokens", M{}, 201, &tok)
			f := newDesktopFlow()
			resp, _ := post(t, noRedirects(), s.url+"/desktop/connect", f.form(ownerID), map[string]string{"Authorization": "Bearer " + tok.Token})
			if resp.StatusCode != http.StatusForbidden {
				t.Fatalf("with a token: status %d to %q", resp.StatusCode, resp.Header.Get("Location"))
			}
		})

		t.Run("the page answered is the account signed in", func(t *testing.T) {
			// The confirm page named someone else: the browser has signed in as another account since.
			f := newDesktopFlow()
			resp, _ := post(t, noRedirects(), s.url+"/desktop/connect", f.form("someone-else"), nil)
			if resp.StatusCode != http.StatusSeeOther {
				t.Fatalf("signed out: status %d", resp.StatusCode)
			}
			resp, body := post(t, s.owner, s.url+"/desktop/connect", f.form("someone-else"), nil)
			if resp.StatusCode != http.StatusConflict || !strings.Contains(body, "signed in as someone else") {
				t.Fatalf("another account: status %d: %s", resp.StatusCode, body)
			}
		})

		t.Run("only a well-formed request is answered", func(t *testing.T) {
			f := newDesktopFlow()
			for name, form := range map[string]url.Values{
				"no state":           {"challenge": {f.challenge}, "user": {ownerID}},
				"a state with signs": {"state": {"a<b>c" + f.state}, "challenge": {f.challenge}, "user": {ownerID}},
				"no challenge":       {"state": {f.state}, "user": {ownerID}},
				"a plain challenge":  {"state": {f.state}, "challenge": {f.verifier}, "user": {ownerID}},
			} {
				if resp, body := post(t, s.owner, s.url+"/desktop/connect", form, nil); resp.StatusCode != http.StatusBadRequest {
					t.Errorf("%s: status %d: %s", name, resp.StatusCode, body)
				}
			}
			if resp, _ := app().get(t, s.url+"/desktop/finish"); resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("finish with nothing: status %d", resp.StatusCode)
			}
		})

		var totpSecret string
		t.Run("two-step codes were given in the browser already", func(t *testing.T) {
			var setup struct{ Secret string }
			s.call(s.owner, "", "POST", "/api/v1/auth/totp/start", M{}, 200, &setup)
			totpSecret = setup.Secret
			s.call(s.owner, "", "POST", "/api/v1/auth/totp/enable", M{"code": auth.TOTPCode(setup.Secret, time.Now())}, 200, nil)
			f := newDesktopFlow()
			code := approve(t, s, s.owner, f, ownerID)
			a := app()
			if resp, _ := a.get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusFound {
				t.Fatalf("finish: status %d", resp.StatusCode)
			}
			s.call(a.hc, "", "GET", "/api/v1/auth/me", nil, 200, nil)
		})

		t.Run("the app's session took the steps the browser's took, no more", func(t *testing.T) {
			if totpSecret == "" {
				t.Skip("the owner has no two-step codes: the subtest before failed")
			}
			twoStep := func(hc *http.Client) bool {
				t.Helper()
				u, _ := url.Parse(s.url)
				for _, ck := range hc.Jar.Cookies(u) {
					if ck.Name == "quadit_session" {
						var sess core.Session
						if _, err := store.Find(context.Background(), st, &sess, store.Eq("token_hash", auth.Hash(ck.Value))); err != nil {
							t.Fatal(err)
						}
						return sess.TwoStep
					}
				}
				t.Fatal("no session cookie")
				return false
			}
			b := browser()
			var first struct {
				SecondStep bool `json:"second_step"`
			}
			s.call(b, "", "POST", "/api/v1/auth/login", M{"email": "owner@example.com", "password": "correct-horse-battery"}, 200, &first)
			if !first.SecondStep {
				t.Fatal("the password let a person with codes in")
			}
			// The next step's code: the one the subtest before gave is spent.
			s.call(b, "", "POST", "/api/v1/auth/second-step", M{"code": auth.TOTPCode(totpSecret, time.Now().Add(30*time.Second))}, 200, nil)

			// The browser took two steps: so does the app.
			f := newDesktopFlow()
			code := approve(t, s, b, f, ownerID)
			a := app()
			if resp, _ := a.get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusFound {
				t.Fatalf("finish: status %d", resp.StatusCode)
			}
			s.call(a.hc, "", "GET", "/api/v1/auth/me", nil, 200, nil)
			if !twoStep(a.hc) {
				t.Fatal("the app's session from a browser of two steps is of one")
			}

			// A browser session of one step (one from before steps were
			// recorded) hands over a session that owes the second step.
			u, _ := url.Parse(s.url)
			for _, ck := range b.Jar.Cookies(u) {
				if ck.Name == "quadit_session" {
					if _, err := st.Update(context.Background(), "sessions", map[string]any{"two_step": false}, store.Eq("token_hash", auth.Hash(ck.Value))); err != nil {
						t.Fatal(err)
					}
				}
			}
			f = newDesktopFlow()
			code = approve(t, s, b, f, ownerID)
			a = app()
			if resp, _ := a.get(t, finishURL(s, code, f.verifier)); resp.StatusCode != http.StatusFound {
				t.Fatalf("finish: status %d", resp.StatusCode)
			}
			if out := s.call(a.hc, "", "GET", "/api/v1/auth/me", nil, 401, nil); !strings.Contains(out, "second_step") {
				t.Fatalf("the app's session from a browser of one step skipped the second: %s", out)
			}
			if twoStep(a.hc) {
				t.Fatal("the hand-off made a session of one step into one of two")
			}
		})
	})
}
