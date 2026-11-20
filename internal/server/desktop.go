package server

// The desktop app: signing it in through the system browser.
//
// Passkeys and outside providers do not work inside the app's own window,
// so the app signs in where they do. It opens the system browser at
// /desktop/connect with a state and a PKCE challenge of its own; the web
// app's page there (web/src/auth/desktop-connect.tsx) has whoever is signed
// in confirm it, sending them through the normal sign-in first, and posts
// Continue here. The browser is then sent to quadit://connect with a code
// that works once, for two minutes, and only with the verifier the
// challenge was made from. The app loads /desktop/finish in its window
// with the code and the verifier, and the window gets a session of its own,
// made as any sign-in makes one (signIn), of the steps the browser's
// session took (desktopGrant).

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// desktopHandoff is the version of the sign-in hand-off this server speaks
// to the desktop app; GET /api/v1/version says it, so an app can tell a
// server too old or too new for it.
const desktopHandoff = 1

// desktopInset is the version of the window without a title bar that this
// server's web app lays itself out for (web/src/lib/window-inset.ts);
// GET /api/v1/version says it too. On macOS the app makes a server's window
// without one only for pages that keep clear of its buttons and can drag it.
const desktopInset = 1

// desktopCodeLife is how long the app has to trade a code for a session.
const desktopCodeLife = 2 * time.Minute

// desktopRoutes are the server's side of the desktop app's sign-in. The
// page that asks the person (GET /desktop/connect) is the web app's.
func (s *Server) desktopRoutes() []route {
	return []route{
		{"POST /desktop/connect", s.public(s.handleApproveDesktopSignIn), "The person's Continue on the page that signs the desktop app in. Form: {state, challenge, user}. Sends the browser to quadit://connect with a code.", "", "account"},
		{"GET /desktop/finish", s.public(s.handleFinishDesktopSignIn), "The desktop app's window trades the code for a session of its own, and is sent to /.", "code: from the quadit://connect link; verifier: the PKCE verifier the challenge was made from", "account"},
	}
}

// What the app may send: a state of its own, the S256 challenge (the
// base64url of a SHA-256 sum, 43 characters), and the verifier (RFC 7636:
// 43 to 128 unreserved characters).
var (
	desktopState     = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
	desktopChallenge = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	desktopVerifier  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

// desktopGrant is what a code stands for besides its person: the flow the
// app started, and whether the browser session that approved it took two
// steps. The app's session takes no more than that: a browser signed in
// with one step hands over a session that owes the second where a password
// sign-in would (startSession).
type desktopGrant struct {
	Challenge string `json:"challenge"`
	State     string `json:"state"`
	TwoStep   bool   `json:"two_step,omitempty"`
}

// handleApproveDesktopSignIn takes the person's Continue and sends the
// browser to the app with a code. Only the server's own page can press it
// (sentFrom): any other page, a sibling site's included, could otherwise
// skip the question the page asks. This is stricter than every other write
// (refuseOtherPages): a post that is the person's own doing, or that says
// nothing of where it comes from, is no press of Continue either. Someone
// no longer signed in is sent to sign in and back to the page. The session
// cookie decides who is signed in. The confirm page names the account it asks about (user), and a
// browser signed in as someone else since is refused.
func (s *Server) handleApproveDesktopSignIn(x *c) error {
	x.w.Header().Set("Cache-Control", "no-store")
	if s.sentFrom(x.r) != fromOwnPage {
		return s.showDesktopPage(x, http.StatusForbidden, desktopRefused)
	}
	if err := x.r.ParseForm(); err != nil {
		return s.showDesktopPage(x, http.StatusBadRequest, desktopNotValid)
	}
	form := x.r.PostForm
	grant := desktopGrant{Challenge: form.Get("challenge"), State: form.Get("state")}
	if !desktopChallenge.MatchString(grant.Challenge) || !desktopState.MatchString(grant.State) {
		return s.showDesktopPage(x, http.StatusBadRequest, desktopNotValid)
	}
	ctx := x.ctx()
	// The app is handed what this browser has: a person the install requires
	// a second step of, who has none yet, gets a session in which to set it
	// up, as this one is.
	x.needs = toSetUpSecondStep
	err := s.identify(ctx, x)
	var he *httpError
	switch {
	case errors.As(err, &he) && he.Status == http.StatusUnauthorized:
		// Signed out, or the second step still owed: the sign-in page, then this page again.
		page := "/desktop/connect?" + url.Values{"state": {grant.State}, "challenge": {grant.Challenge}}.Encode()
		http.Redirect(x.w, x.r, "/login?next="+url.QueryEscape(page), http.StatusSeeOther)
		return nil
	case errors.As(err, new(*engine.Error)):
		return s.showDesktopPage(x, http.StatusForbidden, desktopRefused)
	case err != nil:
		return s.showDesktopFailure(x, err)
	case x.sess == nil || x.user.Kind != core.KindPerson:
		// A token is not a person at a browser: it never becomes a session.
		return s.showDesktopPage(x, http.StatusForbidden, desktopRefused)
	case form.Get("user") != x.user.ID:
		return s.showDesktopPage(x, http.StatusConflict, desktopSomeoneElse)
	}
	if err := s.throttle(ctx, "desktop:user:"+x.user.ID, signInsPerEmail, signInWindow); err != nil {
		return s.showDesktopFailure(x, err)
	}
	grant.TwoStep = x.sess.TwoStep
	code, err := s.oneTime(ctx, core.OneTimeDesktopCode, x.user.ID, grant, desktopCodeLife)
	if err != nil {
		return s.showDesktopFailure(x, err)
	}
	// The address is always the app's own: nothing in the request chooses where the code goes.
	link := url.URL{Scheme: "quadit", Host: "connect", RawQuery: url.Values{"server": {s.cfg.BaseURL}, "code": {code}, "state": {grant.State}}.Encode()}
	http.Redirect(x.w, x.r, link.String(), http.StatusSeeOther)
	return nil
}

// handleFinishDesktopSignIn trades a code and its verifier for a session in
// the app's window. Only the app's own hand-off is answered (isDesktopHandoff).
// Otherwise a code made for one account, opened in someone else's browser or
// app by a link or a page, would sign it in as that account (login CSRF).
// The code is spent before the verifier is checked, so a code someone else
// caught is good for one wrong guess at most; of two windows racing with one
// code, one gets the session. Every failure of the code is the same plain
// page: which check failed is not said.
func (s *Server) handleFinishDesktopSignIn(x *c) error {
	x.w.Header().Set("Cache-Control", "no-store")
	ctx := x.ctx()
	// Refused before it counts: what is not the app costs no one a sign-in.
	if !isDesktopHandoff(x.r) {
		return s.showDesktopPage(x, http.StatusForbidden, desktopNotTheApp)
	}
	// A finish is a sign-in: it counts against the address as one does.
	if err := s.throttle(ctx, "login:ip:"+s.clientIP(x.r), signInsPerIP, signInWindow); err != nil {
		return s.showDesktopFailure(x, err)
	}
	q := x.r.URL.Query()
	verifier := q.Get("verifier")
	if q.Get("code") == "" || !desktopVerifier.MatchString(verifier) {
		return s.showDesktopPage(x, http.StatusBadRequest, desktopExpired)
	}
	spent, err := s.useOneTime(ctx, core.OneTimeDesktopCode, q.Get("code"))
	if _, refused := errors.AsType[*engine.Error](err); refused {
		return s.showDesktopPage(x, http.StatusBadRequest, desktopExpired)
	}
	if err != nil {
		return s.showDesktopFailure(x, err)
	}
	var grant desktopGrant
	if err := json.Unmarshal(spent.Data, &grant); err != nil {
		return s.showDesktopFailure(x, err)
	}
	sum := sha256.Sum256([]byte(verifier))
	if subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(grant.Challenge)) != 1 {
		return s.showDesktopPage(x, http.StatusBadRequest, desktopExpired)
	}
	var u core.User
	there, err := store.Find(ctx, s.st, &u, store.Eq("id", spent.UserID), store.Live)
	if err != nil {
		return s.showDesktopFailure(x, err)
	}
	if !there || u.Kind != core.KindPerson || u.DisabledAt != 0 {
		return s.showDesktopPage(x, http.StatusForbidden, desktopDisabled)
	}
	if _, err := s.signIn(x, u, "desktop", grant.TwoStep); err != nil {
		return s.showDesktopFailure(x, err)
	}
	http.Redirect(x.w, x.r, "/", http.StatusFound)
	return nil
}

// isDesktopHandoff reports whether a request for /desktop/finish is the
// desktop app's own hand-off: the app's main process loading the address in
// its window, which it does only for a sign-in it started and checked. That
// load, and nothing else, carries the header X-Quadit-Handoff: 1: a link, a
// redirect or a page cannot add a header to a navigation, and a page's
// fetch, which can, is no navigation the browser started (Sec-Fetch-Site
// "none"). The user agent says it is the app's window at all. A browser
// that sends no Fetch Metadata is judged by the header alone.
func isDesktopHandoff(r *http.Request) bool {
	site := r.Header.Get("Sec-Fetch-Site")
	return r.Header.Get("X-Quadit-Handoff") == "1" &&
		strings.Contains(r.UserAgent(), " QuaditDesktop/") &&
		(site == "" || site == "none")
}

// desktopWords are what a plain page of the hand-off says.
type desktopWords struct{ Title, Message string }

var (
	desktopNotValid = desktopWords{"This sign-in request is not valid",
		"The link that opened this page is incomplete or was changed. Start again from the Quadit app."}
	desktopRefused = desktopWords{"This request was refused",
		"Only Quadit's own page, in a browser where you are signed in, can sign the app in. Start again from the Quadit app."}
	desktopSomeoneElse = desktopWords{"You are signed in as someone else now",
		"This browser signed in to another account after the page was shown. Start again from the Quadit app."}
	desktopNotTheApp = desktopWords{"Open this in the Quadit app",
		"This page finishes signing the Quadit app in, and works only in the app's own window. Start again from the Quadit app."}
	desktopExpired = desktopWords{"Signing in to the app did not work",
		"The sign-in has expired or was used already. Start again from the Quadit app."}
	desktopDisabled = desktopWords{"This account cannot sign in",
		"The account is disabled or no longer exists. Start again from the Quadit app with another account."}
	desktopBusy = desktopWords{"Too many attempts",
		"Wait a few minutes, then start again from the Quadit app."}
	desktopBroken = desktopWords{"Something went wrong on the server",
		"Nothing was changed. Start again from the Quadit app; if it keeps happening, the server's log has the details."}
)

// desktopPage is shown in the app's window. On macOS that window may have no
// title bar (desktop contract §9): its window-strip, as tall as the title
// area the window's controls overlay gives the page and of no height
// anywhere else, is what the window is dragged by.
var desktopPage = template.Must(template.New("desktop").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{{.Title}}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f6f6f7;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0}
@media(prefers-color-scheme:dark){body{background:#111113;color:#ededef}.card{background:#1b1b1f!important;border-color:#2e2e33!important}}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;max-width:420px;width:calc(100% - 48px)}
h1{font-size:19px;margin:0 0 8px}p{margin:8px 0;color:#71717a}
.window-strip{position:fixed;top:0;left:0;right:0;height:env(titlebar-area-height,0px);app-region:drag}
</style></head><body><div class="window-strip"></div><main class="card"><h1>{{.Title}}</h1><p>{{.Message}}</p></main></body></html>`))

// showDesktopPage answers with a plain page saying why the hand-off stops.
func (s *Server) showDesktopPage(x *c, status int, words desktopWords) error {
	h := x.w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
	x.w.WriteHeader(status)
	return desktopPage.Execute(x.w, words)
}

// showDesktopFailure answers a failure that is not the request's fault: too
// many attempts, or something on this side, which is logged (never with the
// request's address, which carries the code).
func (s *Server) showDesktopFailure(x *c, err error) error {
	var he *httpError
	if errors.As(err, &he) && he.Status == http.StatusTooManyRequests {
		x.w.Header().Set("Retry-After", strconv.Itoa(he.RetryAfter))
		return s.showDesktopPage(x, http.StatusTooManyRequests, desktopBusy)
	}
	s.log.Error("desktop sign-in", "path", x.r.URL.Path, "err", err)
	return s.showDesktopPage(x, http.StatusInternalServerError, desktopBroken)
}
