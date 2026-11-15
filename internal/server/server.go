// Package server is the HTTP API. The web app, the command-line tool, the
// MCP server and agents all use it; nothing reaches the data another way.
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
	"reflect"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/hub"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Config is what a server needs from its surroundings.
type Config struct {
	DataDir string // uploads in progress, the install secret, local files
	BaseURL string // where people reach the server, e.g. https://quadit.example.com
	// LocalURL is where the server reaches itself, for taking pictures of
	// its own pages. Empty means BaseURL.
	LocalURL string
	Version  string
	Log      *slog.Logger
}

// Server holds everything a request needs.
type Server struct {
	cfg     Config
	st      store.Store
	eng     *engine.Engine
	hub     *hub.Hub
	filesMu sync.RWMutex
	files   blob.Store // where files go now
	disk    blob.Store // the local store, always there
	sealer  *auth.Sealer
	log     *slog.Logger
	mux     *http.ServeMux
	web     http.Handler // the web app, when built in

	seenMu sync.Mutex
	seen   map[string]int64 // user id -> last time presence was written
	setMu  sync.Mutex
	setTTL map[string]cachedSetting
	limits *limiter
	// quit is closed when the server is told to stop: held connections
	// (live streams, waits for the next event) end then, at once.
	quit     chan struct{}
	quitOnce sync.Once
	stats    stats
}

// New wires a server. Call Handler to serve it and Run for background work.
// Stop ends the connections the server holds open for its callers, so a
// shutdown does not wait out their timeouts. Requests in progress finish.
func (s *Server) Stop() { s.quitOnce.Do(func() { close(s.quit) }) }

// held returns a context for a connection that is kept open: it ends with
// the request, and when the server stops.
func (s *Server) held(parent context.Context) (context.Context, context.CancelFunc) {
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

func New(cfg Config, st store.Store, files blob.Store, sealer *auth.Sealer) *Server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	s := &Server{cfg: cfg, st: st, eng: engine.New(st), hub: hub.New(), files: files, disk: files, sealer: sealer, log: cfg.Log,
		seen: map[string]int64{}, limits: newLimiter(), quit: make(chan struct{})}
	s.eng.OnCommit = s.hub.Notify
	engine.Seal = sealer.Seal
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
		cloud.Delete(ctx, probe)
		next = blob.Layered{Primary: cloud, Old: s.disk}
		s.enqueue(ctx, "files.move", "", "files.move", nil, time.Now().Add(5*time.Second))
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

// httpError is a refusal made by the API itself rather than the engine.
type httpError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter int
}

func (e *httpError) Error() string { return e.Code + ": " + e.Message }

func errUnauthorized(msg string) error {
	return &httpError{Status: 401, Code: "unauthorized", Message: msg}
}

func errBad(format string, a ...any) error {
	return &engine.Error{Code: engine.CodeInvalid, Message: fmt.Sprintf(format, a...)}
}

func errForbidden(format string, a ...any) error {
	return &engine.Error{Code: engine.CodeForbidden, Message: fmt.Sprintf(format, a...)}
}

func errNotFound(what string) error {
	return &engine.Error{Code: engine.CodeNotFound, Message: what + " not found"}
}

var statusOf = map[string]int{
	engine.CodeInvalid: 400, engine.CodeForbidden: 403, engine.CodeNotFound: 404, engine.CodeConflict: 409,
	engine.CodeStale: 409, engine.CodeNeedsApproval: 403, engine.CodeBudget: 403,
}

// c is one request with who is asking.
type c struct {
	narrowed bool // fields= and since= were applied by the handler
	// staleView says what a saved view filters by that is gone, when the
	// list was read without that part.
	staleView string
	s         *Server
	w         http.ResponseWriter
	r         *http.Request
	user      core.User
	sess      *core.Session
	token     *core.APIToken
	ws        core.Workspace
	member    core.Member
	actor     engine.Actor
	// projects, when not nil, are the only projects this caller may read.
	projects []string
	db       store.DB // bound to the workspace
	nm       *names
	// halfOK lets a session that still owes its second step through.
	halfOK bool
}

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

// ok answers with v. Every read that answers with a list takes fields=a,b
// to get only those fields of each row (and its id), and since=N to get
// only the rows that changed after that position in the feed, so a caller
// never pays for what it already knows.
func (x *c) ok(v any) error {
	q := x.r.URL.Query()
	fields, since := splitList(q.Get("fields")), q.Get("since")
	if x.r.Method != http.MethodGet || (len(fields) == 0 && since == "") || x.narrowed {
		return x.json(200, v)
	}
	raw, err := json.Marshal(noNulls(v))
	if err != nil {
		return x.json(200, v)
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return x.json(200, v)
	}
	after, _ := strconv.ParseInt(since, 10, 64)
	keep := map[string]bool{"id": true, "key": true}
	for _, f := range fields {
		keep[f] = true
	}
	for name, val := range doc {
		rows, ok := val.([]any)
		if !ok {
			continue
		}
		out := make([]any, 0, len(rows))
		for _, r := range rows {
			row, ok := r.(map[string]any)
			if !ok {
				out = append(out, r)
				continue
			}
			if since != "" {
				// A row's place in the feed: when it last changed, or when it was made.
				at, has := row["updated_seq"].(float64)
				if !has {
					at, has = row["seq"].(float64)
				}
				if has && int64(at) <= after {
					continue
				}
			}
			if len(fields) > 0 {
				for k := range row {
					if !keep[k] {
						delete(row, k)
					}
				}
			}
			out = append(out, row)
		}
		doc[name] = out
	}
	return x.json(200, doc)
}

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

// body decodes a JSON request body, refusing unknown fields.
func (x *c) body(v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(x.w, x.r.Body, 16<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBad("request body: %s", engine.PlainJSON(err))
	}
	return nil
}

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

// whole reports whether the caller acts with everything the account may
// do: a signed-in session, or a token with no narrowing on it.
func (x *c) whole() bool {
	if x.sess != nil {
		return x.sess.Stage == "full"
	}
	return x.token != nil && x.token.Kind == "token" && x.token.Scopes == ""
}

func (x *c) admin() error {
	if !x.member.Role.AtLeast(core.RoleAdmin) {
		return errForbidden("this needs the admin role; you are a %s", x.member.Role)
	}
	return nil
}

// fail writes an error in the one shape every error has.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var he *httpError
	var ee *engine.Error
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

type handler func(*c) error

// open wraps a handler that needs no sign-in.
func (s *Server) open(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r}
		// Calls that need no sign-in are counted by where they come from.
		if err := s.limits.check("ip:"+clientIP(r), 600); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := h(x); err != nil {
			s.fail(w, r, err)
		}
	}
}

// signed wraps a handler that needs a signed-in person or a token, but no
// workspace.
func (s *Server) signed(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r}
		if err := s.identify(x); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := h(x); err != nil {
			s.fail(w, r, err)
		}
	}
}

// half wraps a handler for someone who has passed the first sign-in step
// and may still owe the second.
func (s *Server) half(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r, halfOK: true}
		if err := s.identify(x); err != nil {
			s.fail(w, r, err)
			return
		}
		if err := h(x); err != nil {
			s.fail(w, r, err)
		}
	}
}

// in wraps a handler that works inside the workspace named in the path.
func (s *Server) in(h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		x := &c{s: s, w: w, r: r}
		err := s.identify(x)
		if err == nil {
			err = s.enter(x, r.PathValue("ws"))
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
// session cookie.
func (s *Server) identify(x *c) error {
	ctx := x.ctx()
	now := time.Now().UnixMilli()
	if h := x.r.Header.Get("Authorization"); h != "" {
		tok := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		var t core.APIToken
		if err := s.st.Get(ctx, &t, store.Eq("token_hash", auth.Hash(tok)), store.Null("revoked_at")); err != nil {
			// Guesses are counted by where they come from.
			if lerr := s.limits.check("bad:"+clientIP(x.r), 120); lerr != nil && x.r.RemoteAddr != "127.0.0.1:0" {
				return lerr
			}
			return errUnauthorized("this token is not valid, or was revoked")
		}
		if t.ExpiresAt != 0 && t.ExpiresAt < now {
			return errUnauthorized("this token has expired")
		}
		if err := s.st.Get(ctx, &x.user, store.Eq("id", t.UserID), store.Live); err != nil || x.user.DisabledAt != 0 {
			return errUnauthorized("this token's account is disabled")
		}
		x.token = &t
		if now-t.LastUsedAt > 24*3600_000 {
			// A token's use is on the record: its first, and then once for
			// each day it is used.
			s.audit(x.r, t.WorkspaceID, x.user, "token.used", "token", t.ID, map[string]string{"name": t.Name})
		}
		if now-t.LastUsedAt > 60_000 {
			s.st.Update(ctx, "api_tokens", map[string]any{"last_used_at": now}, store.Eq("id", t.ID))
		}
		if x.r.Context().Value(inProcess{}) != nil {
			return nil // the server working for the caller, inside one request already counted
		}
		return s.limits.check("t:"+t.ID, 1200)
	}
	ck, err := x.r.Cookie(sessionCookie)
	if err != nil || ck.Value == "" {
		return errUnauthorized("sign in, or send a token in the Authorization header")
	}
	var sess core.Session
	if err := s.st.Get(ctx, &sess, store.Eq("token_hash", auth.Hash(ck.Value)), store.Null("revoked_at")); err != nil || sess.ExpiresAt < now {
		return errUnauthorized("your session has ended; sign in again")
	}
	switch {
	case sess.Stage == "render":
		// A session made to take a picture of a page: it may only look.
		if x.r.Method != http.MethodGet && x.r.Method != http.MethodHead {
			return errForbidden("this session is read-only")
		}
	case sess.Stage != "full" && !x.halfOK:
		return &httpError{Status: 401, Code: "second_step", Message: "finish signing in with your second step"}
	}
	// A cookie rides along on requests other sites make; refuse those.
	if x.r.Method != http.MethodGet && x.r.Method != http.MethodHead {
		if site := x.r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
			return errForbidden("cross-site requests are not accepted")
		}
	}
	if err := s.st.Get(ctx, &x.user, store.Eq("id", sess.UserID), store.Live); err != nil || x.user.DisabledAt != 0 {
		return errUnauthorized("this account is disabled")
	}
	x.sess = &sess
	if now-sess.LastSeenAt > 60_000 {
		s.st.Update(ctx, "sessions", map[string]any{"last_seen_at": now}, store.Eq("id", sess.ID))
	}
	if x.r.Context().Value(inProcess{}) != nil {
		return nil
	}
	return s.limits.check("u:"+x.user.ID, 3000)
}

// enter binds the request to a workspace the caller belongs to. "-" means
// the workspace of the token used.
func (s *Server) enter(x *c, ref string) error {
	ctx := x.ctx()
	cond := store.Eq("slug", ref)
	if ref == "-" {
		if x.token == nil {
			return errBad("name the workspace in the path; \"-\" works only with a token")
		}
		cond = store.Eq("id", x.token.WorkspaceID)
	}
	if err := s.st.Get(ctx, &x.ws, cond, store.Live); err != nil {
		return errNotFound("workspace " + ref)
	}
	if x.token != nil && x.token.WorkspaceID != x.ws.ID {
		return errForbidden("this token belongs to another workspace")
	}
	x.db = s.st.In(x.ws.ID)
	if err := x.db.Get(ctx, &x.member, store.Eq("user_id", x.user.ID), store.Null("removed_at")); err != nil {
		return errNotFound("workspace " + ref) // not a member: it does not exist for them
	}
	if x.member.SuspendedAt != 0 {
		return errForbidden("your membership in this workspace is suspended")
	}
	if x.sess != nil && s.settingBool(ctx, "auth.require_2fa", false) && x.user.TOTPAt == 0 {
		if n, _ := s.st.Count(ctx, "passkeys", store.Eq("user_id", x.user.ID)); n == 0 {
			return &httpError{Status: 403, Code: "second_step_required", Message: "this install requires two-step verification: set it up in your profile first"}
		}
	}
	x.actor = engine.Actor{UserID: x.user.ID}
	if x.member.Scope != nil {
		x.projects = x.member.Scope.Projects
	}
	if x.token != nil {
		for _, sc := range strings.Fields(x.token.Scopes) {
			switch {
			case sc == "read":
				x.actor.ReadOnly = true
			case strings.HasPrefix(sc, "project:"):
				x.actor.Projects = append(x.actor.Projects, strings.TrimPrefix(sc, "project:"))
			}
		}
		if len(x.actor.Projects) > 0 {
			if x.projects == nil {
				x.projects = x.actor.Projects
			} else {
				var both []string
				for _, p := range x.actor.Projects {
					if has(x.projects, p) {
						both = append(both, p)
					}
				}
				if both == nil {
					both = []string{"none"}
				}
				x.projects = both
			}
		}
	}
	s.touchPresence(x, "")
	return nil
}

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// canProject reports whether the caller may read a project.
func (x *c) canProject(projectID string) bool {
	return x.projects == nil || projectID == "" || has(x.projects, projectID)
}

// touchPresence records that a member was just here, at most every 20
// seconds, and what it did when that is worth showing.
func (s *Server) touchPresence(x *c, action string) {
	now := time.Now().UnixMilli()
	s.seenMu.Lock()
	last := s.seen[x.member.UserID+x.ws.ID]
	fresh := now-last > 20_000 || action != ""
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
	x.db.Update(context.WithoutCancel(x.ctx()), "members", set, store.Eq("user_id", x.member.UserID))
}

// clientIP returns the caller's address, trusting a proxy's header only
// when the connection comes from this machine or a private network.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate()) {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			return strings.TrimSpace(strings.Split(fwd, ",")[0])
		}
	}
	return host
}

// audit writes one line in the audit log. Failures are logged, not returned:
// the action already happened.
func (s *Server) audit(r *http.Request, workspaceID string, actor core.User, action, targetType, targetID string, data any) {
	e := core.AuditEntry{ID: id.New(), At: time.Now().UnixMilli(), WorkspaceID: workspaceID, ActorID: actor.ID, ActorName: actor.Name,
		Action: action, TargetType: targetType, TargetID: targetID}
	if r != nil {
		e.IP, e.UserAgent = clientIP(r), r.UserAgent()
		if len(e.UserAgent) > 200 {
			e.UserAgent = e.UserAgent[:200]
		}
	}
	if data != nil {
		e.Data, _ = json.Marshal(data)
	}
	if err := s.st.Insert(context.Background(), e); err != nil {
		s.log.Error("audit log", "action", action, "err", err)
	}
}

// Handler returns the server's HTTP handler.
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
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/f/") || strings.HasPrefix(r.URL.Path, "/mcp") ||
			strings.HasPrefix(r.URL.Path, "/.well-known/") || strings.HasPrefix(r.URL.Path, "/oauth/") ||
			r.URL.Path == "/healthz" || r.URL.Path == "/readyz" || r.URL.Path == "/metrics" || strings.HasPrefix(r.URL.Path, "/hooks/") {
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

// limiter is a fixed-window request counter per caller. It lives in memory:
// one server is one limit, and several servers each allow their own share.
type limiter struct {
	mu     sync.Mutex
	window int64
	// hits are the requests counted here since the last time they were
	// added to the database; shared are the totals read back from it, which
	// include every server's.
	hits   map[string]int
	shared map[string]int
	// PerMinute scales every limit; the admin area sets it.
	factor float64
}

func newLimiter() *limiter {
	return &limiter{hits: map[string]int{}, shared: map[string]int{}, factor: 1}
}

// share adds what was counted here to the database's counters and takes
// the totals back.
func (l *limiter) share(ctx context.Context, st store.Store) {
	l.mu.Lock()
	window, mine := l.window, l.hits
	l.hits = map[string]int{}
	l.mu.Unlock()
	totals := map[string]int{}
	for key, n := range mine {
		name := "api:" + key
		total, err := st.Incr(ctx, "rate_counters", "hits", int64(n), store.Eq("name", name), store.Eq("bucket", window))
		if errors.Is(err, store.ErrNotFound) {
			if err = st.Insert(ctx, core.RateCounter{Name: name, Bucket: window, Hits: n}); err == nil {
				total = int64(n)
			} else if errors.Is(err, store.ErrConflict) {
				total, err = st.Incr(ctx, "rate_counters", "hits", int64(n), store.Eq("name", name), store.Eq("bucket", window))
			}
		}
		if err != nil {
			total = int64(n) // the database is unwell: count what is known here
		}
		totals[key] = int(total)
	}
	if len(mine) > 0 {
		st.Delete(ctx, "rate_counters", store.Like("name", "api:%"), store.Lt("bucket", window-1))
	}
	// And what the other servers counted this minute, for every caller: a
	// caller this server has not seen lately may be busy on another.
	var rows []core.RateCounter
	if err := st.List(ctx, &rows, store.Q{Where: []store.Cond{store.Like("name", "api:%"), store.Eq("bucket", window)}, Limit: 5000}); err == nil {
		for _, r := range rows {
			key := strings.TrimPrefix(r.Name, "api:")
			if _, flushed := totals[key]; !flushed {
				totals[key] = r.Hits
			}
		}
	}
	l.mu.Lock()
	if l.window == window {
		for key, total := range totals {
			l.shared[key] = total
		}
	}
	l.mu.Unlock()
}

// check counts one request and refuses it when the caller is over max per
// minute, saying how long to wait.
func (l *limiter) check(key string, max int) error {
	now := time.Now().Unix()
	l.mu.Lock()
	defer l.mu.Unlock()
	if w := now / 60; w != l.window {
		l.window, l.hits, l.shared = w, map[string]int{}, map[string]int{}
	}
	l.hits[key]++
	if float64(l.hits[key]+l.shared[key]) > float64(max)*l.factor {
		wait := int(60 - now%60)
		return &httpError{Status: 429, Code: "rate_limited", RetryAfter: wait,
			Message: fmt.Sprintf("too many requests; try again in %d seconds", wait)}
	}
	return nil
}

// stats counts requests for the metrics endpoint.
type stats struct {
	mu       sync.Mutex
	requests map[string]int64 // "METHOD class"
	seconds  float64
	started  time.Time
}

func (s *stats) observe(r *http.Request, status int, d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.requests == nil {
		s.requests, s.started = map[string]int64{}, time.Now()
	}
	s.requests[fmt.Sprintf("%s %dxx", r.Method, status/100)]++
	s.seconds += d.Seconds()
}
