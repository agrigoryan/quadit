package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// githubClient talks to GitHub's REST API. The integration and sign-in each
// make their own; what differs between the two is in the fields.
type githubClient struct {
	api string       // where the API is, as its paths are added to it
	hc  *http.Client // sign-in's carries the token of the person signing in
	// header is sent with every request, besides Accept.
	header map[string]string
	// timeout is how long one request may take; zero leaves it to the context.
	timeout time.Duration
	// limit is how much of an answer is read.
	limit int64
	// strict takes only a plain 200 for an answer, and tells a refusal by
	// its status alone, without what GitHub wrote under it.
	strict bool
}

// githubAPI is the client of a GitHub integration: it carries the token an
// admin gave the integration, and says who is asking and which version of
// the API it was written for.
func (s *Server) githubAPI(api, token string) *githubClient {
	h := map[string]string{"X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Quadit/" + s.cfg.Version}
	if token != "" {
		h["Authorization"] = "Bearer " + token
	}
	return &githubClient{api: api, hc: http.DefaultClient, header: h, timeout: 20 * time.Second, limit: 8 << 20}
}

// githubSignInAPI is the client sign-in asks GitHub with: hc carries the
// token GitHub gave for the person signing in.
func githubSignInAPI(hc *http.Client, api string) *githubClient {
	return &githubClient{api: api, hc: hc, limit: 1 << 20, strict: true}
}

// call makes one request. body, when given, is sent as JSON; the answer is
// read into dst, when given.
func (g *githubClient) call(ctx context.Context, method, path string, body any, dst any) error {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = strings.NewReader(string(raw))
	}
	if g.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, g.timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, method, g.api+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	for name, value := range g.header {
		req.Header.Set(name, value)
	}
	resp, err := g.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, g.limit))
	switch {
	case g.strict && resp.StatusCode != 200:
		return fmt.Errorf("GitHub answered %s", resp.Status)
	case resp.StatusCode >= 300:
		return fmt.Errorf("GitHub answered %s to %s %s: %s", resp.Status, method, path, oneLine(string(raw), 160))
	}
	if dst != nil {
		return json.Unmarshal(raw, dst)
	}
	return nil
}
