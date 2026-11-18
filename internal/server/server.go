// Package server is the HTTP API. The web app, the command-line tool, the
// MCP server and agents all use it; nothing reaches the data another way.
// Every write is a change applied by internal/engine; this package parses
// requests, checks who is asking, reads, and writes answers. Package app
// builds it (New), serves its Handler and runs its background work (Run,
// Stop); routing, sign-in, who may read what (the viewer), the install
// settings and the background loops stay inside.
//
// How the package is laid out:
//
//	Routing and the request context
//	  server.go      the Server, the request context c, the route wrappers
//	                 (public, signedIn, firstStepPassed, workspaceMember),
//	                 sign-in by token or cookie, errors and the audit log
//	  origin.go      which pages a browser's write is taken from
//	  routes.go      the route: one address with its words; allRoutes, the
//	                 list of them all that the mux and openapi.json are both
//	                 made from (each feature's routes are declared beside
//	                 its handlers); the core routes, and /list/{collection}
//	  params.go      checking number, yes/no and date parameters
//	  gzip.go, limits.go, stats.go   compression, rate limits, metrics
//	  inprocess.go   the server calling its own API (MCP tools, imports)
//	  openapi.go     openapi.json, made from allRoutes
//	  settings.go    the table of install settings (package settings keeps
//	                 them: cache, environment, sealing) and sending mail
//	  admin.go       administration
//	Sign-in
//	  auth.go, auth_totp.go, auth_reset.go, auth_invites.go,
//	  auth_passkeys.go, auth_oauth.go, signin_provider.go,
//	  signin_github.go, signin_oidc.go, tokens.go
//	Reads
//	  viewer.go      the viewer: who a read is made for, and what they may
//	                 see. Every read below is a method of it that takes a
//	                 ctx; a handler reads the request, asks the viewer, and
//	                 writes the answer
//	  rowkinds.go    the kinds of row a workspace holds, each with its rule
//	                 for who may see a row: what /list, the starting copy
//	                 and the export give
//	  orient.go (who am I, my work), layout.go, tasks_list.go,
//	  task_detail.go, task_context.go, query.go, render.go, views_shared.go,
//	  search.go, feed.go, bootstrap.go, docs.go, rows.go, files.go,
//	  dashboard*.go
//	  picture.go     a picture of a page as the caller sees it (package
//	                 picture drives the browser)
//	Changes
//	  changes.go     POST /changes: the engine applies, this audits
//	  eventtypes.go  the event types the feed carries
//	Background work
//	  run.go         Run, the list of background loops it starts and the
//	                 list of kinds of job
//	  detached.go    work a request starts and does not wait for
//	  jobs.go, dispatch.go, deliveries.go, backups.go
//	  push.go        browser push: the key and the browsers (package webpush
//	                 sends)
//	Integrations
//	  github.go (when integrations sync; package github does a pass),
//	  reposync.go (routes of package reposync: pages kept in a git repository), secrets.go
//	MCP
//	  mcp.go         signing an MCP client in and the call its tools make;
//	                 the protocol and the tools are package mcp
//	  oauth_server.go  the sign-in server MCP clients use
//	Import and export
//	  importing.go, export*.go
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"reflect"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/github"
	"github.com/agrigoryan/quadit/internal/hub"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/mcp"
	"github.com/agrigoryan/quadit/internal/outbound"
	"github.com/agrigoryan/quadit/internal/picture"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/reposync"
	"github.com/agrigoryan/quadit/internal/settings"
	"github.com/agrigoryan/quadit/internal/store"
)

// Config is what a server needs from its surroundings.
type Config struct {
	DataDir string // uploads in progress, the install secret, local files
	BaseURL string // where people reach the server, e.g. https://quadit.example.com
	// LocalURL is where the server reaches itself, for taking pictures of
	// its own pages. Empty means BaseURL.
	LocalURL string
	Version  string       // shown in /me, openapi.json and the metrics
	Log      *slog.Logger // nil means slog.Default()
	// PrivateNetworks are the networks off the public internet the server
	// may reach for its users (webhooks, push, the vault's requests,
	// imports, GitHub integrations): whoever runs it opens them. None means
	// public addresses only (package outbound).
	PrivateNetworks []netip.Prefix
	// TrustedProxies are the reverse proxies in front of the server: only a
	// connection from one of them may say whom it forwards for
	// (X-Forwarded-For). None means the caller is who connected.
	TrustedProxies []netip.Prefix
	// TakePicture opens a page in a browser and returns a PNG of it, and
	// the page's whole height. nil means picture.Take, with the Chrome or
	// Chromium of this machine.
	TakePicture func(context.Context, picture.Request) (png []byte, whole int, err error)
}

// Server holds everything a request needs. New sets every field except
// web (SetWeb), the file store after a "files" setting (useFiles), the
// caches, which fill as requests come, and the limiter's factor (applyLimits).
type Server struct {
	cfg     Config         // as given to New, with Log filled in
	origin  string         // cfg.BaseURL's origin: the pages a browser's write may come from (origin.go)
	st      store.Store    // the database
	eng     *engine.Engine // applies every change
	hub     *hub.Hub       // wakes the requests waiting for the feed to move
	filesMu sync.RWMutex   // guards files, which useFiles replaces
	files   blob.Store     // where files go now
	disk    blob.Store     // the local store, always there
	sealer  *auth.Sealer   // encrypts secrets kept in the database
	log     *slog.Logger   // cfg.Log
	mux     *http.ServeMux // the API's routes, made by routes()
	web     http.Handler   // the web app, when built in

	seenMu   sync.Mutex         // guards seen
	seen     map[string]int64   // user id + workspace id -> last time presence was written
	settings *settings.Settings // the install's settings (settings.go)
	limits   *limiter           // requests per caller per minute (limits.go)
	// quit is closed when the server is told to stop: held connections
	// (live streams, waits for the next event) end then, at once.
	quit     chan struct{}
	quitOnce sync.Once // Stop closes quit once
	stats    stats     // request counts for /metrics

	// repos mirrors folders of git repositories as pages (reposync.go).
	repos *reposync.Syncer
	// mcp answers MCP clients once they are signed in (mcp.go).
	mcp *mcp.Server
	// github runs the passes of GitHub integrations (github.go).
	github *github.Syncer
	// detached is the work requests leave running after their answer (detached.go).
	detached detached
	// outbound makes the requests that go where a user said: push, webhooks,
	// the vault, imports, GitHub integrations. It reaches public addresses
	// and cfg.PrivateNetworks only, and follows no redirect.
	outbound *http.Client
}

// Stop ends the connections the server holds open for its callers, so a
// shutdown does not wait out their timeouts. Requests in progress finish.
func (s *Server) Stop() { s.quitOnce.Do(func() { close(s.quit) }) }

// keptOpenContext returns a context for a connection that is kept open: it ends with
// the request, and when the server stops.
func (s *Server) keptOpenContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	go func() {
		select {
		case <-s.quit:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

// New wires a server. Call Handler to serve it and Run for background work.
func New(cfg Config, st store.Store, files blob.Store, sealer *auth.Sealer) *Server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.TakePicture == nil {
		cfg.TakePicture = picture.Take
	}
	s := &Server{cfg: cfg, st: st, eng: engine.New(st, sealer.Seal), hub: hub.New(), files: files, disk: files, sealer: sealer, log: cfg.Log,
		seen: map[string]int64{}, limits: newLimiter(), quit: make(chan struct{}), outbound: outbound.Client(cfg.PrivateNetworks), origin: originOf(cfg.BaseURL)}
	s.eng.OnCommit = s.hub.Notify
	s.settings = settings.New(st, sealer, cfg.Log, s.settingKinds())
	s.repos = &reposync.Syncer{Store: st, Engine: s.eng, Log: cfg.Log, DataDir: cfg.DataDir}
	s.mcp = mcp.New(s.callAsToken, cfg.Version)
	s.github = &github.Syncer{Store: st, Engine: s.eng, Sealer: sealer, HTTP: s.outbound, BaseURL: cfg.BaseURL, Version: cfg.Version}
	s.routes()
	return s
}

// fileStore returns where files are kept right now.
func (s *Server) fileStore() blob.Store {
	s.filesMu.RLock()
	defer s.filesMu.RUnlock()
	return s.files
}

// useFiles switches file storage to what the "files" setting says. A cloud
// store is layered over the local one, so files not yet copied over are
// still found, and a background job copies them.
func (s *Server) useFiles(ctx context.Context, c blob.Config) error {
	next := s.disk
	if c.Kind != "" && c.Kind != "disk" {
		cloud, err := blob.Open(ctx, c, s.cfg.DataDir)
		if err != nil {
			return err
		}
		// Prove the store takes a write before trusting uploads to it.
		probe := "probe/" + id.New()
		if err := cloud.Put(ctx, probe, strings.NewReader("ok"), "text/plain"); err != nil {
			return fmt.Errorf("file storage: the store refused a test write: %w", err)
		}
		_ = cloud.Delete(ctx, probe) // best effort: a leftover probe is a two-byte file and harms nothing
		next = blob.Layered{Primary: cloud, Old: s.disk}
		if err := s.enqueue(ctx, "files.move", "", "files.move", nil, time.Now().Add(5*time.Second)); err != nil {
			s.log.Error("copying local files to the cloud store; queued again when the server next starts", "err", err)
		}
	}
	s.filesMu.Lock()
	s.files = next
	s.filesMu.Unlock()
	return nil
}

// Engine returns the change engine, for commands that run beside the server.
func (s *Server) Engine() *engine.Engine { return s.eng }

// Hub returns the hub that wakes waiters.
func (s *Server) Hub() *hub.Hub { return s.hub }

// SetWeb installs the handler that serves the web app.
func (s *Server) SetWeb(h http.Handler) { s.web = h }

// httpError is a refusal made by the API itself rather than the engine:
// sign-in, rate limits. fail writes it with its own status.
type httpError struct {
	Status     int    // the HTTP status
	Code       string // what a client compares: "unauthorized", "rate_limited", …
	Message    string // what a person reads
	RetryAfter int    // seconds to wait, sent as Retry-After when not 0
}

func (e *httpError) Error() string { return e.Code + ": " + e.Message }

// errUnauthorized refuses a caller who is not signed in (401).
func errUnauthorized(msg string) error {
	return &httpError{Status: 401, Code: "unauthorized", Message: msg}
}

// errBad refuses a request that is wrong as sent (400).
func errBad(format string, a ...any) error {
	return &engine.Error{Code: engine.CodeInvalid, Message: fmt.Sprintf(format, a...)}
}

// errForbidden refuses what the caller may not do (403).
func errForbidden(format string, a ...any) error {
	return &engine.Error{Code: engine.CodeForbidden, Message: fmt.Sprintf(format, a...)}
}

// errNotFound says that what was asked for is not there, or not for this
// caller (404).
func errNotFound(what string) error {
	return &engine.Error{Code: engine.CodeNotFound, Message: what + " not found"}
}

// statusOf is the HTTP status of each engine error code; fail answers 400
// for a code not listed.
var statusOf = map[string]int{
	engine.CodeInvalid: 400, engine.CodeForbidden: 403, engine.CodeNotFound: 404, engine.CodeConflict: 409,
	engine.CodeStale: 409, engine.CodeNeedsApproval: 403, engine.CodeHandoffLimit: 403,
}

// c is one request with who is asking: the request context every handler
// takes, named x. The route wrapper makes it with s, w and r (and
// firstStepEnough); identify fills in who is asking; enterWorkspace fills
// in the viewer (the workspace, the membership and what the caller may
// read there) and the actor. What reads the workspace's data is a method
// of the viewer, not of c: c is the HTTP side of a request.
type c struct {
	narrowed bool // fields= and since= were applied by the handler (narrowedAlready)
	s        *Server
	w        http.ResponseWriter
	r        *http.Request
	user     core.User      // the account asking (identify)
	sess     *core.Session  // the session, when signed in by cookie (identify)
	token    *core.APIToken // the token, when signed in by one (identify)
	// viewer is the caller as a member of the workspace in the path, with
	// what it may read (enterWorkspace). Its fields and methods are used as
	// the request's own: x.ws, x.member, x.db, x.canProject.
	viewer
	// actor is who the engine applies changes as, read-only or limited to
	// projects by the token's scopes (enterWorkspace).
	actor engine.Actor
	// firstStepEnough lets a session that still owes its second step through.
	// Set by firstStepPassed.
	firstStepEnough bool
}

// ctx is the request's context: it ends when the caller goes away.
func (x *c) ctx() context.Context { return x.r.Context() }

// json writes v with a status.
func (x *c) json(status int, v any) error {
	x.w.Header().Set("Content-Type", "application/json; charset=utf-8")
	x.w.WriteHeader(status)
	return json.NewEncoder(x.w).Encode(noNulls(v))
}

// noNulls turns the empty lists in an answer into [] instead of null, so a
// client can count on a list being a list. It looks inside the maps answers
// are built from.
func noNulls(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	for k, val := range m {
		if inner, ok := val.(map[string]any); ok {
			m[k] = noNulls(inner)
			continue
		}
		if rv := reflect.ValueOf(val); rv.Kind() == reflect.Slice && rv.IsNil() {
			m[k] = reflect.MakeSlice(rv.Type(), 0, 0).Interface()
		}
	}
	return m
}

// ok answers 200 with v as JSON, after applying the list selectors of a
// GET: fields=a,b keeps only those fields of each row (and its id and key),
// and since=N keeps only the rows that changed after that position in the
// feed, so a caller never pays for what it already knows. The selectors
// apply to every list at the top level of v; a handler that applied them
// itself says so with narrowedAlready.
func (x *c) ok(v any) error {
	q := x.r.URL.Query()
	fields, since := splitList(q.Get("fields")), q.Get("since")
	if x.r.Method != http.MethodGet || (len(fields) == 0 && since == "") || x.narrowed {
		return x.json(200, v)
	}
	doc, ok := asDocument(v)
	if !ok {
		return x.json(200, v)
	}
	sel := newRowSelector(fields, since)
	for name, val := range doc {
		if rows, isList := val.([]any); isList {
			doc[name] = sel.apply(rows)
		}
	}
	return x.json(200, doc)
}

// asDocument is v as the JSON object it is sent as, with its lists as
// []any and its rows as maps; false when v is not an object.
func asDocument(v any) (map[string]any, bool) {
	raw, err := json.Marshal(noNulls(v))
	if err != nil {
		return nil, false
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil, false
	}
	return doc, true
}

// rowSelector is what fields= and since= ask of the rows of a list.
type rowSelector struct {
	fields map[string]bool // the fields to keep; nil keeps every field
	since  bool            // since= was given
	after  int64           // keep only the rows that changed after this feed position
}

func newRowSelector(fields []string, since string) rowSelector {
	// A since that is not a number reads as 0; the workspace routes refuse
	// one before this, in checkParams.
	after, _ := strconv.ParseInt(since, 10, 64) // a bad since reads as 0 (see above)
	sel := rowSelector{since: since != "", after: after}
	if len(fields) > 0 {
		sel.fields = map[string]bool{"id": true, "key": true}
		for _, f := range fields {
			sel.fields[f] = true
		}
	}
	return sel
}

// apply returns the rows the selector keeps, with only the fields it keeps.
// An item that is not a row is kept as it is.
func (sel rowSelector) apply(rows []any) []any {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		row, ok := r.(map[string]any)
		if !ok {
			out = append(out, r)
			continue
		}
		if sel.since && !sel.changedAfter(row) {
			continue
		}
		if sel.fields != nil {
			for k := range row {
				if !sel.fields[k] {
					delete(row, k)
				}
			}
		}
		out = append(out, row)
	}
	return out
}

// changedAfter reports whether a row changed after the selector's position.
// A row's place in the feed is when it last changed, or when it was made;
// a row with neither is kept.
func (sel rowSelector) changedAfter(row map[string]any) bool {
	at, found := row["updated_seq"].(float64)
	if !found {
		at, found = row["seq"].(float64)
	}
	return !found || int64(at) > sel.after
}

// text answers 200 with body as plain text.
func (x *c) text(body string) error {
	x.w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, err := io.WriteString(x.w, body)
	return err
}

// wantText reports whether the caller asked for the compact text form.
func (x *c) wantText() bool {
	if f := x.r.URL.Query().Get("format"); f != "" {
		return f == "text"
	}
	return strings.HasPrefix(x.r.Header.Get("Accept"), "text/plain")
}

// body decodes the JSON request body into v. A field v does not have, a
// body over 16 MB, or one that is not JSON is refused as a bad request. A
// body sent with the session cookie must also say it is JSON: a page of
// another site can send a form or plain text without asking first.
func (x *c) body(v any) error {
	if x.sess != nil && !saysJSON(x.r) {
		return errBad("request body: send it as JSON, with Content-Type: application/json")
	}
	dec := json.NewDecoder(http.MaxBytesReader(x.w, x.r.Body, 16<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBad("request body: %s", engine.PlainJSON(err))
	}
	return nil
}

// intParam is a whole-number URL parameter, or def when it is missing or
// not a number.
func (x *c) intParam(name string, def int) int {
	if v := x.r.URL.Query().Get(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// narrowedAlready marks an answer whose handler applied fields and since
// itself, so they are not applied a second time.
func (x *c) narrowedAlready() { x.narrowed = true }

// hasFullAccess reports whether the caller acts with everything the account may
// do: a signed-in session, or a token with no narrowing on it.
func (x *c) hasFullAccess() bool {
	if x.sess != nil {
		return x.sess.Stage == core.SessionFull
	}
	return x.token != nil && x.token.Kind == core.TokenAPI && x.token.Scopes == ""
}

// mayWrite refuses a caller who may only read, whether the credential used
// says so or the membership does (engine.Effective): what the engine asks
// of every change, for a write the server makes itself.
func (x *c) mayWrite() error {
	if engine.Effective(x.member, x.actor).ReadOnly {
		return errForbidden("this credential is read-only")
	}
	return nil
}

// fail writes an error in the one shape every error has.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var he *httpError
	var ee *engine.Error
	var missing *store.NotFoundError
	status := 500
	body := map[string]any{"code": "internal", "message": "something went wrong on the server; the log has the details"}
	switch {
	case errors.As(err, &he):
		status = he.Status
		body = map[string]any{"code": he.Code, "message": he.Message}
		if he.RetryAfter > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(he.RetryAfter))
			body["retry_after"] = he.RetryAfter
		}
	case errors.As(err, &ee):
		status = statusOf[ee.Code]
		if status == 0 {
			status = 400
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]any{"error": ee})
		return
	case errors.As(err, &missing):
		status, body = 404, map[string]any{"code": engine.CodeNotFound, "message": missing.Error()}
	case errors.Is(err, store.ErrNotFound):
		status, body = 404, map[string]any{"code": engine.CodeNotFound, "message": "not found"}
	case errors.Is(err, context.Canceled):
		return // the caller went away
	default:
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": body})
}

// handler is an API handler: it reads the request from x and writes the
// answer to it, or returns the error fail writes.
type handler func(*c) error

// Rate limits, in requests per minute; the admin area scales them all
// (limits.api_per_minute).
const (
	limitPerAddress   = 600  // calls that need no sign-in, by address
	limitBadTokens    = 120  // tokens that are not valid, by address
	limitPerToken     = 1200 // calls made with one token
	limitPerSignedIn  = 3000 // calls made by a signed-in person
	presenceEvery     = 20_000
	signInWriteEvery  = 60_000        // how often a token's or session's last use is written, in ms
	tokenAuditedEvery = 24 * 3600_000 // how often a token's use goes in the audit log, in ms
)

// selfCallAddr is the address an in-process call made with a token comes
// from (bearerOf). Its bad tokens are not counted as guesses.
const selfCallAddr = "127.0.0.1:0"

// public wraps a handler that anyone may call, without signing in. It
// checks only the rate limit of the caller's address and fills in nothing
// beyond the request; the handler's URL parameters are not checked.
func (s *Server) public(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r}
		if err := s.limits.check("ip:"+s.clientIP(r), limitPerAddress); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := h(x); err != nil {
			s.fail(w, r, err)
		}
	}
}

// signedIn wraps a handler that needs a signed-in person or a token, but no
// workspace. It runs identify, which fills in user and either sess or
// token, refuses a session that still owes its second step, and checks the
// caller's rate limit.
func (s *Server) signedIn(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r}
		if err := s.identify(r.Context(), x); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := h(x); err != nil {
			s.fail(w, r, err)
		}
	}
}

// firstStepPassed wraps a handler for someone who has passed the first
// sign-in step and may still owe the second: it is signedIn with
// firstStepEnough set, so a session at any stage is let through.
func (s *Server) firstStepPassed(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r, firstStepEnough: true}
		if err := s.identify(r.Context(), x); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := h(x); err != nil {
			s.fail(w, r, err)
		}
	}
}

// workspaceMember wraps a handler that works inside the workspace named in
// the path ({ws}, or "-" for a token's own). It runs identify as signedIn
// does, then enterWorkspace: the caller must be a member, not suspended,
// and the context is given the workspace, the membership, the actor, the
// projects the caller may read and a database bound to the workspace.
// Last, the URL's number, yes/no and date parameters are checked
// (checkParams).
func (s *Server) workspaceMember(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r}
		err := s.identify(r.Context(), x)
		if err == nil {
			err = s.enterWorkspace(r.Context(), x, r.PathValue("ws"))
		}
		if err == nil {
			err = checkParams(r.URL.Query())
		}
		if err == nil {
			err = h(x)
		}
		if err != nil {
			s.fail(w, r, err)
		}
	}
}

const sessionCookie = "quadit_session"

// identify finds who is asking: a token in the Authorization header, or a
// session cookie. It fills in x.user and x.token or x.sess, and counts the
// request against the caller's rate limit unless it is made inside another
// request (inProcess).
func (s *Server) identify(ctx context.Context, x *c) error {
	now := time.Now().UnixMilli()
	if h := x.r.Header.Get("Authorization"); h != "" {
		return s.identifyByToken(ctx, x, h, now)
	}
	return s.identifyBySession(ctx, x, now)
}

// identifyByToken signs the caller in with the token in an Authorization
// header.
func (s *Server) identifyByToken(ctx context.Context, x *c, header string, now int64) error {
	tok := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	var t core.APIToken
	there, err := store.Find(ctx, s.st, &t, store.Eq("token_hash", auth.Hash(tok)), store.Null("revoked_at"))
	if err != nil {
		return err
	}
	if !there {
		// Guesses are counted by where they come from.
		if lerr := s.limits.check("bad:"+s.clientIP(x.r), limitBadTokens); lerr != nil && x.r.RemoteAddr != selfCallAddr {
			return lerr
		}
		return errUnauthorized("this token is not valid, or was revoked")
	}
	if t.ExpiresAt != 0 && t.ExpiresAt < now {
		return errUnauthorized("this token has expired")
	}
	if err := s.loadAccount(ctx, x, t.UserID, "this token's account is disabled"); err != nil {
		return err
	}
	x.token = &t
	if now-t.LastUsedAt > tokenAuditedEvery {
		// A token's use is on the record: its first, and then once for
		// each day it is used.
		s.audit(x.r, t.WorkspaceID, x.user, "token.used", "token", t.ID, map[string]string{"name": t.Name})
	}
	if now-t.LastUsedAt > signInWriteEvery {
		_, _ = s.st.Update(ctx, "api_tokens", map[string]any{"last_used_at": now}, store.Eq("id", t.ID)) // best effort: last use is shown to people, and written again on the next call
	}
	if ctx.Value(inProcess{}) != nil {
		return nil // the server working for the caller, inside one request already counted
	}
	return s.limits.check("t:"+t.ID, limitPerToken)
}

// identifyBySession signs the caller in with the session cookie.
func (s *Server) identifyBySession(ctx context.Context, x *c, now int64) error {
	ck, err := x.r.Cookie(sessionCookie)
	if err != nil || ck.Value == "" {
		return errUnauthorized("sign in, or send a token in the Authorization header")
	}
	var sess core.Session
	there, err := store.Find(ctx, s.st, &sess, store.Eq("token_hash", auth.Hash(ck.Value)), store.Null("revoked_at"))
	if err != nil {
		return err
	}
	if !there || sess.ExpiresAt < now {
		return errUnauthorized("your session has ended; sign in again")
	}
	if err := x.sessionMayAct(sess); err != nil {
		return err
	}
	if err := s.loadAccount(ctx, x, sess.UserID, "this account is disabled"); err != nil {
		return err
	}
	x.sess = &sess
	if now-sess.LastSeenAt > signInWriteEvery {
		_, _ = s.st.Update(ctx, "sessions", map[string]any{"last_seen_at": now}, store.Eq("id", sess.ID)) // best effort: last seen is shown to people, and written again on the next call
	}
	if ctx.Value(inProcess{}) != nil {
		return nil
	}
	return s.limits.check("u:"+x.user.ID, limitPerSignedIn)
}

// sessionMayAct refuses what a session may not do with this request: a
// session made for taking pictures may only read, and one that owes its
// second step gets only as far as firstStepPassed routes. (A write another
// site's page sent with the cookie never gets here: refuseOtherPages.)
func (x *c) sessionMayAct(sess core.Session) error {
	switch {
	case sess.Stage == core.SessionRender:
		// A session made to take a picture of a page: it may only look.
		if x.r.Method != http.MethodGet && x.r.Method != http.MethodHead {
			return errForbidden("this session is read-only")
		}
	case sess.Stage != core.SessionFull && !x.firstStepEnough:
		return &httpError{Status: 401, Code: "second_step", Message: "finish signing in with your second step"}
	}
	return nil
}

// loadAccount loads the signed-in account into x.user, refusing with
// disabledMsg when it is disabled or gone.
func (s *Server) loadAccount(ctx context.Context, x *c, userID, disabledMsg string) error {
	there, err := store.Find(ctx, s.st, &x.user, store.Eq("id", userID), store.Live)
	if err != nil {
		return err
	}
	if !there || x.user.DisabledAt != 0 {
		return errUnauthorized(disabledMsg)
	}
	return nil
}

// enterWorkspace binds the request to a workspace the caller belongs to. "-" means
// the workspace of the token used. It fills in the viewer (x.ws, x.db,
// x.member, x.projects) and x.actor, and records the member's presence.
func (s *Server) enterWorkspace(ctx context.Context, x *c, ref string) error {
	cond := store.Eq("slug", ref)
	if ref == "-" {
		if x.token == nil {
			return errBad("name the workspace in the path; \"-\" works only with a token")
		}
		cond = store.Eq("id", x.token.WorkspaceID)
	}
	var ws core.Workspace
	there, err := store.Find(ctx, s.st, &ws, cond, store.Live)
	if err != nil {
		return err
	}
	if !there {
		return errNotFound("workspace " + ref)
	}
	return s.enter(ctx, x, ws)
}

// enter makes the request one of the caller as a member of ws: it loads
// the membership (a workspace the caller is not a member of is not found,
// as if it did not exist), holds the request to its credential (the
// workspace a token or a picture's session is for, and how its scopes
// narrow the account: x.actor, and the viewer's projects) and to the
// install's two-step rule, and records the member's presence.
func (s *Server) enter(ctx context.Context, x *c, ws core.Workspace) error {
	workspaceID, scopes := x.credential()
	if workspaceID != "" && workspaceID != ws.ID {
		return errForbidden("this credential belongs to another workspace")
	}
	var member core.Member
	there, err := store.Find(ctx, s.st.In(ws.ID), &member, store.Eq("user_id", x.user.ID), store.Null("removed_at"))
	if err != nil {
		return err
	}
	if !there {
		return errNotFound("workspace " + ws.Slug) // not a member: it does not exist for them
	}
	if member.SuspendedAt != 0 {
		return errForbidden("your membership in this workspace is suspended")
	}
	x.viewer = *s.viewerFor(ws, member)
	if x.sess != nil && s.settings.Bool(ctx, "auth.require_2fa", false) && x.user.TOTPAt == 0 {
		// Fails closed: when the passkeys cannot be counted, the answer is no.
		if n, err := s.st.Count(ctx, "passkeys", store.Eq("user_id", x.user.ID)); err != nil || n == 0 {
			return &httpError{Status: 403, Code: "second_step_required", Message: "this install requires two-step verification: set it up in your profile first"}
		}
	}
	// The credential narrows the account: "read" makes the actor
	// read-only, and "project:ID" limits the actor to those projects, and
	// what the caller may read to those of them the membership allows.
	x.actor = engine.Actor{UserID: x.user.ID, ReadOnly: slices.Contains(strings.Fields(scopes), "read"), Projects: scopeProjects(scopes)}
	x.limitTo(x.actor.Projects)
	s.touchPresence(ctx, x, "")
	return nil
}

// credential is what the caller signed in with says of its reach: the
// workspace it is for ("" for any) and its scopes, written as a token's
// are ("read", "project:ID"; "" narrows nothing). A token says it, and so
// does a session made to take a picture, which carries the reach of the
// request that asked for the picture; a person's own session says nothing.
func (x *c) credential() (workspaceID, scopes string) {
	switch {
	case x.token != nil:
		return x.token.WorkspaceID, x.token.Scopes
	case x.sess != nil:
		return x.sess.WorkspaceID, x.sess.Scopes
	}
	return "", ""
}

// scopeProjects are the ids of the projects scopes are limited to; none
// means every project the member may use.
func scopeProjects(scopes string) []string {
	var projects []string
	for scope := range strings.FieldsSeq(scopes) {
		if projectID, ok := strings.CutPrefix(scope, "project:"); ok {
			projects = append(projects, projectID)
		}
	}
	return projects
}

// has reports whether list holds v.
func has(list []string, v string) bool {
	return slices.Contains(list, v)
}

// touchPresence records that a member was just here, at most every 20
// seconds, and what it did when that is worth showing. The write is
// detached from the request's end: the member was here either way.
func (s *Server) touchPresence(ctx context.Context, x *c, action string) {
	now := time.Now().UnixMilli()
	s.seenMu.Lock()
	last := s.seen[x.member.UserID+x.ws.ID]
	fresh := now-last > presenceEvery || action != ""
	if fresh {
		s.seen[x.member.UserID+x.ws.ID] = now
	}
	s.seenMu.Unlock()
	if !fresh {
		return
	}
	set := map[string]any{"last_seen_at": now}
	if action != "" {
		set["last_action"] = action
	}
	_, _ = x.db.Update(context.WithoutCancel(ctx), "members", set, store.Eq("user_id", x.member.UserID)) // best effort: presence is written again on the next request
}

// clientIP is the caller's address, for its sign-in limits and the
// record: who connected, or, when that is one of cfg.TrustedProxies, whom
// the proxy says it forwards for. X-Forwarded-For lists the hops, each
// proxy adding the address it saw at the end, so it is read from the end:
// the first address no trusted proxy has is the caller's, and what comes
// before it is whatever the caller wrote there itself.
func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if !s.isTrustedProxy(host) {
		return host
	}
	var hops []string
	for _, header := range r.Header.Values("X-Forwarded-For") {
		for hop := range strings.SplitSeq(header, ",") {
			hops = append(hops, strings.TrimSpace(hop))
		}
	}
	for _, hop := range slices.Backward(hops) {
		if !s.isTrustedProxy(hop) {
			if _, err := netip.ParseAddr(hop); err != nil {
				return host // the proxy wrote what is not an address: it is all that is known
			}
			return hop
		}
	}
	if len(hops) > 0 {
		return hops[0] // every hop a proxy of ours: the first is the caller, on the inside
	}
	return host
}

// isTrustedProxy reports whether an address is one of cfg.TrustedProxies.
func (s *Server) isTrustedProxy(address string) bool {
	addr, err := netip.ParseAddr(address)
	if err != nil {
		return false
	}
	addr = addr.WithZone("").Unmap()
	for _, p := range s.cfg.TrustedProxies {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// audit writes one line in the audit log. Failures are logged, not returned:
// the action already happened. For the same reason the line is written even
// when the caller has gone away: it is detached from the request's end.
func (s *Server) audit(r *http.Request, workspaceID string, actor core.User, action, targetType, targetID string, data any) {
	e := core.AuditEntry{ID: id.New(), At: time.Now().UnixMilli(), WorkspaceID: workspaceID, ActorID: actor.ID, ActorName: actor.Name,
		Action: action, TargetType: targetType, TargetID: targetID}
	if r != nil {
		e.IP, e.UserAgent = s.clientIP(r), r.UserAgent()
		if len(e.UserAgent) > 200 {
			e.UserAgent = e.UserAgent[:200]
		}
	}
	if data != nil {
		e.Data = plainjson.Marshal(data)
	}
	ctx := context.Background() //nolint:contextcheck // detached: no request, work the server does on its own
	if r != nil {
		ctx = context.WithoutCancel(r.Context())
	}
	if err := s.st.Insert(ctx, e); err != nil {
		s.log.Error("audit log", "action", action, "err", err)
	}
}

// Handler returns the server's HTTP handler. Around every request it
// compresses the answer when it can, sets the security headers, refuses a
// write a browser sent from another site's page (refuseOtherPages), turns
// a panic into a 500, and counts the request for /metrics. The API, files,
// MCP, OAuth, hooks and monitoring go to the routes; any other path is the
// web app's, or not found when it is not built in.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		w, done := compressed(w, r)
		defer done()
		rec := &recorder{ResponseWriter: w, status: 200}
		defer func() {
			if p := recover(); p != nil {
				s.log.Error("panic", "path", r.URL.Path, "panic", p, "stack", string(debug.Stack()))
				if !rec.wrote {
					s.fail(rec, r, errors.New("panic"))
				}
			}
			s.stats.observe(r, rec.status, time.Since(start))
		}()
		h := rec.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		if r.TLS != nil || (strings.HasPrefix(s.cfg.BaseURL, "https://") && r.Header.Get("X-Forwarded-Proto") == "https") {
			// Once reached over HTTPS, a browser keeps to it.
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if err := s.refuseOtherPages(r); err != nil {
			s.fail(rec, r, err)
			return
		}
		if servedByMux(r.URL.Path) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				h.Set("Cache-Control", "no-store")
			}
			s.mux.ServeHTTP(rec, r)
			return
		}
		if s.web != nil {
			s.web.ServeHTTP(rec, r)
			return
		}
		http.NotFound(rec, r)
	})
}

// servedByMux reports whether a path is one of the server's routes rather
// than a page of the web app.
func servedByMux(path string) bool {
	for _, prefix := range []string{"/api/", "/f/", "/mcp", "/.well-known/", "/oauth/", "/hooks/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return path == "/healthz" || path == "/readyz" || path == "/metrics" || path == "/licenses"
}

// recorder notes the status of an answer, for the metrics, and whether
// anything was written yet, so a panic is answered only when nothing was.
type recorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (r *recorder) WriteHeader(code int) {
	r.status, r.wrote = code, true
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wrote = true
	return r.ResponseWriter.Write(b)
}

func (r *recorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
