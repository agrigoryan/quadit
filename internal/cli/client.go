// Package cli is the command-line tool: one binary for people and agents.
// Its output is short on purpose; --json gives the full data.
package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/id"
)

// Client talks to a server as one member.
type Client struct {
	// ChangeID, when set, is the id the next change is sent with; sending
	// the same change with the same id twice applies it once.
	ChangeID string
	// For names the member a change is made for; it then runs with their access.
	For   string
	URL   string
	Token string
	HTTP  *http.Client
	// Note is what the server had to say beside its last answer (a picture
	// that stops before the page does, for one).
	Note string
}

type savedConfig struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func configPath() string {
	if p := os.Getenv("QUADIT_CONFIG"); p != "" {
		return p
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "quadit", "config.json")
}

// NewClient reads the server address and token from the environment
// (QUADIT_URL, QUADIT_TOKEN) or from the file `quadit login` wrote.
func NewClient() (*Client, error) {
	c := &Client{URL: os.Getenv("QUADIT_URL"), Token: os.Getenv("QUADIT_TOKEN"), HTTP: &http.Client{Timeout: 90 * time.Second}}
	if c.URL == "" || c.Token == "" {
		var sc savedConfig
		if raw, err := os.ReadFile(configPath()); err == nil {
			json.Unmarshal(raw, &sc)
		}
		if c.URL == "" {
			c.URL = sc.URL
		}
		if c.Token == "" {
			c.Token = sc.Token
		}
	}
	if c.URL == "" || c.Token == "" {
		return nil, errors.New("not connected: set QUADIT_URL and QUADIT_TOKEN, or run: quadit login <url> <token>")
	}
	c.URL = strings.TrimRight(c.URL, "/")
	return c, nil
}

// APIError is a refusal from the server.
type APIError struct {
	Status  int      `json:"-"`
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Field   string   `json:"field"`
	Allowed []string `json:"allowed"`
	Nearest string   `json:"nearest"`
}

func (e *APIError) Error() string {
	msg := e.Code + ": " + e.Message
	if e.Nearest != "" {
		msg += "\n  did you mean: " + e.Nearest
	}
	if len(e.Allowed) > 0 {
		msg += "\n  allowed: " + strings.Join(e.Allowed, ", ")
	}
	return msg
}

// do sends a request inside the token's workspace and returns the body.
func (c *Client) do(method, path string, query url.Values, body io.Reader, contentType, accept string) ([]byte, error) {
	u := c.URL + "/api/v1/w/-" + path
	if strings.HasPrefix(path, "/api/") {
		u = c.URL + path
	}
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	for attempt := 0; ; attempt++ {
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return nil, fmt.Errorf("cannot reach %s: %w", c.URL, err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		c.Note = resp.Header.Get("X-Quadit-Note")
		if resp.StatusCode < 300 {
			return raw, nil
		}
		var wrap struct {
			Error APIError `json:"error"`
		}
		if json.Unmarshal(raw, &wrap) != nil || wrap.Error.Code == "" {
			return nil, fmt.Errorf("%s %s: %s", method, path, resp.Status)
		}
		wrap.Error.Status = resp.StatusCode
		return nil, &wrap.Error
	}
}

// Text gets a path in the compact text form.
func (c *Client) Text(path string, q url.Values) (string, error) {
	raw, err := c.do("GET", path, q, nil, "", "text/plain")
	return string(raw), err
}

// JSON gets a path as JSON.
func (c *Client) JSON(path string, q url.Values) ([]byte, error) {
	return c.do("GET", path, q, nil, "", "application/json")
}

// Result is what a change returned.
type Result struct {
	ChangeID  string `json:"change_id"`
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	Ref       string `json:"ref"`
	Key       string `json:"key"`
	Duplicate bool   `json:"duplicate"`
}

// Change applies one change. The id is made here, so a retry after a
// network failure cannot apply it twice.
func (c *Client) Change(typ string, args any, approval string, dry bool) (*Result, error) {
	cid := c.ChangeID // one given by the caller makes its own retries safe too
	if cid == "" {
		cid = id.New()
	}
	c.ChangeID = "" // an id is for one change
	body := map[string]any{"id": cid, "type": typ, "args": args}
	if c.For != "" {
		body["for"] = c.For
	}
	if approval != "" {
		body["approval"] = approval
	}
	if dry {
		body["dry_run"] = true
	}
	raw, _ := json.Marshal(body)
	var out []byte
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		out, err = c.do("POST", "/changes", nil, bytes.NewReader(raw), "application/json", "application/json")
		var ae *APIError
		if err == nil || errors.As(err, &ae) {
			break
		}
		time.Sleep(time.Duration(attempt+1) * time.Second) // the same id makes the retry safe
	}
	if err != nil {
		return nil, err
	}
	var res struct {
		Results []Result `json:"results"`
	}
	if err := json.Unmarshal(out, &res); err != nil || len(res.Results) == 0 {
		return nil, fmt.Errorf("unexpected answer: %s", out)
	}
	return &res.Results[0], nil
}

// Upload sends a file and returns its id and address.
func (c *Client) Upload(path string) (fileID, fileURL string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", "", err
	}
	const part = 16 << 20
	q := url.Values{"name": {filepath.Base(path)}, "size": {fmt.Sprint(st.Size())}}
	var meta struct {
		ID       string `json:"id"`
		URL      string `json:"url"`
		Received int64  `json:"received"`
		State    string `json:"state"`
	}
	raw, err := c.do("POST", "/files", q, io.LimitReader(f, part), "application/octet-stream", "")
	if err != nil {
		return "", "", err
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return "", "", err
	}
	for meta.State != "ready" {
		if _, err := f.Seek(meta.Received, io.SeekStart); err != nil {
			return "", "", err
		}
		raw, err = c.do("PATCH", "/files/"+meta.ID, url.Values{"offset": {fmt.Sprint(meta.Received)}}, io.LimitReader(f, part), "application/octet-stream", "")
		if err != nil {
			return "", "", err
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			return "", "", err
		}
	}
	return meta.ID, meta.URL, nil
}

var httpClient = http.Client{Timeout: 90 * time.Second}
