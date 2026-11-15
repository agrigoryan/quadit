package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// The MCP server gives any MCP client the same surface as the API, under
// the same permissions, with results in the compact text form. It speaks
// MCP's streamable HTTP transport: JSON-RPC requests posted to /mcp.
//
// This file is the protocol: who may ask, and the answer to each method.
// The tools are listed in mcp_tools.go and run in mcp_calls.go; they reach
// the API through the in-process call of inprocess.go.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /mcp", s.handleServeMCP)
		m.HandleFunc("GET /mcp", func(w http.ResponseWriter, r *http.Request) {
			// No server-to-client stream is offered; clients poll with tools.
			w.Header().Set("Allow", "POST")
			http.Error(w, "this server answers each request directly; use POST", http.StatusMethodNotAllowed)
		})
	})
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

var mcpVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

func (s *Server) handleServeMCP(w http.ResponseWriter, r *http.Request) {
	token, ok := s.mcpSignIn(w, r)
	if !ok {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.JSONRPC != "2.0" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "send one JSON-RPC 2.0 request"}})
		return
	}
	if len(req.ID) == 0 { // a notification: nothing to answer
		w.WriteHeader(http.StatusAccepted)
		return
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	resp.Result, resp.Error = s.mcpAnswer(token, req)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
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
	if n, _ := s.st.Count(r.Context(), "api_tokens", store.Eq("token_hash", auth.Hash(token)), store.Null("revoked_at")); n == 0 {
		// Guesses are counted by where they come from.
		if err := s.limits.check("bad:"+clientIP(r), 120); err != nil {
			s.fail(w, r, err)
			return "", false
		}
	}
	if _, ok := s.callAPI(token, "GET", "/me", url.Values{"format": {"text"}}, nil); !ok {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="`+s.cfg.BaseURL+`/.well-known/oauth-protected-resource"`)
		http.Error(w, "this token is not valid", http.StatusUnauthorized)
		return "", false
	}
	return token, true
}

// mcpAnswer is the result of one request, or the error it ends in.
func (s *Server) mcpAnswer(token string, req rpcRequest) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		return s.mcpInitialize(req.Params), nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return mcpToolList(), nil
	case "tools/call":
		return s.mcpCallTool(token, req.Params)
	}
	return nil, &rpcError{Code: -32601, Message: "method not found: " + req.Method}
}

func (s *Server) mcpInitialize(params json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	json.Unmarshal(params, &p)
	version := mcpVersions[0]
	if has(mcpVersions, p.ProtocolVersion) {
		version = p.ProtocolVersion
	}
	return map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}},
		"serverInfo": map[string]any{"name": "quadit", "version": s.cfg.Version, "surface": engine.Surface},
		"instructions": "Tasks, decisions and docs shared by people and agents. Start with whoami and my_work. Follow changes with events (wait=N holds the call) and ack. " +
			"Write with change; a refusal says how to fix the call."}
}

// mcpCallTool runs the tool a tools/call names, as the bearer of token.
func (s *Server) mcpCallTool(token string, params json.RawMessage) (any, *rpcError) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	json.Unmarshal(params, &p)
	var tool *mcpTool
	for i := range mcpTools {
		if mcpTools[i].Name == p.Name {
			tool = &mcpTools[i]
			break
		}
	}
	if tool == nil {
		return nil, &rpcError{Code: -32602, Message: "unknown tool " + p.Name}
	}
	if p.Arguments == nil {
		p.Arguments = map[string]any{}
	}
	text, ok := tool.Run(s, token, p.Arguments)
	if data, isPicture := strings.CutPrefix(text, pictureMark); ok && isPicture {
		// A picture goes back as a picture, which a model can look at.
		return map[string]any{"content": []map[string]any{{"type": "image", "data": data, "mimeType": "image/png"}}, "isError": false}, nil
	}
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": !ok}, nil
}
