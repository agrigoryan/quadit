package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/agrigoryan/quadit/internal/engine"
)

// The server calls its own API from inside the process in two places: an
// MCP tool is an API call made with the client's token (mcp_calls.go), and
// an import writes through the API as whoever asked for it (importing.go).
// Both go through selfCall, so a call made this way passes the same checks
// as one from outside; what differs between the two is in selfCaller.

// inProcess marks a request the server makes to itself on a caller's
// behalf; such requests are not counted against the caller's rate limit.
type inProcess struct{}

// selfCaller is who an in-process call is made for. It is one call's
// worth of who and where, so it carries the call's context.
type selfCaller struct {
	ctx        context.Context // the call ends when this ends
	base       string          // what a path is put under: the API of one workspace
	signIn     http.Header     // the headers that say who is calling
	remoteAddr string          // where the call counts as coming from
}

// bearerOf is the bearer of a token calling from this machine, in the
// token's own workspace, for as long as ctx lasts: an MCP tool's calls end
// when the client that asked for them goes away. Each call is counted
// against the token's rate limit like one from outside.
func bearerOf(ctx context.Context, token string) selfCaller {
	return selfCaller{ctx: ctx, base: "/api/v1/w/-",
		signIn: http.Header{"Authorization": {"Bearer " + token}}, remoteAddr: selfCallAddr}
}

// callerOf is the one who sent the request x, in its workspace: the same
// sign-in from the same address, inside a request already counted.
func callerOf(x *c) selfCaller {
	who := selfCaller{ctx: context.WithValue(x.ctx(), inProcess{}, true), base: "/api/v1/w/" + x.ws.Slug,
		signIn: http.Header{}, remoteAddr: x.r.RemoteAddr}
	for _, h := range []string{"Authorization", "Cookie"} {
		if v := x.r.Header.Get(h); v != "" {
			who.signIn.Set(h, v)
		}
	}
	who.signIn.Set("Sec-Fetch-Site", "same-origin")
	return who
}

// selfCall sends one request to the server's own API as who and returns
// the answer whole. An empty contentType sends none.
func (s *Server) selfCall(who selfCaller, method, path string, q url.Values, body []byte, contentType string) (*recordedAnswer, error) {
	u := who.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(who.ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = who.signIn.Clone()
	req.RemoteAddr = who.remoteAddr
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	ans := &recordedAnswer{h: http.Header{}, status: 200}
	s.mux.ServeHTTP(ans, req)
	return ans, nil
}

// recordedAnswer collects a handler's answer for a caller inside the process.
type recordedAnswer struct {
	h      http.Header
	status int
	body   bytes.Buffer
}

// Header, WriteHeader and Write make recordedAnswer an http.ResponseWriter.
func (b *recordedAnswer) Header() http.Header         { return b.h }
func (b *recordedAnswer) WriteHeader(code int)        { b.status = code }
func (b *recordedAnswer) Write(p []byte) (int, error) { return b.body.Write(p) }

// refusal is the error a failed answer carries; nil when the call
// succeeded, or failed with something else for a body.
func (b *recordedAnswer) refusal() *engine.Error {
	if b.status < 300 {
		return nil
	}
	var wrap struct {
		Error engine.Error `json:"error"`
	}
	// A body that is not an error of that shape carries no refusal.
	isRefusal := json.Unmarshal(b.body.Bytes(), &wrap) == nil && wrap.Error.Code != ""
	if !isRefusal {
		return nil
	}
	return &wrap.Error
}
