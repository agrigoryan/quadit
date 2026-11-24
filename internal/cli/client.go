// The API client: requests, changes and uploads.

package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	"github.com/agrigoryan/quadit/internal/plainjson"
)

// requestTimeout is how long one request to the server may take.
const requestTimeout = 90 * time.Second

// Client talks to a server as one member.
type Client struct {
	// ChangeID, when set, is the id the next change is sent with; sending
	// the same change with the same id twice applies it once.
	ChangeID string
	// For names the member a change is made for; it then runs with their access.
	For   string
	URL   string // the server's address, with no trailing slash
	Token string // the API token the member is signed in with
	HTTP  *http.Client
	// Note is what the server had to say beside its last answer (a picture
	// that stops before the page does, for one).
	Note string
	// app starts the desktop app when its server on this computer is not
	// running; nil for a login the app did not make.
	app *appStart
}

// savedConfig is the file `quadit login` writes. App is there when the
// desktop app made the login for the server it runs (login --app).
type savedConfig struct {
	URL   string    `json:"url"`
	Token string    `json:"token"`
	App   *appLogin `json:"app,omitempty"`
}

// configPath is where `quadit login` saves the server and token:
// QUADIT_CONFIG, or quadit/config.json in the user's config folder.
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

// NewClient reads the server address and token from the environment when
// both are set (QUADIT_URL, QUADIT_TOKEN), otherwise from the file `quadit
// login` wrote. The two are never mixed: a token saved for one server is
// not sent to another.
func NewClient() (*Client, error) {
	c := &Client{URL: os.Getenv("QUADIT_URL"), Token: os.Getenv("QUADIT_TOKEN"), HTTP: &http.Client{Timeout: requestTimeout}}
	if c.URL == "" || c.Token == "" {
		var sc savedConfig
		if raw, err := os.ReadFile(configPath()); err == nil {
			if err := json.Unmarshal(raw, &sc); err != nil {
				return nil, fmt.Errorf("%s: %w", configPath(), err)
			}
		}
		c.URL, c.Token = sc.URL, sc.Token
		if sc.App != nil {
			c.app = &appStart{login: *sc.App, dir: filepath.Dir(configPath()), starter: systemStarter{}, within: appStartWithin, stderr: os.Stderr}
		}
	}
	if c.URL == "" || c.Token == "" {
		return nil, errors.New("not connected: set QUADIT_URL and QUADIT_TOKEN, or run: quadit login <url> <token>")
	}
	c.URL = strings.TrimRight(c.URL, "/")
	return c, nil
}

// loginClient is a client of one login file alone, as `quadit run` uses
// for each entry: QUADIT_URL, QUADIT_TOKEN and QUADIT_CONFIG are not read,
// and a server that is not running is waited for, never started (the
// desktop app supervises the runner, not the other way round).
func loginClient(path string) (*Client, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("the login file: %w", err)
	}
	var sc savedConfig
	if err := json.Unmarshal(raw, &sc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if sc.URL == "" || sc.Token == "" {
		return nil, fmt.Errorf("%s holds no server and token: connect the agent again", path)
	}
	return &Client{URL: strings.TrimRight(sc.URL, "/"), Token: sc.Token, HTTP: &http.Client{Timeout: requestTimeout}}, nil
}

// madeChangeID is the change id made from text: a UUID's form, the same
// for the same text every time, so a change sent again under it is applied
// once. Version 8 (made by its maker's own rule), the usual variant.
func madeChangeID(text string) string {
	sum := sha256.Sum256([]byte(text))
	h := hex.EncodeToString(sum[:16])
	return h[0:8] + "-" + h[8:12] + "-8" + h[13:16] + "-" + string("89ab"[sum[8]&3]) + h[17:20] + "-" + h[20:32]
}

// APIError is a refusal from the server.
type APIError struct {
	Status  int      `json:"-"`
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Field   string   `json:"field"`
	Allowed []string `json:"allowed"`
	Nearest string   `json:"nearest"`
	Reason  string   `json:"reason"` // tells some refusals of one code apart: in_use, number_taken
}

// RefusalReason is the refusal's Reason, for a caller that matches it on
// an interface without importing this package.
func (e *APIError) RefusalReason() string { return e.Reason }

// Error gives the code and message, with the nearest allowed value and
// the allowed ones when the server named them.
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

// apiRequest is one request to the API: where it goes, what it sends and
// the form of answer it asks for.
type apiRequest struct {
	method string
	// path is under the token's workspace, unless it starts with /api/.
	path        string
	query       url.Values
	body        io.Reader // nil: no body
	contentType string    // the body's type
	accept      string    // the form of answer asked for; empty: any
}

// workspaceRequest sends a request inside the token's workspace and returns
// the body of the answer. It is sent once: a request that cannot be sent
// again safely is the caller's to try again (postChanges does, under the
// change's id). The one exception is a request the server could not take
// because it was not running: it never arrived, so once the desktop app
// that runs the server is started (appStart), it is sent again.
func (c *Client) workspaceRequest(ctx context.Context, r apiRequest) ([]byte, error) {
	u := c.URL + "/api/v1/w/-" + r.path
	if strings.HasPrefix(r.path, "/api/") {
		u = c.URL + r.path
	}
	if len(r.query) > 0 {
		u += "?" + r.query.Encode()
	}
	send := func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, r.method, u, r.body)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+c.Token)
		if r.contentType != "" {
			req.Header.Set("Content-Type", r.contentType)
		}
		if r.accept != "" {
			req.Header.Set("Accept", r.accept)
		}
		return c.HTTP.Do(req)
	}
	resp, err := send()
	if err != nil && c.app != nil {
		// A body that can be read again from its start can be sent again.
		rewind, again := r.body.(io.Seeker)
		answers, note := c.app.revive(ctx, c.HTTP, c.URL, err, r.body == nil || again)
		if note != "" {
			return nil, fmt.Errorf("cannot reach %s: %w\n  %s", c.URL, err, note)
		}
		if answers {
			if again {
				if _, err := rewind.Seek(0, io.SeekStart); err != nil {
					return nil, err
				}
			}
			resp, err = send()
		}
	}
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s: %w%s", c.URL, err, keptOffTheNetwork())
	}
	raw, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	c.Note = resp.Header.Get("X-Quadit-Note")
	if err != nil {
		return nil, fmt.Errorf("cannot read the answer from %s: %w", c.URL, err)
	}
	if resp.StatusCode < 300 {
		return raw, nil
	}
	var wrap struct {
		Error APIError `json:"error"`
	}
	if json.Unmarshal(raw, &wrap) != nil || wrap.Error.Code == "" {
		return nil, fmt.Errorf("%s %s: %s", r.method, r.path, resp.Status)
	}
	wrap.Error.Status = resp.StatusCode
	return nil, &wrap.Error
}

// Text gets a path in the compact text form.
func (c *Client) Text(ctx context.Context, path string, q url.Values) (string, error) {
	raw, err := c.workspaceRequest(ctx, apiRequest{method: http.MethodGet, path: path, query: q, accept: "text/plain"})
	return string(raw), err
}

// JSON gets a path as JSON.
func (c *Client) JSON(ctx context.Context, path string, q url.Values) ([]byte, error) {
	return c.workspaceRequest(ctx, apiRequest{method: http.MethodGet, path: path, query: q, accept: "application/json"})
}

// Result is what a change returned.
type Result struct {
	ChangeID  string `json:"change_id"`
	Type      string `json:"type"`
	Seq       int64  `json:"seq"`
	Ref       string `json:"ref"`
	Key       string `json:"key"`
	Duplicate bool   `json:"duplicate"`
	// Warnings say what the change did that the caller may not have
	// meant, such as a write that took the words of a comment thread out.
	Warnings []string `json:"warnings"`
}

// ChangeOptions are how a change is sent, beside its type and arguments.
type ChangeOptions struct {
	Approval string // the id of the decision that approves the change
	DryRun   bool   // check the change without making it
}

// Change applies one change. The id is made here, so a retry after a
// network failure cannot apply it twice.
func (c *Client) Change(ctx context.Context, typ string, args any, opts ChangeOptions) (*Result, error) {
	cid := c.ChangeID // one given by the caller makes its own retries safe too
	if cid == "" {
		cid = id.New()
	}
	c.ChangeID = "" // an id is for one change
	body := map[string]any{"id": cid, "type": typ, "args": args}
	if c.For != "" {
		body["for"] = c.For
	}
	if opts.Approval != "" {
		body["approval"] = opts.Approval
	}
	if opts.DryRun {
		body["dry_run"] = true
	}
	res, err := c.postChanges(ctx, body)
	if err != nil {
		return nil, err
	}
	return &res[0], nil
}

// BatchChange is one change of a batch. Its id is the caller's to make.
type BatchChange struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Args     any    `json:"args"`
	Approval string `json:"approval,omitempty"`
	For      string `json:"for,omitempty"`
}

// Batch applies several changes in one go: all of them or none.
func (c *Client) Batch(ctx context.Context, changes []BatchChange) ([]Result, error) {
	for i := range changes {
		changes[i].For = c.For
	}
	return c.postChanges(ctx, map[string]any{"changes": changes})
}

// changeAttempts is how many times a body of changes is sent before a
// server that cannot be reached is given up on.
const changeAttempts = 3

// postChanges sends a body of changes, trying again when the server could
// not be reached (the ids in it make that safe), and reads the results.
func (c *Client) postChanges(ctx context.Context, body map[string]any) ([]Result, error) {
	raw := plainjson.Marshal(body)
	var out []byte
	var err error
	for attempt := range changeAttempts {
		out, err = c.workspaceRequest(ctx, apiRequest{method: http.MethodPost, path: "/changes", body: bytes.NewReader(raw), contentType: "application/json", accept: "application/json"})
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
	return res.Results, nil
}

// uploadPart is the most of a file sent in one request; a larger one goes
// up in parts, each where the server says the last one ended.
const uploadPart = 16 << 20

// Upload sends a file and returns its id and address.
func (c *Client) Upload(ctx context.Context, path string) (fileID, fileURL string, err error) {
	return c.UploadAs(ctx, "", path)
}

// UploadAs sends a file under an id of the caller's making (empty: the
// server makes one). Sent again under the same id, a file is not stored
// twice: an upload that stopped half way goes on from where it was.
func (c *Client) UploadAs(ctx context.Context, id, path string) (fileID, fileURL string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", "", err
	}
	// The server makes the file ready only if what it put together has
	// this checksum: a part lost or cut short on the way is sent again.
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return "", "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", "", err
	}
	q := url.Values{"name": {filepath.Base(path)}, "size": {fmt.Sprint(st.Size())}, "sha256": {hex.EncodeToString(sum.Sum(nil))}}
	if id != "" {
		q.Set("id", id)
	}
	var meta struct {
		ID       string `json:"id"`
		URL      string `json:"url"`
		Received int64  `json:"received"`
		State    string `json:"state"`
	}
	raw, err := c.workspaceRequest(ctx, apiRequest{method: http.MethodPost, path: "/files", query: q, body: io.LimitReader(f, uploadPart), contentType: "application/octet-stream"})
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
		raw, err = c.workspaceRequest(ctx, apiRequest{method: http.MethodPatch, path: "/files/" + meta.ID, query: url.Values{"offset": {fmt.Sprint(meta.Received)}},
			body: io.LimitReader(f, uploadPart), contentType: "application/octet-stream"})
		if err != nil {
			return "", "", err
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			return "", "", err
		}
	}
	return meta.ID, meta.URL, nil
}

// keptOffTheNetwork is what to do about a request that could not be sent
// when the program running quadit keeps its commands off the network: a
// second line for the error, or nothing. Codex runs commands in a sandbox
// without network unless told otherwise, this computer's own addresses
// included, and says so in their environment
// (CODEX_SANDBOX_NETWORK_DISABLED=1). The agent reading the error can ask
// the person to let this one command out, which is all it takes.
func keptOffTheNetwork() string {
	if os.Getenv("CODEX_SANDBOX_NETWORK_DISABLED") != "1" {
		return ""
	}
	return "\n  This command runs in Codex's sandbox, which has no network, not even to this computer." +
		" Run it again outside the sandbox: ask the person for that permission, saying quadit needs to reach Quadit."
}
