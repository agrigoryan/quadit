package server

import (
	"context"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

func (s *Server) routes() {
	m := http.NewServeMux()
	s.mux = m
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") })
	m.HandleFunc("GET /readyz", s.hReady)
	m.HandleFunc("GET /metrics", s.hMetrics)

	m.HandleFunc("GET /api/v1/auth/config", s.open(s.hAuthConfig))
	m.HandleFunc("POST /api/v1/auth/setup", s.open(s.hSetup))
	m.HandleFunc("POST /api/v1/auth/login", s.open(s.hLogin))
	m.HandleFunc("POST /api/v1/auth/logout", s.open(s.hLogout))
	m.HandleFunc("GET /api/v1/auth/me", s.signed(s.hAuthMe))
	m.HandleFunc("PATCH /api/v1/auth/me", s.signed(s.hProfile))
	m.HandleFunc("POST /api/v1/auth/password", s.signed(s.hPassword))
	m.HandleFunc("GET /api/v1/auth/sessions", s.signed(s.hSessions))
	m.HandleFunc("DELETE /api/v1/auth/sessions/{id}", s.signed(s.hSessionRevoke))
	m.HandleFunc("POST /api/v1/workspaces", s.signed(s.hWorkspaceCreate))
	m.HandleFunc("GET /api/v1/changes", s.open(s.hCatalog))

	const w = "/api/v1/w/{ws}"
	m.HandleFunc("POST "+w+"/changes", s.in(s.hChanges))
	m.HandleFunc("GET "+w+"/bootstrap", s.in(s.hBootstrap))
	m.HandleFunc("GET "+w+"/me", s.in(s.hMe))
	m.HandleFunc("GET "+w+"/my-work", s.in(s.hMyWork))
	m.HandleFunc("GET "+w+"/events", s.in(s.hEvents))
	m.HandleFunc("GET "+w+"/events/stream", s.in(s.hStream))
	m.HandleFunc("GET "+w+"/cursors/{name}", s.in(s.hCursorGet))
	m.HandleFunc("PUT "+w+"/cursors/{name}", s.in(s.hCursorPut))
	m.HandleFunc("GET "+w+"/tasks", s.in(s.hTasks))
	m.HandleFunc("GET "+w+"/tasks/{ref}", s.in(s.hTask))
	m.HandleFunc("GET "+w+"/tasks/{ref}/context", s.in(s.hContext))
	m.HandleFunc("GET "+w+"/inbox", s.in(s.hInbox))
	m.HandleFunc("GET "+w+"/search", s.in(s.hSearch))
	m.HandleFunc("GET "+w+"/decisions", s.in(s.hDecisions))
	m.HandleFunc("GET "+w+"/projects/{key}/layout", s.in(s.hLayout))
	m.HandleFunc("GET "+w+"/list/{collection}", s.in(s.hList))
	m.HandleFunc("GET "+w+"/tokens", s.in(s.hTokens))
	m.HandleFunc("POST "+w+"/tokens", s.in(s.hTokenCreate))
	m.HandleFunc("DELETE "+w+"/tokens/{id}", s.in(s.hTokenRevoke))
	m.HandleFunc("POST "+w+"/files", s.in(s.hUpload))
	m.HandleFunc("PATCH "+w+"/files/{id}", s.in(s.hUploadPart))
	m.HandleFunc("GET "+w+"/files/{id}", s.in(s.hFileMeta))
	m.HandleFunc("GET /f/{id}/{name...}", s.signed(s.hFileServe))
	s.moreRoutes(m)
}

func (s *Server) hReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.st.Ping(ctx); err != nil {
		http.Error(w, "database: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	fmt.Fprintln(w, "ready")
}

// hMetrics writes counters in the Prometheus text format.
func (s *Server) hMetrics(w http.ResponseWriter, r *http.Request) {
	if tok := s.settingStr(r.Context(), "metrics.token", ""); tok != "" && r.Header.Get("Authorization") != "Bearer "+tok {
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
	for _, t := range []string{"workspaces", "users", "tasks", "events", "docs", "files"} {
		if n, err := s.st.Count(ctx, t); err == nil {
			fmt.Fprintf(w, "# TYPE quadit_rows gauge\nquadit_rows{table=%q} %d\n", t, n)
		}
	}
	if n, err := s.st.Count(ctx, "jobs", store.Null("done_at")); err == nil {
		fmt.Fprintf(w, "# TYPE quadit_jobs_waiting gauge\nquadit_jobs_waiting %d\n", n)
	}
	if n, err := s.st.Count(ctx, "webhook_deliveries", store.Eq("state", "dead")); err == nil {
		fmt.Fprintf(w, "# TYPE quadit_webhook_deliveries_dead gauge\nquadit_webhook_deliveries_dead %d\n", n)
	}
	fmt.Fprintf(w, "# TYPE quadit_info gauge\nquadit_info{version=%q,database=%q,files=%q} 1\n", s.cfg.Version, s.st.Dialect(), s.fileStore().Kind())
}

// hCatalog lists every change type with its arguments.
func (s *Server) hCatalog(x *c) error {
	cat := engine.Catalog()
	if x.wantText() {
		var b strings.Builder
		for _, ci := range cat {
			var args []string
			for _, a := range ci.Args {
				args = append(args, a.Name)
			}
			fmt.Fprintf(&b, "%s (%s): %s\n", ci.Type, ci.Role, strings.Join(args, ", "))
		}
		return x.text(b.String())
	}
	return x.ok(map[string]any{"changes": cat})
}

// collection is one kind of row a caller can list as stored.
type collection struct {
	admin bool
	load  func(x *c) (any, error)
}

func listOf[T any](order string, conds ...store.Cond) func(x *c) (any, error) {
	return func(x *c) (any, error) {
		var rows []T
		where := append([]store.Cond(nil), conds...)
		v := x.r.URL.Query()
		t := reflect.TypeFor[T]()
		// Simple narrowing by the columns most lists have.
		for param, field := range map[string]string{"project": "ProjectID", "task": "TaskID", "epic": "EpicID", "database": "DatabaseID", "doc": "DocID", "webhook": "WebhookID", "agent": "AgentID"} {
			if val := v.Get(param); val != "" {
				if f, ok := t.FieldByName(field); ok {
					col := strings.Split(f.Tag.Get("db"), ",")[0]
					if param == "project" {
						p, err := x.resolver().Project(val)
						if err != nil {
							return nil, err
						}
						val = p.ID
					} else if param == "task" {
						tk, err := x.resolver().Task(val)
						if err != nil {
							return nil, err
						}
						val = tk.ID
					}
					where = append(where, store.Eq(col, val))
				}
			}
		}
		if _, ok := t.FieldByName("DeletedAt"); ok && !truthyParam(v, "trash") {
			where = append(where, store.Live)
		}
		if err := x.db.List(x.ctx(), &rows, store.Q{Where: where, Order: order, Limit: min(x.intParam("limit", 1000), 5000), Offset: x.intParam("offset", 0)}); err != nil {
			return nil, err
		}
		// Keep a narrowed caller inside its projects.
		if f, ok := t.FieldByName("ProjectID"); ok && x.projects != nil {
			rows = keep(rows, func(r T) bool { return x.canProject(reflect.ValueOf(r).FieldByIndex(f.Index).String()) })
		}
		if rows == nil {
			rows = []T{}
		}
		return rows, nil
	}
}

var collections = map[string]collection{
	"members":     {load: listOf[core.Member]("handle")},
	"projects":    {load: listOf[core.Project]("rank")},
	"statuses":    {load: listOf[core.Status]("rank")},
	"labels":      {load: listOf[core.Label]("name")},
	"epics":       {load: listOf[core.Epic]("rank")},
	"milestones":  {load: listOf[core.Milestone]("rank")},
	"cycles":      {load: listOf[core.Cycle]("starts_on")},
	"templates":   {load: listOf[core.Template]("name")},
	"preferences": {load: listOf[core.Preference]("created_at")},
	"resources":   {load: listOf[core.Resource]("name")},
	"claims":      {load: listOf[core.ResourceClaim]("requested_at", store.Ne("state", "released"))},
	"sessions":    {load: listOf[core.AgentSession]("-started_at")},
	"relations":   {load: listOf[core.Relation]("created_at")},
	"links":       {load: listOf[core.TaskLink]("created_at")},
	"webhooks":    {admin: true, load: listOf[core.Webhook]("name")},
	"deliveries":  {admin: true, load: listOf[core.WebhookDelivery]("-created_at")},
	"rules":       {admin: true, load: listOf[core.Rule]("name")},
	"integrations": {admin: true, load: func(x *c) (any, error) {
		rows, err := listOf[core.Integration]("created_at")(x)
		if err != nil {
			return nil, err
		}
		list := rows.([]core.Integration)
		for i := range list {
			list[i].HasSecret = list[i].Secret != ""
		}
		return list, nil
	}},
	"views": {load: func(x *c) (any, error) {
		rows, err := listOf[core.View]("rank")(x)
		if err != nil {
			return nil, err
		}
		return keep(rows.([]core.View), func(v core.View) bool { return v.Shared || v.OwnerID == x.member.UserID }), nil
	}},
}

// hList returns one kind of row as stored: members, labels, epics and so on.
func (s *Server) hList(x *c) error {
	name := x.r.PathValue("collection")
	col, ok := collections[name]
	if !ok {
		var all []string
		for k := range collections {
			all = append(all, k)
		}
		sort.Strings(all)
		return &engine.Error{Code: engine.CodeNotFound, Message: "no list " + name, Allowed: all, Nearest: nearestOf(name, all)}
	}
	if col.admin {
		if err := x.admin(); err != nil {
			return err
		}
	}
	rows, err := col.load(x)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{name: rows})
}
