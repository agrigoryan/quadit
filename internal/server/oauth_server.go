package server

// This server as the OAuth 2.1 authorization server of MCP clients.

import (
	"context"
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
		m.HandleFunc("GET /.well-known/oauth-protected-resource", s.handleDescribeProtectedResource)
		m.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.handleDescribeProtectedResource)
		m.HandleFunc("GET /.well-known/oauth-authorization-server", s.handleDescribeAuthorizationServer)
		m.HandleFunc("POST /oauth/register", s.public(s.handleRegisterOAuthClient))
		m.HandleFunc("GET /oauth/authorize", s.public(s.handleShowConsentPage))
		m.HandleFunc("POST /oauth/authorize", s.public(s.handleAnswerConsentPage))
		m.HandleFunc("POST /oauth/token", s.handleIssueOAuthToken)
	})
}

func (s *Server) handleDescribeProtectedResource(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"resource": s.cfg.BaseURL + "/mcp", "authorization_servers": []string{s.cfg.BaseURL},
		"bearer_methods_supported": []string{"header"}})
}

func (s *Server) handleDescribeAuthorizationServer(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	b := s.cfg.BaseURL
	json.NewEncoder(w).Encode(map[string]any{"issuer": b, "authorization_endpoint": b + "/oauth/authorize", "token_endpoint": b + "/oauth/token",
		"registration_endpoint": b + "/oauth/register", "response_types_supported": []string{"code"},
		"grant_types_supported": []string{"authorization_code", "refresh_token"}, "code_challenge_methods_supported": []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"}, "scopes_supported": []string{"read", "write"}})
}

// handleRegisterOAuthClient lets a client introduce itself (RFC 7591).
func (s *Server) handleRegisterOAuthClient(x *c) error {
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
	// ActAs is whose name the client works under: an agent the approver
	// answers for, or the approver.
	ActAs string `json:"act_as"`
}

// oauthActor is one name a client can be let in under.
type oauthActor struct {
	Value string // workspace id, a colon, the member's user id
	Label string
	Agent bool
}

// oauthActors lists, per workspace the person is in, the agents they may let
// a client work as (those they answer for; every agent for an admin), and
// themselves.
func (s *Server) oauthActors(ctx context.Context, u core.User) ([]struct {
	Name   string
	Actors []oauthActor
}, error) {
	wss, err := s.memberships(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	var out []struct {
		Name   string
		Actors []oauthActor
	}
	for _, ws := range wss {
		var members []core.Member
		if err := s.st.In(ws.ID).List(ctx, &members, store.Q{Where: []store.Cond{store.Eq("kind", core.KindAgent), store.Null("removed_at"), store.Null("suspended_at")}, Order: "name"}); err != nil {
			return nil, err
		}
		s.withResponsible(ctx, members)
		group := struct {
			Name   string
			Actors []oauthActor
		}{Name: ws.Name}
		for _, m := range members {
			if m.ResponsibleID == u.ID || ws.Role.AtLeast(core.RoleAdmin) {
				group.Actors = append(group.Actors, oauthActor{Value: ws.ID + ":" + m.UserID, Label: m.Name + " (agent, @" + m.Handle + ")", Agent: true})
			}
		}
		group.Actors = append(group.Actors, oauthActor{Value: ws.ID + ":" + u.ID, Label: u.Name + " (yourself)"})
		out = append(out, group)
	}
	return out, nil
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
<h1>Let {{.Client}} in?</h1>
<p><b>{{.Client}}</b> will be able to read and change tasks, decisions and docs under the name you pick.
Pick an agent, so that what it does is shown as the agent's work and not as yours.
You can take this back at any time in Settings, under tokens.</p>
<label for="as">It works as</label>
<select id="as" name="as">{{range .Groups}}<optgroup label="{{.Name}}">{{range .Actors}}<option value="{{.Value}}">{{.Label}}</option>{{end}}</optgroup>{{end}}</select>
{{if not .HasAgent}}<p>You have no agent to offer yet. An admin makes one in Settings, under Agents; until then it can only work as you.</p>{{end}}
<input type="hidden" name="request" value="{{.Request}}">
<div class="row"><button name="answer" value="deny">Cancel</button><button class="go" name="answer" value="allow">Allow</button></div>
</form></body></html>`))

// handleShowConsentPage shows the person what a client is asking for. Someone not
// signed in is sent to sign in and comes back here.
func (s *Server) handleShowConsentPage(x *c) error {
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
	if signedIn := s.identify(x) == nil && x.sess != nil && x.user.Kind == core.KindPerson; !signedIn {
		http.Redirect(x.w, x.r, "/login?next="+url.QueryEscape(x.r.URL.RequestURI()), http.StatusFound)
		return nil
	}
	groups, err := s.oauthActors(ctx, x.user)
	if err != nil {
		return err
	}
	if len(groups) == 0 {
		return errBad("you are not in any workspace yet")
	}
	hasAgent := false
	for _, g := range groups {
		for _, a := range g.Actors {
			hasAgent = hasAgent || a.Agent
		}
	}
	req := authRequest{ClientID: cl.ID, RedirectURI: q.Get("redirect_uri"), State: q.Get("state"), Challenge: q.Get("code_challenge"), Scope: q.Get("scope"), UserID: x.user.ID}
	token, err := s.oneTime(ctx, "oauth_consent", x.user.ID, req, 15*time.Minute)
	if err != nil {
		return err
	}
	x.w.Header().Set("Content-Type", "text/html; charset=utf-8")
	x.w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' "+originOf(req.RedirectURI))
	return consentPage.Execute(x.w, map[string]any{"Client": cl.Name, "User": x.user.Name, "Groups": groups, "HasAgent": hasAgent, "Request": token})
}

func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// handleAnswerConsentPage takes the person's answer and sends the browser back to the
// client with a one-time code.
func (s *Server) handleAnswerConsentPage(x *c) error {
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
	if err := json.Unmarshal(ot.Data, &req); err != nil {
		return err
	}
	back, err := url.Parse(req.RedirectURI)
	if err != nil {
		return err
	}
	q := back.Query()
	if req.State != "" {
		q.Set("state", req.State)
	}
	if x.r.PostForm.Get("answer") != "allow" {
		q.Set("error", "access_denied")
	} else {
		// "as" names the workspace and who the client works as; a plain
		// "workspace" means as the person themselves.
		req.WorkspaceID, req.ActAs = x.r.PostForm.Get("workspace"), x.user.ID
		if as := x.r.PostForm.Get("as"); as != "" {
			req.WorkspaceID, req.ActAs, _ = strings.Cut(as, ":")
		}
		groups, err := s.oauthActors(ctx, x.user)
		if err != nil {
			return err
		}
		allowed := false
		for _, g := range groups {
			for _, a := range g.Actors {
				allowed = allowed || a.Value == req.WorkspaceID+":"+req.ActAs
			}
		}
		if !allowed {
			return errBad("you cannot let a client work as that member there")
		}
		code, err := s.oneTime(ctx, "oauth_code", x.user.ID, req, 5*time.Minute)
		if err != nil {
			return err
		}
		q.Set("code", code)
		s.audit(x.r, req.WorkspaceID, x.user, "oauth.approved", "client", req.ClientID, map[string]string{"works_as": req.ActAs})
	}
	back.RawQuery = q.Encode()
	http.Redirect(x.w, x.r, back.String(), http.StatusFound)
	return nil
}

// How long an MCP client's tokens last, and how long a person has to
// answer a consent page, or to sign in at an outside provider.
const (
	accessLife  = 8 * time.Hour
	refreshLife = 90 * 24 * time.Hour
)

// handleIssueOAuthToken trades a code, or a refresh token, for an access token.
func (s *Server) handleIssueOAuthToken(w http.ResponseWriter, r *http.Request) {
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
		if err := s.st.Get(ctx, &cl, store.Eq("id", clientID)); err != nil {
			s.log.Warn("oauth token: the client's name is not known; the token gets a plain one", "err", err)
		}
		t := core.APIToken{ID: id.New(), WorkspaceID: workspaceID, UserID: userID, Name: firstNonEmpty(cl.Name, "MCP client"), TokenHash: auth.Hash(access), Prefix: prefix,
			Scopes: scopes, Kind: "oauth", ClientID: clientID, RefreshHash: auth.Hash(refresh), CreatedBy: userID, CreatedAt: now.UnixMilli(),
			ExpiresAt: now.Add(accessLife).UnixMilli()}
		if err := s.st.Insert(ctx, t); err != nil {
			fail("server_error", "the token could not be stored")
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(accessLife.Seconds()),
			"refresh_token": refresh, "scope": firstNonEmpty(scope, "read write")})
	}
	switch f.Get("grant_type") {
	case "authorization_code":
		ot, err := s.useOneTime(ctx, "oauth_code", f.Get("code"), false)
		if err != nil {
			fail("invalid_grant", "the code is not valid or was already used")
			return
		}
		var req authRequest
		if err := json.Unmarshal(ot.Data, &req); err != nil {
			s.log.Error("oauth token: the stored request does not read", "err", err)
			fail("server_error", "the code could not be read")
			return
		}
		sum := sha256.Sum256([]byte(f.Get("code_verifier")))
		if req.ClientID != f.Get("client_id") || req.RedirectURI != f.Get("redirect_uri") || base64.RawURLEncoding.EncodeToString(sum[:]) != req.Challenge {
			fail("invalid_grant", "the client, redirect URI or code verifier does not match the request")
			return
		}
		issue(firstNonEmpty(req.ActAs, req.UserID), req.WorkspaceID, req.ClientID, req.Scope)
	case "refresh_token":
		var old core.APIToken
		if err := s.st.Get(ctx, &old, store.Eq("refresh_hash", auth.Hash(f.Get("refresh_token"))), store.Null("revoked_at")); err != nil ||
			old.CreatedAt < time.Now().Add(-refreshLife).UnixMilli() || (f.Get("client_id") != "" && f.Get("client_id") != old.ClientID) {
			fail("invalid_grant", "the refresh token is not valid; sign in again")
			return
		}
		// A refresh token works once: the old pair ends as the new one
		// starts, and no new one starts while the old one cannot end.
		if _, err := s.st.Update(ctx, "api_tokens", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("id", old.ID)); err != nil {
			s.log.Error("oauth token: the old pair could not be revoked, so no new one is issued", "err", err)
			fail("server_error", "the refresh token could not be spent; try again")
			return
		}
		scope := ""
		if old.Scopes == "read" {
			scope = "read"
		}
		issue(old.UserID, old.WorkspaceID, old.ClientID, scope)
	default:
		fail("unsupported_grant_type", "use authorization_code or refresh_token")
	}
}
