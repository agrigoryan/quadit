package server

// Which page a browser's write comes from. A browser adds the session
// cookie to every request made to the server, whichever page makes it: a
// page of another site, or of a sibling site under the same domain
// (another.example.com beside quadit.example.com), which SameSite=Lax does
// not stop. So a write a browser may have sent is taken only from the
// server's own pages.

import (
	"mime"
	"net/http"
	"net/url"
	"strings"
)

// refuseOtherPages refuses a write a browser may have sent from a page that
// is not one of the server's own. A browser that sends Fetch Metadata says
// where the request comes from (Sec-Fetch-Site): only "same-origin" is
// taken, and "none", which is a person's own doing (an address typed, a
// bookmark). An older browser is judged by the page's origin (Origin, or
// else Referer, which Referrer-Policy: same-origin sends on the server's own
// pages), which must be the server's address. A write that carries the
// session cookie and says none of these is refused too: it cannot be told
// apart from one another site's page made.
//
// A request with an Authorization header is not held to this: a browser
// never adds one by itself, and another site's page cannot set it without
// asking first (CORS), which the server never allows. Nor is a write made
// with no cookie by a program that is not a browser (a sign-in from a
// script, GitHub's webhook, an MCP client getting its token).
func (s *Server) refuseOtherPages(r *http.Request) error {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions || r.Header.Get("Authorization") != "" {
		return nil
	}
	switch s.sentFrom(r) {
	case fromOwnPage, fromPerson:
		return nil
	case fromOtherPage:
		return errForbidden("a write from another site's page is not accepted; use Quadit at %s", s.cfg.BaseURL)
	}
	if _, err := r.Cookie(sessionCookie); err == nil {
		return errForbidden("a write made with the session cookie must say which page it comes from (Origin); a script signs in with a token instead")
	}
	return nil
}

// sender is where a request says it comes from (sentFrom).
type sender int

const (
	fromUnsaid    sender = iota // nothing said: a browser too old to say, or not a browser
	fromOwnPage                 // a page of the server's own origin
	fromPerson                  // the person's own doing: an address typed, a bookmark
	fromOtherPage               // any other page, a sibling site's included
)

// sentFrom tells where a browser's request comes from. A browser that sends
// Fetch Metadata says so in Sec-Fetch-Site; an older one is judged by the
// page's origin (Origin, or else Referer, which Referrer-Policy:
// same-origin sends on the server's own pages) against the server's
// address.
func (s *Server) sentFrom(r *http.Request) sender {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin":
		return fromOwnPage
	case "none":
		return fromPerson
	case "":
	default:
		return fromOtherPage // same-site and cross-site
	}
	page := r.Header.Get("Origin")
	if page == "" {
		page = r.Referer()
	}
	switch {
	case page == "":
		return fromUnsaid
	case s.isOwn(page):
		return fromOwnPage
	default:
		return fromOtherPage
	}
}

// isOwn reports whether an address (a page, or an origin) is on the
// server's own origin.
func (s *Server) isOwn(address string) bool {
	o := originOf(address)
	return o != "" && o == s.origin
}

// originOf is the origin of an address as a browser writes it in Origin:
// scheme://host[:port], lower case, without the port the scheme implies.
// An address with no host ("null", a path) has none: "".
func originOf(address string) string {
	u, err := url.Parse(address)
	if err != nil || u.Host == "" {
		return ""
	}
	host := strings.ToLower(u.Host)
	if p := u.Port(); (u.Scheme == "http" && p == "80") || (u.Scheme == "https" && p == "443") {
		host = strings.ToLower(u.Hostname())
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	}
	return u.Scheme + "://" + host
}

// saysJSON reports whether a request's body is declared JSON
// (application/json, or a type that ends in +json). A form or plain text,
// which another site's page may send without asking first, is not.
func saysJSON(r *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && (mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"))
}
