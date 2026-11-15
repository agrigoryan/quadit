package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/store"
)

// The MCP endpoint: signing the client in, and the in-process call its
// tools make. The protocol and the tools are package mcp.

// mcpRoutes are the routes of the MCP endpoint.
func (s *Server) mcpRoutes() []route {
	return []route{
		{"POST /mcp", s.handleServeMCP, "The MCP endpoint (streamable HTTP). Takes a personal token or an OAuth token as a Bearer credential.", "", "mcp"},
		{"GET /mcp", func(w http.ResponseWriter, _ *http.Request) {
			// No server-to-client stream is offered; clients poll with tools.
			w.Header().Set("Allow", "POST")
			http.Error(w, "this server answers each request directly; use POST", http.StatusMethodNotAllowed)
		}, "The MCP endpoint's event stream, for clients that open one.", "", "mcp"},
	}
}

// handleServeMCP answers one JSON-RPC request posted to /mcp, once the
// client has signed in.
func (s *Server) handleServeMCP(w http.ResponseWriter, r *http.Request) {
	token, ok := s.mcpSignIn(w, r)
	if !ok {
		return
	}
	s.mcp.Serve(w, r, token)
}

// mcpSignIn returns the token a request carries. When there is none, or it
// is not a valid one, it answers the request itself and reports false.
func (s *Server) mcpSignIn(w http.ResponseWriter, r *http.Request) (string, bool) {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		// Calls with no token are counted by where they come from, like
		// wrong ones: a client asks once to learn where to sign in, not
		// hundreds of times.
		if err := s.limits.check("anon:"+clientIP(r), 120); err != nil {
			s.fail(w, r, err)
			return "", false
		}
		// Tell an MCP client where to sign its user in.
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+s.cfg.BaseURL+`/.well-known/oauth-protected-resource"`)
		http.Error(w, "sign in, or send a token", http.StatusUnauthorized)
		return "", false
	}
	// Guesses are counted by where they come from; a token that cannot be
	// looked up is counted as one.
	if n, err := s.st.Count(r.Context(), "api_tokens", store.Eq("token_hash", auth.Hash(token)), store.Null("revoked_at")); err != nil || n == 0 {
		if err := s.limits.check("bad:"+clientIP(r), 120); err != nil {
			s.fail(w, r, err)
			return "", false
		}
	}
	if _, ok := s.callAsToken(r.Context(), token, "GET", "/me", url.Values{"format": {"text"}}, nil, ""); !ok {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="`+s.cfg.BaseURL+`/.well-known/oauth-protected-resource"`)
		http.Error(w, "this token is not valid", http.StatusUnauthorized)
		return "", false
	}
	return token, true
}

// callAsToken is package mcp's way to the API: a call from inside the
// process with token, in its workspace unless the path is under /api/
// already. It answers the text of the answer and whether the call
// succeeded; a refusal comes back as its message.
func (s *Server) callAsToken(ctx context.Context, token, method, path string, q url.Values, body []byte, contentType string) (string, bool) {
	who := bearerOf(ctx, token)
	if strings.HasPrefix(path, "/api/") {
		who.base = "" // a path outside the workspace is given whole
	}
	ans, err := s.selfCall(who, method, path, q, body, contentType)
	if err != nil {
		return err.Error(), false
	}
	if refused := ans.refusal(); refused != nil {
		return refused.Error(), false
	}
	return ans.body.String(), ans.status < 300
}
