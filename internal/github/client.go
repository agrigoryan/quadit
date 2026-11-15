package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client talks to GitHub's REST API. The integration and sign-in each
// make their own: the integration's carries the token an admin gave it, and
// sign-in's the token GitHub gave for the person signing in.
type Client struct {
	api string       // where the API is, as its paths are added to it
	hc  *http.Client // sign-in's carries the token of the person signing in
	// header is sent with every request, besides Accept: who is asking,
	// and which version of the API it was written for.
	header map[string]string
}

// Timeout is how long one request to GitHub may take; a sign-in's
// requests to any provider have the same limit (see providerCalls).
var Timeout = 20 * time.Second

// answerLimit is how much of an answer is read.
const answerLimit = 8 << 20

// NewClient is a client that says it is this version of Quadit.
func NewClient(hc *http.Client, api, version string) *Client {
	return &Client{api: api, hc: hc, header: map[string]string{"X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Quadit/" + version}}
}

// Call makes one request. body, when given, is sent as JSON; the answer is
// read into dst, when given.
func (g *Client) Call(ctx context.Context, method, path string, body any, dst any) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = strings.NewReader(string(raw))
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
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
	raw, err := io.ReadAll(io.LimitReader(resp.Body, answerLimit))
	if err != nil {
		return fmt.Errorf("reading GitHub's answer to %s %s: %w", method, path, err)
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub answered %s to %s %s: %s", resp.Status, method, path, shortened(string(raw), 160))
	}
	if dst != nil {
		return json.Unmarshal(raw, dst)
	}
	return nil
}

// shortened is text on one line, cut at limit characters with an ellipsis.
func shortened(s string, limit int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > limit {
		return string(r[:limit]) + "…"
	}
	return s
}
