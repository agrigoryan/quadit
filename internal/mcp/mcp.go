// Package mcp is the MCP server: it gives any MCP client the same surface
// as the HTTP API, under the same permissions, with results in the compact
// text form. It speaks MCP's streamable HTTP transport (JSON-RPC requests
// posted to one address) and hides the protocol and the table of tools
// behind Serve. Every tool is a call to the API with the client's token,
// made through the API function the server gives New; signing the client
// in is the server's.
//
// How the package is laid out:
//
//	mcp.go    the protocol: initialize, tools/list, tools/call
//	tools.go  the tools: their list, what each takes, and the API path most read
//	calls.go  the tools that do more than read one path
//	ask.go    the ask tool: a question to a person in one call
package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
)

// rpcRequest is one JSON-RPC 2.0 request.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// rpcError is the error a JSON-RPC request ends in.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// rpcResponse is the answer to one JSON-RPC request.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// versions are the versions of MCP spoken, newest first.
var versions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// bodyLimit is the largest request read.
const bodyLimit = 32 << 20

// API calls the HTTP API from inside the process with a client's token, in
// the token's workspace (a path starting /api/ is given whole). An empty
// contentType sends none. It answers the text of the answer and whether the
// call succeeded; a refusal comes back as its message, with the allowed
// values when there are any.
type API func(ctx context.Context, token, method, path string, q url.Values, body []byte, contentType string) (string, bool)

// Server answers MCP requests. It holds no state between them.
type Server struct {
	api     API
	version string // the version of Quadit, said in initialize
}

// New makes an MCP server whose tools call the API through api.
func New(api API, version string) *Server {
	return &Server{api: api, version: version}
}

// Serve answers one JSON-RPC request posted to the MCP endpoint, for a
// client that has signed in with token.
func (m *Server) Serve(w http.ResponseWriter, r *http.Request, token string) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, bodyLimit))
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
	resp.Result, resp.Error = m.answer(caller{ctx: r.Context(), token: token, api: m.api}, req)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// answer is the result of one request, or the error it ends in.
func (m *Server) answer(who caller, req rpcRequest) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		return m.initialize(req.Params), nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return toolList(), nil
	case "tools/call":
		return callTool(who, req.Params)
	}
	return nil, &rpcError{Code: -32601, Message: "method not found: " + req.Method}
}

// initialize answers initialize: the version spoken (the client's, when
// it is one of ours, else the newest), and what the server offers.
func (m *Server) initialize(params json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	version := versions[0]
	if err := json.Unmarshal(params, &p); err == nil && slices.Contains(versions, p.ProtocolVersion) {
		version = p.ProtocolVersion
	}
	return map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}},
		"serverInfo": map[string]any{"name": "quadit", "version": m.version, "surface": engine.Surface},
		"instructions": "Tasks, decisions and docs shared by people and agents. Start with whoami and my_work. Follow changes with events (wait=N holds the call) and ack. " +
			"Write with change; a refusal says how to fix the call."}
}

// callTool runs the tool a tools/call names, as who.
func callTool(who caller, params json.RawMessage) (any, *rpcError) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: -32602, Message: "the params do not read: give an object with name and arguments"} // the decoder's own words name Go types
	}
	var named *tool
	for i := range tools {
		if tools[i].Name == p.Name {
			named = &tools[i]
			break
		}
	}
	if named == nil {
		return nil, &rpcError{Code: -32602, Message: "unknown tool " + p.Name}
	}
	if p.Arguments == nil {
		p.Arguments = map[string]any{}
	}
	if err := checkArgs(*named, p.Arguments); err != nil {
		return map[string]any{"content": []map[string]any{{"type": "text", "text": err.Error()}}, "isError": true}, nil
	}
	text, ok := named.Run(who, p.Arguments)
	if data, isPicture := strings.CutPrefix(text, pictureMark); ok && isPicture {
		// A picture goes back as a picture, which a model can look at.
		return map[string]any{"content": []map[string]any{{"type": "image", "data": data, "mimeType": "image/png"}}, "isError": false}, nil
	}
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": !ok}, nil
}
