package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"regexp"
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
	m.HandleFunc("GET /readyz", s.handleCheckReadiness)
	m.HandleFunc("GET /metrics", s.handleShowMetrics)

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

	const w = "/api/v1/w/{ws}"
	m.HandleFunc("POST "+w+"/changes", s.workspaceMember(s.handleApplyChanges))
	m.HandleFunc("GET "+w+"/bootstrap", s.workspaceMember(s.handleBootstrapLocalCopy))
	m.HandleFunc("GET "+w+"/me", s.workspaceMember(s.handleShowWhoAmI))
	m.HandleFunc("GET "+w+"/my-work", s.workspaceMember(s.handleShowMyWork))
	m.HandleFunc("GET "+w+"/events", s.workspaceMember(s.handleReadFeed))
	m.HandleFunc("GET "+w+"/events/stream", s.workspaceMember(s.handleStreamFeed))
	m.HandleFunc("GET "+w+"/cursors/{name}", s.workspaceMember(s.handleShowFeedCursor))
	m.HandleFunc("PUT "+w+"/cursors/{name}", s.workspaceMember(s.handleMoveFeedCursor))
	m.HandleFunc("GET "+w+"/tasks", s.workspaceMember(s.handleListTasks))
	m.HandleFunc("GET "+w+"/tasks/{ref}", s.workspaceMember(s.handleShowTask))
	m.HandleFunc("GET "+w+"/tasks/{ref}/context", s.workspaceMember(s.handleShowTaskContext))
	m.HandleFunc("GET "+w+"/inbox", s.workspaceMember(s.handleListInbox))
	m.HandleFunc("GET "+w+"/search", s.workspaceMember(s.handleSearch))
	m.HandleFunc("GET "+w+"/decisions", s.workspaceMember(s.handleListDecisions))
	m.HandleFunc("GET "+w+"/projects/{key}/layout", s.workspaceMember(s.handleShowProjectLayout))
	m.HandleFunc("GET "+w+"/list/{collection}", s.workspaceMember(s.handleListCollection))
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
	fmt.Fprintf(w, "# TYPE quadit_rows gauge\n")
	for _, t := range []string{"workspaces", "users", "tasks", "events", "docs", "files"} {
		if n, err := s.st.Count(ctx, t); err == nil {
			fmt.Fprintf(w, "quadit_rows{table=%q} %d\n", t, n)
		}
	}
	if n, err := s.st.Count(ctx, "jobs", store.Null("done_at")); err == nil {
		fmt.Fprintf(w, "# TYPE quadit_jobs_waiting gauge\nquadit_jobs_waiting %d\n", n)
	}
	fmt.Fprintf(w, "# TYPE quadit_webhook_deliveries_dead gauge\nquadit_webhook_deliveries_dead %d\n", liveDeliveries(ctx, s.st, store.Eq("state", "dead")))
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
				args = append(args, a.Name)
			}
			fmt.Fprintf(&b, "%s (%s): %s\n", ci.Type, ci.Role, strings.Join(args, ", "))
		}
		fmt.Fprintf(&b, "surface: %s (within %s.x nothing is removed or renamed)\n", engine.Surface, strings.Split(engine.Surface, ".")[0])
		return x.text(b.String())
	}
	return x.ok(map[string]any{"changes": cat, "surface": engine.Surface})
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
		// Keep a narrowed caller inside its projects: by the row's own
		// project, by being a project, or by the task it hangs on.
		if x.projects != nil {
			if f, ok := t.FieldByName("ProjectID"); ok {
				rows = keep(rows, func(r T) bool { return x.canProject(reflect.ValueOf(r).FieldByIndex(f.Index).String()) })
			} else if t == reflect.TypeFor[core.Project]() {
				rows = keep(rows, func(r T) bool { return x.canProject(reflect.ValueOf(r).FieldByName("ID").String()) })
			} else if f, ok := t.FieldByName("TaskID"); ok {
				rows = keepByTask(x, rows, func(r T) string { return reflect.ValueOf(r).FieldByIndex(f.Index).String() })
			} else if f, ok := t.FieldByName("EpicID"); ok {
				projectOf := map[string]string{}
				rows = keep(rows, func(r T) bool {
					eid := reflect.ValueOf(r).FieldByIndex(f.Index).String()
					pid, seen := projectOf[eid]
					if !seen {
						var e core.Epic
						pid = "none"
						if x.db.Get(x.ctx(), &e, store.Eq("id", eid)) == nil {
							pid = e.ProjectID
						}
						projectOf[eid] = pid
					}
					return x.canProject(pid)
				})
			}
		}
		if rows == nil {
			rows = []T{}
		}
		return rows, nil
	}
}

// keepByTask keeps, for a caller limited to some projects, the rows that
// hang on a task of those projects, and the rows on no task.
func keepByTask[T any](x *c, rows []T, taskOf func(T) string) []T {
	if x.projects == nil {
		return rows
	}
	projectOf := map[string]string{}
	return keep(rows, func(r T) bool {
		tid := taskOf(r)
		if tid == "" {
			return true
		}
		pid, seen := projectOf[tid]
		if !seen {
			var tk core.Task
			pid = "none"
			if x.db.Get(x.ctx(), &tk, store.Eq("id", tid)) == nil {
				pid = tk.ProjectID
			}
			projectOf[tid] = pid
		}
		return x.canProject(pid)
	})
}

// taskKeyIn finds a task key ("SVA-12") in a line of text.
var taskKeyIn = regexp.MustCompile(`\b([A-Z][A-Z0-9]{1,9})-\d+\b`)

// hideActions blanks, for a caller limited to some projects, what a member
// last did when it names a task of another project.
func (x *c) hideActions(members []core.Member) {
	if x.projects == nil {
		return
	}
	var projects []core.Project
	_ = x.db.List(x.ctx(), &projects, store.Q{})
	mine := map[string]bool{}
	for _, p := range projects {
		mine[p.Key] = x.canProject(p.ID)
	}
	for i := range members {
		for _, m := range taskKeyIn.FindAllStringSubmatch(members[i].LastAction, -1) {
			if !mine[m[1]] {
				members[i].LastAction = ""
				break
			}
		}
	}
}

var collections = map[string]collection{
	"members": {load: func(x *c) (any, error) {
		rows, err := listOf[core.Member]("handle")(x)
		if err != nil {
			return nil, err
		}
		ms := rows.([]core.Member)
		x.s.withResponsible(x.ctx(), ms)
		x.hideActions(ms)
		if x.member.Role.AtLeast(core.RoleAdmin) {
			// Admins see people's addresses: they invite and import by them.
			var ids []string
			for _, m := range ms {
				if m.Kind == core.KindPerson {
					ids = append(ids, m.UserID)
				}
			}
			var users []core.User
			if len(ids) > 0 && x.s.st.List(x.ctx(), &users, store.Where(store.In("id", ids))) == nil {
				by := map[string]string{}
				for _, u := range users {
					by[u.ID] = u.Email
				}
				for i := range ms {
					ms[i].Email = by[ms[i].UserID]
				}
			}
		}
		return ms, nil
	}},
	"projects":    {load: listOf[core.Project]("rank")},
	"statuses":    {load: listOf[core.Status]("rank")},
	"labels":      {load: listOf[core.Label]("name")},
	"epics":       {load: listOf[core.Epic]("rank")},
	"milestones":  {load: listOf[core.Milestone]("rank")},
	"cycles":      {load: listOf[core.Cycle]("starts_on")},
	"templates":   {load: listOf[core.Template]("name")},
	"preferences": {load: listOf[core.Preference]("created_at")},
	"resources":   {load: listOf[core.Resource]("name")},
	"secrets":     {admin: true, load: listOf[core.Secret]("name")},
	"claims":      {load: listOf[core.ResourceClaim]("requested_at", store.Ne("state", "released"))},
	"sessions":    {load: listOf[core.AgentSession]("-started_at")},
	"relations":   {load: listOf[core.Relation]("created_at")},
	// Files attached to tasks, decisions, options, comments and pages;
	// trash=1 lists the removed ones, which attachment.restore puts back.
	"attachments": {load: func(x *c) (any, error) {
		conds := []store.Cond{store.Live}
		if truthyParam(x.r.URL.Query(), "trash") {
			conds = []store.Cond{store.NotNull("deleted_at")}
		}
		if ref := x.r.URL.Query().Get("task"); ref != "" {
			t, err := x.taskByRef(ref)
			if err != nil {
				return nil, err
			}
			conds = append(conds, store.Eq("task_id", t.ID))
		}
		var atts []core.Attachment
		if err := x.db.List(x.ctx(), &atts, store.Q{Where: conds, Order: "-created_at", Limit: 1000}); err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(atts))
		for _, a := range atts {
			ids = append(ids, a.FileID)
		}
		byID := map[string]core.File{}
		if len(ids) > 0 {
			var files []core.File
			if err := x.db.List(x.ctx(), &files, store.Where(store.In("id", ids))); err != nil {
				return nil, err
			}
			for _, f := range files {
				f.URL, f.PreviewURL = x.fileURL(f)
				byID[f.ID] = f
			}
		}
		out := atts[:0]
		for _, a := range atts {
			if a.TaskID != "" {
				var t core.Task
				if err := x.db.Get(x.ctx(), &t, store.Eq("id", a.TaskID)); err != nil || !x.canProject(t.ProjectID) {
					continue
				}
			}
			if f, ok := byID[a.FileID]; ok {
				a.File = &f
			}
			out = append(out, a)
		}
		return out, nil
	}},
	"links":      {load: listOf[core.TaskLink]("created_at")},
	"webhooks":   {admin: true, load: listOf[core.Webhook]("name")},
	"deliveries": {admin: true, load: listOf[core.WebhookDelivery]("-created_at")},
	"rules":      {admin: true, load: listOf[core.Rule]("name")},
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

// handleListCollection returns one kind of row as stored: members, labels, epics and so on.
func (s *Server) handleListCollection(x *c) error {
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
	if x.wantText() {
		// One line per row: what it is called, then its id.
		raw, _ := json.Marshal(rows)
		var list []map[string]any
		json.Unmarshal(raw, &list)
		since := int64(x.intParam("since", -1))
		var b strings.Builder
		for _, r := range list {
			if seq, ok := r["updated_seq"].(float64); ok && since >= 0 && int64(seq) <= since {
				continue
			}
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
			// What it hangs on, when it has no name of its own.
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
			id, _ := r["id"].(string)
			if id == "" {
				id, _ = r["user_id"].(string)
			}
			fmt.Fprintf(&b, "%s  id=%s\n", strings.Join(words, "  "), id)
		}
		if b.Len() == 0 {
			b.WriteString("nothing\n")
		}
		return x.text(b.String())
	}
	return x.ok(map[string]any{name: rows})
}
