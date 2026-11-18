package server

// The vault. A secret is set by an admin and never comes back out of the
// API. An agent uses one in two ways:
//
//   - It asks the server to make an HTTP request for it, writing {{secret}}
//     where the value belongs. The request goes only to the hosts the secret
//     is bound to, redirects are not followed, every form of the value that
//     was sent is blanked out of the answer, and an answer that is not text
//     is not passed on. The agent uses the key without being handed it, as
//     far as the services it is bound to keep it to themselves.
//   - A secret marked env is handed to the companion ("quadit run"), which
//     must hold a token made for that, to put in the environment of the
//     command it starts. This is for tools on the agent's own machine.
//
// Every use is written to the audit log.

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// secretRoutes are the routes of using secrets without reading them.
func (s *Server) secretRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/secrets", s.workspaceMember(s.handleListSecrets), "The secrets the caller may use: names, hosts and what they are for. Values are never returned.", "", "secrets"},
		{"POST /api/v1/w/{ws}/secrets/{name}/request", s.workspaceMember(s.handleSendRequestWithSecret), "Make an HTTP request with a secret the caller cannot read. Body: {method, url, headers, body, approval}; write {{secret}} where the value belongs. A method other than GET is held as the change secret.send is, whose args are the whole request as written. Only to the secret's hosts; redirects are not followed; every form of the value sent is blanked out of the answer, and an answer that is not text is not passed on (body_omitted).", "", "secrets"},
		{"POST /api/v1/w/{ws}/secrets/env", s.workspaceMember(s.handleListEnvSecrets), "For a companion's token made for secrets: the values of secrets marked env. Body: {names}.", "", "secrets"},
	}
}

// secretRequestTimeout is how long a request made with a secret may take.
// It goes out through s.outbound, which never follows a redirect: a secret
// goes to the host it was sent to and no further.
const secretRequestTimeout = 30 * time.Second

const secretMask = "•••"

// mayUseSecret reports whether the caller is among those a secret is for.
func (who *viewer) mayUseSecret(sec core.Secret) bool { return engine.MayUseSecret(sec, who.member) }

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
	if err := x.mayWrite(); err != nil {
		return sec, "", err
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
	// Approval is an approved decision for the secret.send this request
	// stands for, from one who must get approval before it.
	Approval string `json:"approval"`
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
	use := &secretUse{value: value}
	req, err := newSecretRequest(x, sec, use, b)
	if err != nil {
		return err
	}
	if err := s.permitSending(x, sec, req.Method, b); err != nil {
		return err
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(x.ctx(), secretRequestTimeout)
	defer cancel()
	resp, err := s.outbound.Do(req.WithContext(ctx))
	s.markSecretUsed(x, sec, started)
	// The record has the address as the caller wrote it: with the value in
	// it, the audit log would hand it to whoever reads that.
	written, perr := url.Parse(b.URL)
	if perr != nil {
		written = &url.URL{Host: req.URL.Host}
	}
	s.audit(x.r, x.ws.ID, x.user, "secret.used", "secret", sec.ID, map[string]string{"name": sec.Name, "method": req.Method, "host": written.Host, "path": written.Path})
	if err != nil {
		return x.ok(map[string]any{"ok": false, "error": use.mask(err.Error()), "ms": time.Since(started).Milliseconds()})
	}
	defer resp.Body.Close()
	raw, cut, err := use.readAnswer(resp.Body)
	if err != nil {
		return x.ok(map[string]any{"ok": false, "error": use.mask(err.Error()), "ms": time.Since(started).Milliseconds()})
	}
	headers := map[string]string{}
	for k, vs := range resp.Header {
		if k == "Set-Cookie" {
			continue
		}
		headers[k] = use.mask(strings.Join(vs, ", "))
	}
	out := map[string]any{"ok": resp.StatusCode >= 200 && resp.StatusCode < 300, "status": resp.StatusCode, "headers": headers,
		"ms": time.Since(started).Milliseconds(), "truncated": cut, "size": len(raw)}
	if isText(resp.Header, raw) {
		out["body"] = string(raw)
	} else {
		// Bytes, or text compressed or in another encoding: the value could
		// be in there in a form no search finds, so none of it is passed on.
		// What it says it is comes from the blanked headers: a service can
		// say the value back there too.
		out["body_omitted"] = "the answer is not text (" + cmp.Or(headers["Content-Encoding"], headers["Content-Type"], "no Content-Type") +
			"), so the vault cannot blank the secret out of it and does not pass it on"
	}
	if x.wantText() {
		return x.text(secretAnswerText(resp.StatusCode, headers, out))
	}
	return x.ok(out)
}

// permitSending holds a request that can change something at the far end
// (any method but GET, HEAD and OPTIONS) as a change is held: it is applied
// as secret.send, whose arguments are the whole request as the caller
// wrote it, {{secret}} and all (everything it sent but the approval), so a
// member who may only read cannot send it and an agent that must ask first
// needs an approval of exactly that request. A refusal for want of one says
// what to ask for.
func (s *Server) permitSending(x *c, sec core.Secret, method string, b secretRequest) error {
	if method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions {
		return nil
	}
	request := map[string]any{"name": sec.Name, "method": method, "url": b.URL}
	if len(b.Headers) > 0 {
		request["headers"] = b.Headers
	}
	if b.Body != "" {
		request["body"] = b.Body
	}
	if b.BodyBase64 != "" {
		request["body_base64"] = b.BodyBase64
	}
	args := plainjson.Marshal(request)
	_, err := s.eng.Apply(x.ctx(), x.ws.ID, x.actor, engine.Change{ID: id.New(), Type: "secret.send", Args: args, Approval: b.Approval})
	if refusal, ok := errors.AsType[*engine.Error](err); ok && refusal.Code == engine.CodeNeedsApproval {
		refusal.Message += ". The arguments of this request, to ask with: " + string(args)
	}
	return err
}

// newSecretRequest builds the request the vault sends: the secret filled in
// where it is asked for, and the address checked against the hosts the
// secret is bound to.
func newSecretRequest(x *c, sec core.Secret, use *secretUse, b secretRequest) (*http.Request, error) {
	u, err := url.Parse(use.fillURL(b.URL))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, &engine.Error{Code: engine.CodeInvalid, Field: "url", Message: "url must be a full http(s) address"}
	}
	if len(sec.Hosts) == 0 {
		return nil, errForbidden("the secret %s is not bound to any host, so it cannot be sent anywhere; an admin sets its hosts", sec.Name)
	}
	if !hostAllowed(sec, u) {
		return nil, &engine.Error{Code: engine.CodeForbidden, Field: "url", Allowed: sec.Hosts,
			Message: fmt.Sprintf("the secret %s may only be sent to: %s", sec.Name, strings.Join(sec.Hosts, ", "))}
	}
	method := strings.ToUpper(b.Method)
	if method == "" {
		method = "GET"
	}
	body := []byte(use.fill(b.Body))
	if b.BodyBase64 != "" {
		if body, err = base64.StdEncoding.DecodeString(b.BodyBase64); err != nil {
			return nil, &engine.Error{Code: engine.CodeInvalid, Field: "body_base64", Message: "body_base64 does not decode"}
		}
	}
	req, err := http.NewRequestWithContext(x.ctx(), method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, &engine.Error{Code: engine.CodeInvalid, Field: "method", Message: err.Error()}
	}
	for k, v := range b.Headers {
		req.Header.Set(k, use.fill(v))
	}
	// The answer must come back as the service wrote it, for the secret to
	// be found in it: the client asks for compression itself and undoes it.
	req.Header.Del("Accept-Encoding")
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "quadit")
	}
	return req, nil
}

// secretUse is one use of a secret's value: it puts the value where a
// request's templates ask for it, remembers each form the value went out
// in, and blanks every one of those forms out of what comes back, as they
// were sent and as a service that says them back may have escaped them
// (in an address, in JSON, in HTML). Everything is filled before the first
// mask: the forms to blank are settled then.
type secretUse struct {
	value string
	sent  []string // the forms of the value filled in so far
	masks []string // what mask blanks, longest first; made on first use
}

// fill puts the value where a template asks for it: {{secret}},
// {{secret:base64}}, and {{basic:user}} for "user:value" in base64, for
// Basic sign-in.
func (use *secretUse) fill(template string) string {
	return use.fillEscaped(template, func(v string) string { return v })
}

// fillURL fills an address, each form escaped for where it stands: in the
// path, or in the query.
func (use *secretUse) fillURL(template string) string {
	path, query, hasQuery := strings.Cut(template, "?")
	filled := use.fillEscaped(path, url.PathEscape)
	if hasQuery {
		filled += "?" + use.fillEscaped(query, url.QueryEscape)
	}
	return filled
}

func (use *secretUse) fillEscaped(template string, escape func(string) string) string {
	put := func(form string) string {
		use.sent = append(use.sent, form)
		return escape(form)
	}
	v := template
	if strings.Contains(v, "{{secret}}") {
		v = strings.ReplaceAll(v, "{{secret}}", put(use.value))
	}
	if strings.Contains(v, "{{secret:base64}}") {
		v = strings.ReplaceAll(v, "{{secret:base64}}", put(base64.StdEncoding.EncodeToString([]byte(use.value))))
	}
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
		v = v[:i] + put(base64.StdEncoding.EncodeToString([]byte(user+":"+use.value))) + v[i+j+2:]
	}
	return v
}

// mask blanks every form of the value out of text going back to the
// caller.
func (use *secretUse) mask(text string) string {
	for _, m := range use.forms() {
		text = strings.ReplaceAll(text, m, secretMask)
	}
	return text
}

// forms are what mask blanks, longest first: each form of the value sent,
// and the value itself and its base64 even when not sent, as they are and
// escaped.
func (use *secretUse) forms() []string {
	if use.masks == nil {
		seen := map[string]bool{}
		for _, form := range append([]string{use.value, base64.StdEncoding.EncodeToString([]byte(use.value))}, use.sent...) {
			quoted, _ := json.Marshal(form)
			for _, m := range []string{form, url.QueryEscape(form), url.PathEscape(form), strings.Trim(string(quoted), `"`), html.EscapeString(form)} {
				if m != "" && !seen[m] {
					seen[m] = true
					use.masks = append(use.masks, m)
				}
			}
		}
		slices.SortFunc(use.masks, func(a, b string) int { return len(b) - len(a) })
	}
	return use.masks
}

// secretAnswerLimit is how much of an answer the vault passes back.
const secretAnswerLimit = 1 << 20

// readAnswer reads an answer's body up to secretAnswerLimit, blanked; cut
// says there was more. It blanks before it cuts: a form of the value that
// the cut would split is blanked whole, not left half there.
func (use *secretUse) readAnswer(body io.Reader) (text []byte, cut bool, err error) {
	longest := len(use.forms()[0])
	raw, err := io.ReadAll(io.LimitReader(body, int64(secretAnswerLimit+longest+1)))
	if err != nil {
		return nil, false, err
	}
	cut = len(raw) > secretAnswerLimit
	text = []byte(use.mask(string(raw)))
	if len(text) > secretAnswerLimit {
		text = text[:secretAnswerLimit]
		for len(text) > 0 {
			if r, size := utf8.DecodeLastRune(text); r != utf8.RuneError || size > 1 {
				break
			}
			text = text[:len(text)-1] // a character the cut split
		}
	}
	return text, cut, nil
}

// secretAnswerText is an answer in the compact text form: the status, the
// headers worth seeing, and the body. out is the answer as JSON.
func secretAnswerText(status int, headers map[string]string, out map[string]any) string {
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
		fmt.Fprintf(&text, "(%d bytes not passed on: %s)", out["size"], out["body_omitted"])
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

// isText reports whether an answer is text the vault can search for the
// secret: declared text, JSON, XML or a form (or undeclared and valid
// JSON), not compressed, and valid UTF-8.
func isText(header http.Header, raw []byte) bool {
	if enc := header.Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		return false
	}
	if !utf8.Valid(raw) {
		return false
	}
	ct := strings.ToLower(header.Get("Content-Type"))
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
