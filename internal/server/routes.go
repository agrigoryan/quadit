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

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// The core routes of the API, and /list/{collection}: one kind of row as
// stored (the kinds are in rowkinds.go). Other files add their own routes
// through extraRoutes.

// routes makes the server's mux: the routes listed here, then those the
// feature files add (addFeatureRoutes).
func (s *Server) routes() {
	m := http.NewServeMux()
	s.mux = m
	// Monitoring: no sign-in.
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, "ok") })
	m.HandleFunc("GET /readyz", s.handleCheckReadiness)
	m.HandleFunc("GET /metrics", s.handleShowMetrics)

	// Signing in and the account, outside any workspace.
	m.HandleFunc("GET /api/v1/auth/config", s.public(s.handleShowSignInOptions))
	m.HandleFunc("POST /api/v1/auth/setup", s.public(s.handleSetUpInstall))
	m.HandleFunc("POST /api/v1/auth/login", s.public(s.handleSignIn))
	m.HandleFunc("POST /api/v1/auth/logout", s.public(s.handleSignOut))
	m.HandleFunc("GET /api/v1/auth/me", s.signedIn(s.handleShowAccount))
	m.HandleFunc("PATCH /api/v1/auth/me", s.signedIn(s.handleUpdateProfile))
	m.HandleFunc("POST /api/v1/auth/password", s.signedIn(s.handleChangePassword))
	m.HandleFunc("GET /api/v1/auth/sessions", s.signedIn(s.handleListSessions))
	m.HandleFunc("DELETE /api/v1/auth/sessions/{id}", s.signedIn(s.handleRevokeSession))
	m.HandleFunc("POST /api/v1/workspaces", s.signedIn(s.handleCreateWorkspace))
	m.HandleFunc("GET /api/v1/changes", s.public(s.handleDescribeChangeTypes))

	// Inside a workspace: every write is a change; the rest are reads.
	const w = "/api/v1/w/{ws}"
	m.HandleFunc("POST "+w+"/changes", s.workspaceMember(s.handleApplyChanges))
	m.HandleFunc("GET "+w+"/bootstrap", s.workspaceMember(s.handleBootstrapLocalCopy))
	// Orientation and the feed.
	m.HandleFunc("GET "+w+"/me", s.workspaceMember(s.handleShowWhoAmI))
	m.HandleFunc("GET "+w+"/my-work", s.workspaceMember(s.handleShowMyWork))
	m.HandleFunc("GET "+w+"/events", s.workspaceMember(s.handleReadFeed))
	m.HandleFunc("GET "+w+"/events/stream", s.workspaceMember(s.handleStreamFeed))
	m.HandleFunc("GET "+w+"/cursors/{name}", s.workspaceMember(s.handleShowFeedCursor))
	m.HandleFunc("PUT "+w+"/cursors/{name}", s.workspaceMember(s.handleMoveFeedCursor))
	// Finding tasks, decisions and rows.
	m.HandleFunc("GET "+w+"/tasks", s.workspaceMember(s.handleListTasks))
	m.HandleFunc("GET "+w+"/tasks/{ref}", s.workspaceMember(s.handleShowTask))
	m.HandleFunc("GET "+w+"/tasks/{ref}/context", s.workspaceMember(s.handleShowTaskContext))
	m.HandleFunc("GET "+w+"/inbox", s.workspaceMember(s.handleListInbox))
	m.HandleFunc("GET "+w+"/search", s.workspaceMember(s.handleSearch))
	m.HandleFunc("GET "+w+"/decisions", s.workspaceMember(s.handleListDecisions))
	m.HandleFunc("GET "+w+"/projects/{key}/layout", s.workspaceMember(s.handleShowProjectLayout))
	m.HandleFunc("GET "+w+"/list/{collection}", s.workspaceMember(s.handleListCollection))
	// Tokens and files.
	m.HandleFunc("GET "+w+"/tokens", s.workspaceMember(s.handleListTokens))
	m.HandleFunc("POST "+w+"/tokens", s.workspaceMember(s.handleCreateToken))
	m.HandleFunc("DELETE "+w+"/tokens/{id}", s.workspaceMember(s.handleRevokeToken))
	m.HandleFunc("POST "+w+"/files", s.workspaceMember(s.handleUploadFile))
	m.HandleFunc("PATCH "+w+"/files/{id}", s.workspaceMember(s.handleUploadFilePart))
	m.HandleFunc("GET "+w+"/files/{id}", s.workspaceMember(s.handleShowFile))
	m.HandleFunc("GET /f/{id}/{name...}", s.signedIn(s.handleServeFile))
	s.addFeatureRoutes(m)
}

// addFeatureRoutes registers the routes added by other files of this package.
func (s *Server) addFeatureRoutes(m *http.ServeMux) {
	for _, add := range extraRoutes {
		add(s, m)
	}
}

// extraRoutes lets each feature file add its routes from an init function.
var extraRoutes []func(s *Server, m *http.ServeMux)

// handleCheckReadiness answers "ready" when the database answers within
// three seconds.
func (s *Server) handleCheckReadiness(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.st.Ping(ctx); err != nil {
		http.Error(w, "database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	fmt.Fprintln(w, "ready")
}

// handleShowMetrics writes counters in the Prometheus text format.
func (s *Server) handleShowMetrics(w http.ResponseWriter, r *http.Request) {
	// The token decides access: when it cannot be read, nobody is let in.
	var tok string
	if err := s.checkedSetting(r.Context(), "metrics.token", &tok); err != nil {
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

// narrowingParams are the URL parameters a list is narrowed by, and the
// field of the row each one matches.
var narrowingParams = map[string]string{"project": "ProjectID", "task": "TaskID", "epic": "EpicID", "database": "DatabaseID", "doc": "DocID", "webhook": "WebhookID", "agent": "AgentID"}

// listQuery reads from the request which rows of a kind /list is asked
// for. The URL narrows the list by the columns most kinds have (project=,
// task=, epic=, …; one counts when the kind has its column, and a project or
// a task may be named by its key), trash=1 lists the deleted rows with the
// live ones, and limit= and offset= page it (at most 5000 rows).
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
	if _, ok := kind.row.FieldByName("DeletedAt"); ok && !truthyParam(v, "trash") {
		where = append(where, store.Live)
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
