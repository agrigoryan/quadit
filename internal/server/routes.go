package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// The server's routes: what each is, the one list of them all, the core
// routes, and /list/{collection}: one kind of row as stored (the kinds are
// in rowkinds.go).

// route is one address the server answers, with the words that describe
// it in openapi.json. The mux and the description are both made from the
// list of routes, so nothing is answered that is not described.
type route struct {
	// pattern is the method and the path, as http.ServeMux takes them.
	// {ws} is the workspace, described as {workspace}; a last {name...}
	// takes the rest of the path.
	pattern string
	// handler answers, wrapped in the check of who may call it: public,
	// signedIn, settingUpSecondStep, firstStepPassed, workspaceMember,
	// installAdmin; none for a route that checks its caller itself or
	// takes anyone.
	handler http.HandlerFunc
	summary string // what it does, for whoever calls it
	query   string // its query parameters: "name: what it does; name2: …"
	tag     string // the group it is listed under
}

// allRoutes is every route the server answers: the core routes below,
// then each feature's, declared beside its handlers.
func (s *Server) allRoutes() []route {
	return slices.Concat(
		s.coreRoutes(),
		s.authRoutes(),           // auth.go
		s.passkeyRoutes(),        // auth_passkeys.go
		s.providerSignInRoutes(), // auth_oauth.go
		s.adminRoutes(),          // admin.go
		s.backupRoutes(),         // backups.go
		s.pageRoutes(),           // docs.go
		s.sourceRoutes(),         // reposync.go
		s.dashboardRoutes(),      // dashboard.go
		s.pictureRoutes(),        // picture.go
		s.exportRoutes(),         // export.go
		s.importRoutes(),         // importing.go
		s.webhookRoutes(),        // dispatch.go
		s.githubRoutes(),         // github.go
		s.secretRoutes(),         // secrets.go
		s.pushRoutes(),           // push.go
		s.eventTypeRoutes(),      // eventtypes.go
		s.mcpRoutes(),            // mcp.go
		s.oauthServerRoutes(),    // oauth_server.go
		s.desktopRoutes(),        // desktop.go
		s.appKeyRoutes(),         // app_key.go
		s.openAPIRoutes(),        // openapi.go
	)
}

// routes makes the server's mux from allRoutes. Two routes with the same
// pattern panic here, when the server is made.
func (s *Server) routes() {
	m := http.NewServeMux()
	for _, rt := range s.allRoutes() {
		m.HandleFunc(rt.pattern, rt.handler)
	}
	s.mux = m
}

// taskFilters are the query parameters that narrow a list of tasks, and
// the feed to the events of matching tasks.
const taskFilters = "project: key; assignee: me, @handle or none; status: name or category; open: true; waiting_on: me or @handle; label: name; " +
	"epic: name or none; cycle: current, next, number or none; priority: 1-4; has_open_decision: true; asked: member; changed_since: feed position; " +
	"mentions: member; watching: true; q: text in the title; parent: task key; sort: created, -created, rank, priority, due, -activity, -updated, key; limit; offset"

// coreRoutes are monitoring, signing in and the account, and the core of a
// workspace: changes, the feed, finding tasks, tokens and files.
func (s *Server) coreRoutes() []route {
	const w = "/api/v1/w/{ws}"
	return []route{
		// Monitoring: no sign-in.
		{"GET /healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") }, "The process is up.", "", "monitoring"},
		{"GET /readyz", s.handleCheckReadiness, "The database and the file store answer.", "", "monitoring"},
		{"GET /metrics", s.handleShowMetrics, "Counters in the Prometheus text format.", "", "monitoring"},
		{"GET /licenses", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprint(w, quadit.License+"\n\n"+quadit.ThirdPartyNotices)
		}, "Quadit's license, then the licenses of the work of others it contains, as text.", "", "describe"},

		// Signing in and the account, outside any workspace.
		{"GET /api/v1/auth/config", s.public(s.handleShowSignInOptions), "What this install offers for signing in, and whether it has been set up.", "", "account"},
		{"POST /api/v1/auth/setup", s.public(s.handleSetUpInstall), "First run: make the first person and workspace, signed in. Body: {name, email, password, workspace_name}. On a server the desktop app runs (setup_by_app in the sign-in options) only that app may, with its key in X-Quadit-App-Key and the body {name, workspace_name}: the owner has no email and no password.", "", "account"},
		{"POST /api/v1/auth/login", s.public(s.handleSignIn), "Sign in with email and password. Body: {email, password}. Answers with a session cookie; with two-step on, the second step follows.", "", "account"},
		{"POST /api/v1/auth/logout", s.public(s.handleSignOut), "Sign out of this session.", "", "account"},
		{"GET /api/v1/auth/me", s.settingUpSecondStep(s.handleShowAccount), "The signed-in account and the workspaces it is in.", "", "account"},
		{"PATCH /api/v1/auth/me", s.signedIn(s.handleUpdateProfile), "Change the profile: {name, avatar, timezone, theme, locale}; {email, password} changes the sign-in address.", "", "account"},
		{"POST /api/v1/auth/password", s.signedIn(s.handleChangePassword), "Change the password. Body: {current, new}. Signed in only.", "", "account"},
		{"GET /api/v1/auth/sessions", s.signedIn(s.handleListSessions), "The devices signed in to this account.", "", "account"},
		{"DELETE /api/v1/auth/sessions/{id}", s.signedIn(s.handleRevokeSession), "Sign one device out.", "", "account"},
		{"POST /api/v1/workspaces", s.signedIn(s.handleCreateWorkspace), "Make a workspace. Body: {name, slug}.", "", "account"},
		{"GET /api/v1/changes", s.public(s.handleDescribeChangeTypes), "Every change type with its arguments and the least role it needs, and the surface version.", "format: text", "describe"},
		{"GET /api/v1/version", s.public(s.handleDescribeVersion), "What this server is, without signing in: {name: \"quadit\", version, surface, desktop: {handoff}}. The desktop app asks it before adding a server.", "", "describe"},

		// Inside a workspace: every write is a change; the rest are reads.
		{"POST " + w + "/changes", s.workspaceMember(s.handleApplyChanges), "Apply one change, or a batch that succeeds or fails together. Body: {id, type, args} or {changes: […], dry_run}. The id is made by the caller; sending the same id again applies nothing twice. Alone or in a batch, an admin may mark a change quiet: true (history being imported): it notifies nobody, and its events say quiet.", "events: true to get the events back; dry_run: true to check without writing", "write"},
		{"GET " + w + "/bootstrap", s.workspaceMember(s.handleBootstrapLocalCopy), "The whole workspace as rows, for a client that keeps a local copy and then follows the feed.", "", "sync"},
		// Orientation and the feed.
		{"GET " + w + "/me", s.workspaceMember(s.handleShowWhoAmI), "Who am I: role, projects, what needs approval, an agent's hand-off limit, unread count, feed position, cursors.", "", "orient"},
		{"GET " + w + "/my-work", s.workspaceMember(s.handleShowMyWork), "What waits on me, questions asked of me, tasks assigned to me, my unread inbox.", "", "orient"},
		{"GET " + w + "/events", s.workspaceMember(s.handleReadFeed), "The change feed after a position. wait holds the request until something matching arrives. Task filters narrow it to the events of matching tasks.", "after: feed position; cursor: name of a server-kept cursor; ack: move that cursor to this position first; wait: seconds, up to 55; mine: true; others: true; inbox: true; task: key; types: comma-separated; compact: true for one line per event; " + taskFilters, "follow"},
		{"GET " + w + "/events/stream", s.workspaceMember(s.handleStreamFeed), "The live stream (server-sent events), one message per feed event.", "after: feed position", "follow"},
		{"GET " + w + "/cursors/{name}", s.workspaceMember(s.handleShowFeedCursor), "Where a server-kept cursor stands.", "", "follow"},
		{"PUT " + w + "/cursors/{name}", s.workspaceMember(s.handleMoveFeedCursor), "Mark the feed handled up to a position. Body: {seq}. A cursor never moves back. dry_run=1 checks the position without moving it.", "", "follow"},
		// Finding tasks, decisions and rows.
		{"GET " + w + "/tasks", s.workspaceMember(s.handleListTasks), "Find tasks. All filters combine.", taskFilters + "; view: a saved view's slug or name; cursor: next_cursor from the last answer, to read on; count: true for the number only; fields: comma-separated; raw: true for stored rows", "find"},
		{"GET " + w + "/tasks/{ref}", s.workspaceMember(s.handleShowTask), "One task with decisions, comments, sub-tasks, relations, links and files.", "since: feed position, to get only what changed after it; full: true to not cut long text; max_chars; raw: true", "find"},
		{"GET " + w + "/tasks/{ref}/context", s.workspaceMember(s.handleShowTaskContext), "The context pack: the task, its parents, epic, standing preferences, recent decisions, linked docs.", "full: true", "find"},
		{"GET " + w + "/inbox", s.workspaceMember(s.handleListInbox), "The caller's inbox.", "all: true to include read items; limit", "find"},
		{"GET " + w + "/search", s.workspaceMember(s.handleSearch), "Full-text search across tasks, decisions, comments and docs.", "q: text; kind: task, comment, decision, doc; limit", "find"},
		{"GET " + w + "/decisions", s.workspaceMember(s.handleListDecisions), "The decision log.", "state: answered, open, picked, sent_back, all; project; q; asked; trash: true for deleted ones; limit; offset", "find"},
		{"GET " + w + "/projects/{key}/layout", s.workspaceMember(s.handleShowProjectLayout), "A project's statuses, labels, members, epics, cycles and templates, by name.", "", "orient"},
		{"GET " + w + "/list/{collection}", s.workspaceMember(s.handleListCollection), "Rows of one kind as stored: members, projects, statuses, labels, epics, milestones, cycles, views, templates, preferences, resources, secrets, claims, sessions, relations, attachments, links, webhooks, deliveries, rules, integrations.", "project; task; trash: true; limit; offset", "sync"},
		// Tokens and files.
		{"GET " + w + "/tokens", s.workspaceMember(s.handleListTokens), "API tokens one may revoke: one's own, those one made for an agent one answers for; all of them for admins.", "", "admin"},
		{"POST " + w + "/tokens", s.workspaceMember(s.handleCreateToken), "Issue a token: {user, name, read_only, projects, expires_days}. The token is in the answer once.", "", "admin"},
		{"DELETE " + w + "/tokens/{id}", s.workspaceMember(s.handleRevokeToken), "Revoke a token at once: one listed for the caller.", "", "admin"},
		{"POST " + w + "/files", s.workspaceMember(s.handleUploadFile), "Upload a file: the body is the file, or a multipart form with a file field. With size= a large file continues with PATCH.", "name: file name; size: full size in bytes, for an upload in parts; id: a UUID of the caller's making, so that asking again goes on from where the upload stopped (needs size); sha256: the file's checksum in hex, checked before it is ready", "files"},
		{"PATCH " + w + "/files/{id}", s.workspaceMember(s.handleUploadFilePart), "Send the next part of an upload. An upload whose bytes all came but could not be stored is finished by sending nothing at its end.", "offset: bytes already received", "files"},
		{"GET " + w + "/files/{id}", s.workspaceMember(s.handleShowFile), "A file's details and addresses.", "", "files"},
		{"GET /f/{id}/{name...}", s.signedIn(s.handleServeFile), "A file's bytes. The name is for the reader; the id decides. /f/{id}/preview is its small preview. Takes a session or a token, and byte ranges.", "", "files"},
	}
}

// handleCheckReadiness answers "ready" when the database answers within
// three seconds.
func (s *Server) handleCheckReadiness(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.st.Ping(ctx); err != nil {
		http.Error(w, "database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if err := s.fileStore().Check(ctx); err != nil {
		http.Error(w, "file store: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	fmt.Fprintln(w, "ready")
}

// handleShowMetrics writes counters in the Prometheus text format.
func (s *Server) handleShowMetrics(w http.ResponseWriter, r *http.Request) {
	// The token decides access: when it cannot be read, nobody is let in.
	var tok string
	if err := s.settings.Checked(r.Context(), "metrics.token", &tok); err != nil {
		s.log.Error("metrics: the token cannot be read, so the page is not shown", "err", err)
		http.Error(w, "the metrics token cannot be read", http.StatusInternalServerError)
		return
	}
	if tok != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+tok)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	s.stats.mu.Lock()
	keys := make([]string, 0, len(s.stats.requests))
	for k := range s.stats.requests {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprintln(w, "# TYPE quadit_http_requests_total counter")
	for _, k := range keys {
		method, class, _ := strings.Cut(k, " ")
		fmt.Fprintf(w, "quadit_http_requests_total{method=%q,status=%q} %d\n", method, class, s.stats.requests[k])
	}
	fmt.Fprintf(w, "# TYPE quadit_http_request_seconds_total counter\nquadit_http_request_seconds_total %.3f\n", s.stats.seconds)
	if !s.stats.started.IsZero() {
		fmt.Fprintf(w, "# TYPE quadit_uptime_seconds gauge\nquadit_uptime_seconds %.0f\n", time.Since(s.stats.started).Seconds())
	}
	s.stats.mu.Unlock()
	ctx := r.Context()
	fmt.Fprintf(w, "# TYPE quadit_rows gauge\n")
	for _, t := range []string{"workspaces", "users", "tasks", "events", "docs", "files"} {
		if n, err := s.st.Count(ctx, t); err == nil {
			fmt.Fprintf(w, "quadit_rows{table=%q} %d\n", t, n)
		}
	}
	if n, err := s.st.Count(ctx, "jobs", store.Null("done_at")); err == nil {
		fmt.Fprintf(w, "# TYPE quadit_jobs_waiting gauge\nquadit_jobs_waiting %d\n", n)
	}
	fmt.Fprintf(w, "# TYPE quadit_webhook_deliveries_dead gauge\nquadit_webhook_deliveries_dead %d\n", liveDeliveries(ctx, s.st, store.Eq("state", core.DeliveryDead)))
	fmt.Fprintf(w, "# TYPE quadit_info gauge\nquadit_info{version=%q,database=%q,files=%q} 1\n", s.cfg.Version, s.st.Dialect(), s.fileStore().Kind())
}

// handleDescribeChangeTypes lists every change type with its arguments.
func (s *Server) handleDescribeChangeTypes(x *c) error {
	cat := engine.Catalog()
	if x.wantText() {
		var b strings.Builder
		for _, ci := range cat {
			var args []string
			for _, a := range ci.Args {
				if a.Required {
					args = append(args, a.Name+" (required)")
				} else {
					args = append(args, a.Name)
				}
			}
			fmt.Fprintf(&b, "%s (%s): %s\n", ci.Type, ci.Role, strings.Join(args, ", "))
		}
		fmt.Fprintf(&b, "surface: %s (within %s.x nothing is removed or renamed)\n", engine.Surface, strings.Split(engine.Surface, ".")[0])
		return x.text(b.String())
	}
	return x.ok(map[string]any{"changes": cat, "surface": engine.Surface})
}

// handleDescribeVersion says that this is a Quadit server, which version of
// it, the agent surface it keeps, and the version of the desktop app's
// sign-in hand-off (desktop.go) it speaks.
func (s *Server) handleDescribeVersion(x *c) error {
	return x.ok(map[string]any{"name": "quadit", "version": s.cfg.Version, "surface": engine.Surface,
		"desktop": map[string]any{"handoff": desktopHandoff}})
}

// narrowingParams are the URL parameters a list is narrowed by, and the
// field of the row each one matches.
var narrowingParams = map[string]string{"project": "ProjectID", "task": "TaskID", "epic": "EpicID", "database": "DatabaseID", "doc": "DocID", "webhook": "WebhookID", "agent": "AgentID"}

// listQuery reads from the request which rows of a kind /list is asked
// for. The URL narrows the list by the columns most kinds have (project=,
// task=, epic=, …; one counts when the kind has its column, and a project or
// a task may be named by its key), trash=1 lists the deleted rows instead of
// the live ones, and limit= and offset= page it (at most 5000 rows).
func (x *c) listQuery(kind rowKind) (store.Q, error) {
	where := append([]store.Cond(nil), kind.list.conds...)
	v := x.r.URL.Query()
	for param, field := range narrowingParams {
		val := v.Get(param)
		f, ok := kind.row.FieldByName(field)
		if val == "" || !ok {
			continue
		}
		col, _, _ := strings.Cut(f.Tag.Get("db"), ",")
		id, err := x.narrowingID(x.ctx(), param, val)
		if err != nil {
			return store.Q{}, err
		}
		where = append(where, store.Eq(col, id))
	}
	if _, ok := kind.row.FieldByName("DeletedAt"); ok {
		if truthyParam(v, "trash") {
			where = append(where, store.NotNull("deleted_at"))
		} else {
			where = append(where, store.Live)
		}
	}
	return store.Q{Where: where, Order: kind.list.order, Limit: min(x.intParam("limit", 1000), 5000), Offset: x.intParam("offset", 0)}, nil
}

// narrowingID is the id a narrowing parameter's value names: a project or
// a task is found by its key or id, any other value is an id already.
func (who *viewer) narrowingID(ctx context.Context, param, val string) (string, error) {
	switch param {
	case "project":
		p, err := who.resolver(ctx).Project(val)
		if err != nil {
			return "", err
		}
		return p.ID, nil
	case "task":
		tk, err := who.resolver(ctx).Task(val)
		if err != nil {
			return "", err
		}
		return tk.ID, nil
	}
	return val, nil
}

// attachedFiles loads the files of attachments, with their addresses, by id.
func (who *viewer) attachedFiles(ctx context.Context, atts []core.Attachment) (map[string]core.File, error) {
	ids := make([]string, 0, len(atts))
	for _, a := range atts {
		ids = append(ids, a.FileID)
	}
	byID := map[string]core.File{}
	if len(ids) == 0 {
		return byID, nil
	}
	var files []core.File
	if err := who.db.List(ctx, &files, store.Where(store.In("id", ids))); err != nil {
		return nil, err
	}
	for _, f := range files {
		f.URL, f.PreviewURL = who.fileURL(f)
		byID[f.ID] = f
	}
	return byID, nil
}

// handleListCollection returns one kind of row as stored: members, labels, epics and so on.
func (s *Server) handleListCollection(x *c) error {
	name := x.r.PathValue("collection")
	kind, ok := rowKindNamed(name)
	if !ok || kind.list == nil {
		var all []string
		for _, kind := range rowKinds {
			if kind.list != nil {
				all = append(all, kind.name)
			}
		}
		slices.Sort(all)
		return &engine.Error{Code: engine.CodeNotFound, Message: "no list " + name, Allowed: all, Nearest: engine.Nearest(name, all)}
	}
	if kind.list.admin {
		if err := x.admin(); err != nil {
			return err
		}
	}
	query := x.listQuery
	if kind.list.query != nil {
		query = func(rowKind) (store.Q, error) { return kind.list.query(x) }
	}
	q, err := query(kind)
	if err != nil {
		return err
	}
	rows, err := kind.read(x.ctx(), &x.viewer, q)
	if err != nil {
		return err
	}
	if kind.list.also != nil {
		kind.list.also(x.ctx(), &x.viewer, rows)
	}
	if x.wantText() {
		text, err := collectionText(rows, int64(x.intParam("since", -1)))
		if err != nil {
			return err
		}
		return x.text(text)
	}
	return x.ok(map[string]any{name: rows})
}

// collectionText is a list of rows in the text form: one line per row,
// what it is called and then its id. With since 0 or more, only the rows
// that changed after that feed position.
func collectionText(rows any, since int64) (string, error) {
	raw, err := json.Marshal(rows)
	if err != nil {
		return "", err
	}
	var list []map[string]any
	if err := json.Unmarshal(raw, &list); err != nil {
		return "", err
	}
	var b strings.Builder
	for _, r := range list {
		if seq, ok := r["updated_seq"].(float64); ok && since >= 0 && int64(seq) <= since {
			continue
		}
		id, _ := r["id"].(string)
		if id == "" {
			id, _ = r["user_id"].(string)
		}
		fmt.Fprintf(&b, "%s  id=%s\n", strings.Join(rowWords(r), "  "), id)
	}
	if b.Len() == 0 {
		b.WriteString("nothing\n")
	}
	return b.String(), nil
}

// rowWords are what a row is called in the text form: its number, its
// names and kinds, what it hangs on when it has no name of its own, and
// its file's name first when it has one.
func rowWords(r map[string]any) []string {
	var words []string
	for _, k := range []string{"key", "handle", "slug", "name", "title", "text", "body", "kind", "type", "state", "category", "role", "url", "starts_on", "ends_on", "ref"} {
		if v, ok := r[k].(string); ok && v != "" {
			if k == "handle" {
				v = "@" + v
			}
			words = append(words, oneLine(v, 80))
		}
	}
	if n, ok := r["number"].(float64); ok {
		words = append([]string{fmt.Sprintf("#%d", int(n))}, words...)
	}
	for _, k := range []string{"task_id", "related_task_id", "resource_id", "user_id", "file_id"} {
		if v, ok := r[k].(string); ok && v != "" && len(words) < 4 {
			words = append(words, strings.TrimSuffix(k, "_id")+"="+v)
		}
	}
	if f, ok := r["file"].(map[string]any); ok {
		if n, _ := f["name"].(string); n != "" {
			words = append([]string{n}, words...)
		}
	}
	return words
}
