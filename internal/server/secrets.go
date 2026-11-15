package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

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
func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/w/{ws}/secrets", s.workspaceMember(s.handleListSecrets))
		m.HandleFunc("POST /api/v1/w/{ws}/secrets/{name}/request", s.workspaceMember(s.handleSendRequestWithSecret))
		m.HandleFunc("POST /api/v1/w/{ws}/secrets/env", s.workspaceMember(s.handleListEnvSecrets))
	})
}

// secretRequestClient makes the vault's outbound requests. It never follows
// a redirect: a secret goes to the host it was sent to and no further.
var secretRequestClient = &http.Client{
	Timeout:       30 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

const secretMask = "•••"

// mayUseSecret reports whether the caller is among those a secret is for.
func (x *c) mayUseSecret(sec core.Secret) bool {
	if len(sec.Agents) == 0 || x.member.Kind != core.KindAgent {
		return true
	}
	for _, id := range sec.Agents {
		if id == x.member.UserID {
			return true
		}
	}
	return false
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
	if err := x.db.Get(x.ctx(), &sec, store.Eq("name", name), store.Live); err != nil {
		if err := x.db.Get(x.ctx(), &sec, store.Eq("id", name), store.Live); err != nil {
			return sec, "", errNotFound("secret")
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
	fill := func(v string) string {
		v = strings.ReplaceAll(v, "{{secret}}", value)
		v = strings.ReplaceAll(v, "{{secret:base64}}", base64.StdEncoding.EncodeToString([]byte(value)))
		// "user:{{secret}}" in base64, for Basic sign-in.
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
	u, err := url.Parse(fill(b.URL))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return &engine.Error{Code: engine.CodeInvalid, Field: "url", Message: "url must be a full http(s) address"}
	}
	if len(sec.Hosts) == 0 {
		return errForbidden("the secret %s is not bound to any host, so it cannot be sent anywhere; an admin sets its hosts", sec.Name)
	}
	if !hostAllowed(sec, u) {
		return &engine.Error{Code: engine.CodeForbidden, Field: "url", Allowed: sec.Hosts,
			Message: fmt.Sprintf("the secret %s may only be sent to: %s", sec.Name, strings.Join(sec.Hosts, ", "))}
	}
	method := strings.ToUpper(b.Method)
	if method == "" {
		method = "GET"
	}
	body := []byte(fill(b.Body))
	if b.BodyBase64 != "" {
		if body, err = base64.StdEncoding.DecodeString(b.BodyBase64); err != nil {
			return &engine.Error{Code: engine.CodeInvalid, Field: "body_base64", Message: "body_base64 does not decode"}
		}
	}
	req, err := http.NewRequestWithContext(x.ctx(), method, u.String(), bytes.NewReader(body))
	if err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "method", Message: err.Error()}
	}
	for k, v := range b.Headers {
		req.Header.Set(k, fill(v))
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "quadit")
	}
	started := time.Now()
	resp, err := secretRequestClient.Do(req)
	x.db.Update(x.ctx(), "secrets", map[string]any{"last_used_at": started.UnixMilli()}, store.Eq("id", sec.ID))
	s.audit(x.r, x.ws.ID, x.user, "secret.used", "secret", sec.ID, map[string]string{"name": sec.Name, "method": method, "host": u.Host, "path": u.Path})
	// mask blanks the value out of anything that goes back to the caller.
	mask := func(v string) string {
		v = strings.ReplaceAll(v, value, secretMask)
		return strings.ReplaceAll(v, base64.StdEncoding.EncodeToString([]byte(value)), secretMask)
	}
	if err != nil {
		return x.ok(map[string]any{"ok": false, "error": mask(err.Error()), "ms": time.Since(started).Milliseconds()})
	}
	defer resp.Body.Close()
	const limit = 1 << 20
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	cut := len(raw) > limit
	if cut {
		raw = raw[:limit]
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
		var t strings.Builder
		fmt.Fprintf(&t, "%d %s\n", resp.StatusCode, http.StatusText(resp.StatusCode))
		keys := make([]string, 0, len(headers))
		for k := range headers {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if k == "Content-Type" || k == "Location" || strings.HasPrefix(k, "X-Ratelimit") {
				fmt.Fprintf(&t, "%s: %s\n", k, headers[k])
			}
		}
		t.WriteString("\n")
		if body, ok := out["body"].(string); ok {
			t.WriteString(body)
		} else {
			fmt.Fprintf(&t, "(%d bytes, not text)", len(raw))
		}
		if cut {
			t.WriteString("\n(cut at 1 MB)")
		}
		return x.text(t.String() + "\n")
	}
	return x.ok(out)
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
		x.db.Update(x.ctx(), "secrets", map[string]any{"last_used_at": time.Now().UnixMilli()}, store.Eq("id", sec.ID))
		s.audit(x.r, x.ws.ID, x.user, "secret.given_to_companion", "secret", sec.ID, map[string]string{"name": sec.Name})
	}
	x.w.Header().Set("Cache-Control", "no-store")
	return x.ok(map[string]any{"env": out})
}
