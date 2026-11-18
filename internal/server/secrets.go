package server

// The vault. A secret is set by an admin and never comes back out of the
// API. An agent uses one in two ways:
//
//   - It asks the server to make an HTTP request for it, writing {{secret}}
//     where the value belongs. The request goes only to the hosts the secret
//     is bound to, redirects are not followed, and the value is blanked out
//     of the answer. The agent uses the key and never holds it.
//   - A secret marked env is handed to the companion ("quadit run"), which
//     must hold a token made for that, to put in the environment of the
//     command it starts. This is for tools on the agent's own machine.
//
// Every use is written to the audit log.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// secretRoutes are the routes of using secrets without reading them.
func (s *Server) secretRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/secrets", s.workspaceMember(s.handleListSecrets), "The secrets the caller may use: names, hosts and what they are for. Values are never returned.", "", "secrets"},
		{"POST /api/v1/w/{ws}/secrets/{name}/request", s.workspaceMember(s.handleSendRequestWithSecret), "Make an HTTP request with a secret the caller cannot read. Body: {method, url, headers, body}; write {{secret}} where the value belongs. Only to the secret's hosts; redirects are not followed; the value is blanked out of the answer.", "", "secrets"},
		{"POST /api/v1/w/{ws}/secrets/env", s.workspaceMember(s.handleListEnvSecrets), "For a companion's token made for secrets: the values of secrets marked env. Body: {names}.", "", "secrets"},
	}
}

// secretRequestTimeout is how long a request made with a secret may take.
// It goes out through s.outbound, which never follows a redirect: a secret
// goes to the host it was sent to and no further.
const secretRequestTimeout = 30 * time.Second

const secretMask = "•••"

// mayUseSecret reports whether the caller is among those a secret is for.
func (who *viewer) mayUseSecret(sec core.Secret) bool {
	if len(sec.Agents) == 0 || who.member.Kind != core.KindAgent {
		return true
	}
	return slices.Contains(sec.Agents, who.member.UserID)
}

// handleListSecrets lists the secrets the caller may use: names and what they are
// for, never values.
func (s *Server) handleListSecrets(x *c) error {
	var rows []core.Secret
	if err := x.db.List(x.ctx(), &rows, store.Q{Where: []store.Cond{store.Live}, Order: "name", Limit: 1000}); err != nil {
		return err
	}
	rows = keep(rows, x.mayUseSecret)
	if x.wantText() {
		var b strings.Builder
		for _, r := range rows {
			fmt.Fprintf(&b, "%s", r.Name)
			if len(r.Hosts) > 0 {
				fmt.Fprintf(&b, "  hosts: %s", strings.Join(r.Hosts, ", "))
			}
			if r.Env {
				b.WriteString("  env")
			}
			if r.Description != "" {
				fmt.Fprintf(&b, "  %s", r.Description)
			}
			b.WriteString("\n")
		}
		if len(rows) == 0 {
			b.WriteString("no secrets\n")
		}
		return x.text(b.String())
	}
	return x.ok(map[string]any{"secrets": rows})
}

// secret loads a secret by name for use, and its value.
func (s *Server) secret(x *c, name string) (core.Secret, string, error) {
	var sec core.Secret
	there, err := store.Find(x.ctx(), x.db, &sec, store.Eq("name", name), store.Live)
	if err != nil {
		return sec, "", err
	}
	if !there {
		if err := x.db.Get(x.ctx(), &sec, store.Eq("id", name), store.Live); err != nil {
			return sec, "", err
		}
	}
	if !x.mayUseSecret(sec) {
		return sec, "", errForbidden("the secret %s is not for you; an admin decides who may use it", sec.Name)
	}
	if x.actor.ReadOnly {
		return sec, "", errForbidden("this credential is read-only")
	}
	value, err := s.sealer.Open(sec.Value)
	if err != nil || value == "" {
		return sec, "", errBad("the secret %s has no value that can be read; an admin has to set it again", sec.Name)
	}
	return sec, value, nil
}

// hostAllowed reports whether a secret may be sent to this URL.
func hostAllowed(sec core.Secret, u *url.URL) bool {
	host := strings.ToLower(u.Host)
	name := strings.ToLower(u.Hostname())
	for _, h := range sec.Hosts {
		plain := strings.HasPrefix(h, "http://")
		h = strings.TrimPrefix(h, "http://")
		if (u.Scheme == "http") != plain {
			continue
		}
		switch {
		case h == host, h == name && !strings.Contains(h, ":") && (u.Port() == "" || u.Port() == "443" || u.Port() == "80"):
			return true
		case strings.HasPrefix(h, "*.") && strings.HasSuffix(name, h[1:]) && u.Port() == "":
			return true
		}
	}
	return false
}

type secretRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	// BodyBase64 is the body when it is not text.
	BodyBase64 string `json:"body_base64"`
}

// handleSendRequestWithSecret makes an HTTP request for the caller with the secret put
// where {{secret}} is written, in the URL, a header or the body.
func (s *Server) handleSendRequestWithSecret(x *c) error {
	var b secretRequest
	if err := x.body(&b); err != nil {
		return err
	}
	sec, value, err := s.secret(x, x.r.PathValue("name"))
	if err != nil {
		return err
	}
	req, target, err := newSecretRequest(x, sec, value, b)
	if err != nil {
		return err
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(x.ctx(), secretRequestTimeout)
	defer cancel()
	resp, err := s.outbound.Do(req.WithContext(ctx))
	s.markSecretUsed(x, sec, started)
	s.audit(x.r, x.ws.ID, x.user, "secret.used", "secret", sec.ID, map[string]string{"name": sec.Name, "method": req.Method, "host": target.Host, "path": target.Path})
	mask := secretMasker(value)
	if err != nil {
		return x.ok(map[string]any{"ok": false, "error": mask(err.Error()), "ms": time.Since(started).Milliseconds()})
	}
	defer resp.Body.Close()
	raw, cut, err := readSecretAnswer(resp.Body)
	if err != nil {
		return x.ok(map[string]any{"ok": false, "error": mask(err.Error()), "ms": time.Since(started).Milliseconds()})
	}
	headers := map[string]string{}
	for k, vs := range resp.Header {
		if k == "Set-Cookie" {
			continue
		}
		headers[k] = mask(strings.Join(vs, ", "))
	}
	out := map[string]any{"ok": resp.StatusCode >= 200 && resp.StatusCode < 300, "status": resp.StatusCode, "headers": headers,
		"ms": time.Since(started).Milliseconds(), "truncated": cut}
	if isText(resp.Header.Get("Content-Type"), raw) {
		out["body"] = mask(string(raw))
	} else {
		out["body_base64"] = base64.StdEncoding.EncodeToString(raw)
	}
	if x.wantText() {
		return x.text(secretAnswerText(resp.StatusCode, headers, out, len(raw)))
	}
	return x.ok(out)
}

// newSecretRequest builds the request the vault sends: the secret filled in
// where it is asked for, and the address checked against the hosts the
// secret is bound to. target is the address as the caller wrote it, for the
// audit log.
func newSecretRequest(x *c, sec core.Secret, value string, b secretRequest) (req *http.Request, target *url.URL, err error) {
	u, err := url.Parse(fillSecret(b.URL, value))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, nil, &engine.Error{Code: engine.CodeInvalid, Field: "url", Message: "url must be a full http(s) address"}
	}
	if len(sec.Hosts) == 0 {
		return nil, nil, errForbidden("the secret %s is not bound to any host, so it cannot be sent anywhere; an admin sets its hosts", sec.Name)
	}
	if !hostAllowed(sec, u) {
		return nil, nil, &engine.Error{Code: engine.CodeForbidden, Field: "url", Allowed: sec.Hosts,
			Message: fmt.Sprintf("the secret %s may only be sent to: %s", sec.Name, strings.Join(sec.Hosts, ", "))}
	}
	method := strings.ToUpper(b.Method)
	if method == "" {
		method = "GET"
	}
	body := []byte(fillSecret(b.Body, value))
	if b.BodyBase64 != "" {
		if body, err = base64.StdEncoding.DecodeString(b.BodyBase64); err != nil {
			return nil, nil, &engine.Error{Code: engine.CodeInvalid, Field: "body_base64", Message: "body_base64 does not decode"}
		}
	}
	req, err = http.NewRequestWithContext(x.ctx(), method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, nil, &engine.Error{Code: engine.CodeInvalid, Field: "method", Message: err.Error()}
	}
	for k, v := range b.Headers {
		req.Header.Set(k, fillSecret(v, value))
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "quadit")
	}
	return req, u, nil
}

// fillSecret puts the secret's value where a template asks for it:
// {{secret}}, {{secret:base64}}, and {{basic:user}} for "user:value" in
// base64, for Basic sign-in.
func fillSecret(template, value string) string {
	v := strings.ReplaceAll(template, "{{secret}}", value)
	v = strings.ReplaceAll(v, "{{secret:base64}}", base64.StdEncoding.EncodeToString([]byte(value)))
	for {
		i := strings.Index(v, "{{basic:")
		if i < 0 {
			break
		}
		j := strings.Index(v[i:], "}}")
		if j < 0 {
			break
		}
		user := v[i+len("{{basic:") : i+j]
		v = v[:i] + base64.StdEncoding.EncodeToString([]byte(user+":"+value)) + v[i+j+2:]
	}
	return v
}

// secretMasker blanks a secret's value out of anything that goes back to
// the caller, plain or in base64.
func secretMasker(value string) func(string) string {
	return func(v string) string {
		v = strings.ReplaceAll(v, value, secretMask)
		return strings.ReplaceAll(v, base64.StdEncoding.EncodeToString([]byte(value)), secretMask)
	}
}

// secretAnswerLimit is how much of an answer the vault passes back.
const secretAnswerLimit = 1 << 20

// readSecretAnswer reads an answer's body up to secretAnswerLimit; cut
// says there was more.
func readSecretAnswer(body io.Reader) (raw []byte, cut bool, err error) {
	raw, err = io.ReadAll(io.LimitReader(body, secretAnswerLimit+1))
	if err != nil {
		return nil, false, err
	}
	if len(raw) > secretAnswerLimit {
		return raw[:secretAnswerLimit], true, nil
	}
	return raw, false, nil
}

// secretAnswerText is an answer in the compact text form: the status, the
// headers worth seeing, and the body. out is the answer as JSON; size is
// how many bytes of body were read.
func secretAnswerText(status int, headers map[string]string, out map[string]any, size int) string {
	var text strings.Builder
	fmt.Fprintf(&text, "%d %s\n", status, http.StatusText(status))
	for _, k := range slices.Sorted(maps.Keys(headers)) {
		if k == "Content-Type" || k == "Location" || strings.HasPrefix(k, "X-Ratelimit") {
			fmt.Fprintf(&text, "%s: %s\n", k, headers[k])
		}
	}
	text.WriteString("\n")
	if body, ok := out["body"].(string); ok {
		text.WriteString(body)
	} else {
		fmt.Fprintf(&text, "(%d bytes, not text)", size)
	}
	if cut, _ := out["truncated"].(bool); cut {
		text.WriteString("\n(cut at 1 MB)")
	}
	return text.String() + "\n"
}

// markSecretUsed notes when a secret was last used. The audit log has
// every use, so a failure here is only logged.
func (s *Server) markSecretUsed(x *c, sec core.Secret, at time.Time) {
	if _, err := x.db.Update(x.ctx(), "secrets", map[string]any{"last_used_at": at.UnixMilli()}, store.Eq("id", sec.ID)); err != nil {
		s.log.Warn("secret's last use not recorded", "secret", sec.Name, "err", err)
	}
}

// isText reports whether an answer can be shown as text.
func isText(contentType string, raw []byte) bool {
	ct := strings.ToLower(contentType)
	if strings.HasPrefix(ct, "text/") || strings.Contains(ct, "json") || strings.Contains(ct, "xml") || strings.Contains(ct, "x-www-form-urlencoded") {
		return true
	}
	return ct == "" && json.Valid(raw)
}

// handleListEnvSecrets hands secrets marked env to a companion, for the environment
// of the command it runs. Only a token made for this may ask.
func (s *Server) handleListEnvSecrets(x *c) error {
	if x.token == nil || !slices.Contains(strings.Fields(x.token.Scopes), "secrets") {
		return errForbidden("only a companion's token made for secrets may receive them; an admin makes one with secrets=true")
	}
	var b struct {
		Names []string `json:"names"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	if len(b.Names) == 0 {
		return errBad("names is required")
	}
	out := map[string]string{}
	for _, name := range b.Names {
		sec, value, err := s.secret(x, name)
		if err != nil {
			return err
		}
		if !sec.Env {
			return errForbidden("the secret %s is not marked for use in an environment; use it through secrets/%s/request, or ask an admin", sec.Name, sec.Name)
		}
		out[sec.Name] = value
		s.markSecretUsed(x, sec, time.Now())
		s.audit(x.r, x.ws.ID, x.user, "secret.given_to_companion", "secret", sec.ID, map[string]string{"name": sec.Name})
	}
	x.w.Header().Set("Cache-Control", "no-store")
	return x.ok(map[string]any{"env": out})
}
