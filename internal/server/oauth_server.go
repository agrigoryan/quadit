package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// MCP clients sign a person in with OAuth 2.1: the client registers itself,
// sends the person here to approve it for one workspace, and gets a token
// that acts as that person there. The token is an ordinary API token of
// kind "oauth", so it shows in the token list and is revoked the same way.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /.well-known/oauth-protected-resource", s.hOAuthResource)
		m.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.hOAuthResource)
		m.HandleFunc("GET /.well-known/oauth-authorization-server", s.hOAuthMeta)
		m.HandleFunc("POST /oauth/register", s.open(s.hOAuthRegister))
		m.HandleFunc("GET /oauth/authorize", s.open(s.hOAuthAuthorize))
		m.HandleFunc("POST /oauth/authorize", s.open(s.hOAuthApprove))
		m.HandleFunc("POST /oauth/token", s.hOAuthToken)
	})
}

func (s *Server) hOAuthResource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"resource": s.cfg.BaseURL + "/mcp", "authorization_servers": []string{s.cfg.BaseURL},
		"bearer_methods_supported": []string{"header"}})
}

func (s *Server) hOAuthMeta(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	b := s.cfg.BaseURL
	json.NewEncoder(w).Encode(map[string]any{"issuer": b, "authorization_endpoint": b + "/oauth/authorize", "token_endpoint": b + "/oauth/token",
		"registration_endpoint": b + "/oauth/register", "response_types_supported": []string{"code"},
		"grant_types_supported": []string{"authorization_code", "refresh_token"}, "code_challenge_methods_supported": []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"}, "scopes_supported": []string{"read", "write"}})
}

// hOAuthRegister lets a client introduce itself (RFC 7591).
func (s *Server) hOAuthRegister(x *c) error {
	var b struct {
		Name         string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(x.w, x.r.Body, 1<<16)).Decode(&b); err != nil {
		return errBad("send the client's name and redirect_uris as JSON")
	}
	if len(b.RedirectURIs) == 0 {
		return errBad("redirect_uris is required")
	}
	for _, u := range b.RedirectURIs {
		pu, err := url.Parse(u)
		// A redirect goes to https, or to the person's own machine.
		if err != nil || pu.Scheme == "" || (pu.Scheme == "http" && pu.Hostname() != "localhost" && pu.Hostname() != "127.0.0.1" && pu.Hostname() != "::1") {
			return errBad("redirect URI %q must be https, a local address, or an app's own scheme", u)
		}
	}
	if err := s.throttle(x.ctx(), "oauth-register:"+clientIP(x.r), 30, time.Hour); err != nil {
		return err
	}
	cl := core.OAuthClient{ID: "qc_" + auth.Random(16), Name: strings.TrimSpace(b.Name), RedirectURIs: b.RedirectURIs, CreatedAt: time.Now().UnixMilli()}
	if cl.Name == "" {
		cl.Name = "An MCP client"
	}
	if err := s.st.Insert(x.ctx(), cl); err != nil {
		return err
	}
	return x.json(201, map[string]any{"client_id": cl.ID, "client_name": cl.Name, "redirect_uris": cl.RedirectURIs,
		"token_endpoint_auth_method": "none", "grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}})
}

type authRequest struct {
	ClientID    string `json:"client_id"`
	RedirectURI string `json:"redirect_uri"`
	State       string `json:"state"`
	Challenge   string `json:"challenge"`
	Scope       string `json:"scope"`
	UserID      string `json:"user_id"`
	WorkspaceID string `json:"workspace_id"`
}

var consentPage = template.Must(template.New("consent").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Allow access</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f6f6f7;color:#18181b;display:grid;place-items:center;min-height:100vh;margin:0}
@media(prefers-color-scheme:dark){body{background:#111113;color:#ededef}.card{background:#1b1b1f!important;border-color:#2e2e33!important}select{background:#111113;color:inherit;border-color:#2e2e33}}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px;max-width:420px;width:calc(100% - 48px)}
h1{font-size:19px;margin:0 0 8px}p{margin:8px 0;color:#71717a}b{color:inherit}
select{width:100%;font:inherit;padding:8px;border-radius:8px;border:1px solid #d4d4d8;margin:8px 0 16px}
.row{display:flex;gap:10px;justify-content:flex-end;margin-top:12px}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #d4d4d8;background:transparent;color:inherit;cursor:pointer}
button.go{background:#4f46e5;border-color:#4f46e5;color:#fff}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<h1>Allow {{.Client}} to work as you?</h1>
<p><b>{{.Client}}</b> will be able to read and change tasks, decisions and docs as <b>{{.User}}</b>, in the workspace you pick.
You can take this back at any time in Settings, under tokens.</p>
<label for="ws">Workspace</label>
<select id="ws" name="workspace">{{range .Workspaces}}<option value="{{.ID}}">{{.Name}}</option>{{end}}</select>
<input type="hidden" name="request" value="{{.Request}}">
<div class="row"><button name="answer" value="deny">Cancel</button><button class="go" name="answer" value="allow">Allow</button></div>
</form></body></html>`))

// hOAuthAuthorize shows the person what a client is asking for. Someone not
// signed in is sent to sign in and comes back here.
func (s *Server) hOAuthAuthorize(x *c) error {
	q := x.r.URL.Query()
	ctx := x.ctx()
	var cl core.OAuthClient
	if err := s.st.Get(ctx, &cl, store.Eq("id", q.Get("client_id"))); err != nil {
		return errBad("unknown client; the client must register first")
	}
	if !has(cl.RedirectURIs, q.Get("redirect_uri")) {
		return errBad("that redirect URI is not one the client registered")
	}
	if q.Get("response_type") != "code" || q.Get("code_challenge") == "" || (q.Get("code_challenge_method") != "S256" && q.Get("code_challenge_method") != "") {
		return errBad("this server takes response_type=code with a S256 code_challenge")
	}
	if err := s.identify(x); err != nil || x.sess == nil || x.user.Kind != core.KindPerson {
		http.Redirect(x.w, x.r, "/login?next="+url.QueryEscape(x.r.URL.RequestURI()), http.StatusFound)
		return nil
	}
	wss, err := s.memberships(ctx, x.user.ID)
	if err != nil {
		return err
	}
	if len(wss) == 0 {
		return errBad("you are not in any workspace yet")
	}
	req := authRequest{ClientID: cl.ID, RedirectURI: q.Get("redirect_uri"), State: q.Get("state"), Challenge: q.Get("code_challenge"), Scope: q.Get("scope"), UserID: x.user.ID}
	token, err := s.oneTime(ctx, "oauth_consent", x.user.ID, req, 15*time.Minute)
	if err != nil {
		return err
	}
	x.w.Header().Set("Content-Type", "text/html; charset=utf-8")
	x.w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' "+originOf(req.RedirectURI))
	return consentPage.Execute(x.w, map[string]any{"Client": cl.Name, "User": x.user.Name, "Workspaces": wss, "Request": token})
}

func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// hOAuthApprove takes the person's answer and sends the browser back to the
// client with a one-time code.
func (s *Server) hOAuthApprove(x *c) error {
	ctx := x.ctx()
	if err := x.r.ParseForm(); err != nil {
		return errBad("bad form")
	}
	if err := s.identify(x); err != nil || x.sess == nil {
		return errUnauthorized("sign in first")
	}
	ot, err := s.useOneTime(ctx, "oauth_consent", x.r.PostForm.Get("request"), false)
	if err != nil || ot.UserID != x.user.ID {
		return errBad("this request has expired; start again from the client")
	}
	var req authRequest
	json.Unmarshal(ot.Data, &req)
	back, _ := url.Parse(req.RedirectURI)
	q := back.Query()
	if req.State != "" {
		q.Set("state", req.State)
	}
	if x.r.PostForm.Get("answer") != "allow" {
		q.Set("error", "access_denied")
	} else {
		req.WorkspaceID = x.r.PostForm.Get("workspace")
		if n, _ := s.st.Count(ctx, "members", store.Eq("workspace_id", req.WorkspaceID), store.Eq("user_id", x.user.ID), store.Null("removed_at")); n == 0 {
			return errBad("you are not a member of that workspace")
		}
		code, err := s.oneTime(ctx, "oauth_code", x.user.ID, req, 5*time.Minute)
		if err != nil {
			return err
		}
		q.Set("code", code)
		s.audit(x.r, req.WorkspaceID, x.user, "oauth.approved", "client", req.ClientID, nil)
	}
	back.RawQuery = q.Encode()
	http.Redirect(x.w, x.r, back.String(), http.StatusFound)
	return nil
}

const (
	accessLife  = 8 * time.Hour
	refreshLife = 90 * 24 * time.Hour
)

// hOAuthToken trades a code, or a refresh token, for an access token.
func (s *Server) hOAuthToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	fail := func(code, desc string) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": desc})
	}
	if err := r.ParseForm(); err != nil {
		fail("invalid_request", "send a form")
		return
	}
	f := r.PostForm
	issue := func(userID, workspaceID, clientID, scope string) {
		access, prefix := auth.NewAPIToken()
		refresh := "qr_" + auth.Random(32)
		now := time.Now()
		scopes := ""
		if scope == "read" {
			scopes = "read"
		}
		var cl core.OAuthClient
		s.st.Get(ctx, &cl, store.Eq("id", clientID))
		t := core.APIToken{ID: id.New(), WorkspaceID: workspaceID, UserID: userID, Name: orText(cl.Name, "MCP client"), TokenHash: auth.Hash(access), Prefix: prefix,
			Scopes: scopes, Kind: "oauth", ClientID: clientID, RefreshHash: auth.Hash(refresh), CreatedBy: userID, CreatedAt: now.UnixMilli(),
			ExpiresAt: now.Add(accessLife).UnixMilli()}
		if err := s.st.Insert(ctx, t); err != nil {
			fail("server_error", "the token could not be stored")
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(accessLife.Seconds()),
			"refresh_token": refresh, "scope": orText(scope, "read write")})
	}
	switch f.Get("grant_type") {
	case "authorization_code":
		ot, err := s.useOneTime(ctx, "oauth_code", f.Get("code"), false)
		if err != nil {
			fail("invalid_grant", "the code is not valid or was already used")
			return
		}
		var req authRequest
		json.Unmarshal(ot.Data, &req)
		sum := sha256.Sum256([]byte(f.Get("code_verifier")))
		if req.ClientID != f.Get("client_id") || req.RedirectURI != f.Get("redirect_uri") || base64.RawURLEncoding.EncodeToString(sum[:]) != req.Challenge {
			fail("invalid_grant", "the client, redirect URI or code verifier does not match the request")
			return
		}
		issue(req.UserID, req.WorkspaceID, req.ClientID, req.Scope)
	case "refresh_token":
		var old core.APIToken
		if err := s.st.Get(ctx, &old, store.Eq("refresh_hash", auth.Hash(f.Get("refresh_token"))), store.Null("revoked_at")); err != nil ||
			old.CreatedAt < time.Now().Add(-refreshLife).UnixMilli() || (f.Get("client_id") != "" && f.Get("client_id") != old.ClientID) {
			fail("invalid_grant", "the refresh token is not valid; sign in again")
			return
		}
		// A refresh token works once: the old pair ends as the new one starts.
		s.st.Update(ctx, "api_tokens", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("id", old.ID))
		scope := ""
		if old.Scopes == "read" {
			scope = "read"
		}
		issue(old.UserID, old.WorkspaceID, old.ClientID, scope)
	default:
		fail("unsupported_grant_type", "use authorization_code or refresh_token")
	}
}
