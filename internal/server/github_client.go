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
// make their own: the integration's carries the token an admin gave it, and
// sign-in's the token GitHub gave for the person signing in.
type githubClient struct {
	api string       // where the API is, as its paths are added to it
	hc  *http.Client // sign-in's carries the token of the person signing in
	// header is sent with every request, besides Accept: who is asking,
	// and which version of the API it was written for.
	header map[string]string
}

// githubTimeout is how long one request to GitHub may take; a sign-in's
// requests to any provider have the same limit (see providerCalls).
var githubTimeout = 20 * time.Second

// githubAnswerLimit is how much of an answer is read.
const githubAnswerLimit = 8 << 20

// newGitHubClient is a client that says it is this version of Quadit.
func newGitHubClient(hc *http.Client, api, version string) *githubClient {
	return &githubClient{api: api, hc: hc, header: map[string]string{"X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Quadit/" + version}}
}

// githubAPI is the client of a GitHub integration: it carries the token an
// admin gave the integration.
func (s *Server) githubAPI(api, token string) *githubClient {
	g := newGitHubClient(http.DefaultClient, api, s.cfg.Version)
	if token != "" {
		g.header["Authorization"] = "Bearer " + token
	}
	return g
}

// call makes one request. body, when given, is sent as JSON; the answer is
// read into dst, when given.
func (g *githubClient) call(ctx context.Context, method, path string, body any, dst any) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = strings.NewReader(string(raw))
	}
	ctx, cancel := context.WithTimeout(ctx, githubTimeout)
	defer cancel()
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
	raw, err := io.ReadAll(io.LimitReader(resp.Body, githubAnswerLimit))
	if err != nil {
		return fmt.Errorf("reading GitHub's answer to %s %s: %w", method, path, err)
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub answered %s to %s %s: %s", resp.Status, method, path, oneLine(string(raw), 160))
	}
	if dst != nil {
		return json.Unmarshal(raw, dst)
	}
	return nil
}
