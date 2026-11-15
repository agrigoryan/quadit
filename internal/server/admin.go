package server

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/admin/settings", s.signed(s.installAdmin(s.handleListSettings)))
		m.HandleFunc("PUT /api/v1/admin/settings/{name}", s.signed(s.installAdmin(s.handleUpdateSetting)))
		m.HandleFunc("POST /api/v1/admin/mail/test", s.signed(s.installAdmin(s.handleSendTestMail)))
		m.HandleFunc("GET /api/v1/admin/audit", s.signed(s.installAdmin(s.handleListInstallAuditLog)))
		m.HandleFunc("GET /api/v1/admin/users", s.signed(s.installAdmin(s.handleListUsers)))
		m.HandleFunc("PATCH /api/v1/admin/users/{id}", s.signed(s.installAdmin(s.handleUpdateUser)))
		m.HandleFunc("GET /api/v1/admin/workspaces", s.signed(s.installAdmin(s.handleListWorkspaces)))
		m.HandleFunc("POST /api/v1/admin/workspaces/{id}/join", s.signed(s.installAdmin(s.handleJoinWorkspace)))
		m.HandleFunc("POST /api/v1/admin/workspaces/{id}/restore", s.signed(s.installAdmin(s.handleRestoreWorkspace)))
		m.HandleFunc("GET /api/v1/admin/health", s.signed(s.installAdmin(s.handleShowInstallHealth)))
		m.HandleFunc("GET /api/v1/w/{ws}/audit", s.in(s.handleListWorkspaceAuditLog))
	})
}

// installAdmin lets through only people who run the install.
func (s *Server) installAdmin(h handler) handler {
	return func(x *c) error {
		// A person who runs the install, signed in or with a token of their
		// own that is not narrowed: what the admin pages do, a script can do.
		if !x.user.IsAdmin || x.user.Kind != core.KindPerson || !x.whole() {
			return errForbidden("this is for the people who run the install (signed in, or with a personal token that is not read-only or limited to projects)")
		}
		return h(x)
	}
}

func (s *Server) handleListSettings(x *c) error {
	return x.ok(map[string]any{"settings": s.maskedSettings(x.ctx())})
}

// handleUpdateSetting sets one install setting. The body is its JSON value.
func (s *Server) handleUpdateSetting(x *c) error {
	name := x.r.PathValue("name")
	var value json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(x.w, x.r.Body, 1<<20)).Decode(&value); err != nil {
		return errBad("the body must be the setting's JSON value")
	}
	if _, fromEnv := s.rawSetting(x.ctx(), name); fromEnv {
		return &engine.Error{Code: engine.CodeConflict, Message: fmt.Sprintf("%s is set by the environment variable %s, which wins; change it there", name, envName(name))}
	}
	if err := s.keepsADoor(x, name, value); err != nil {
		return err
	}
	if err := s.saveSetting(x.ctx(), name, value, x.user.ID); err != nil {
		return err
	}
	// The record says what it was set to, with anything secret blanked.
	s.audit(x.r, "", x.user, "setting.changed", "setting", name, s.maskedSettings(x.ctx())[name])
	return s.handleListSettings(x)
}

func (s *Server) handleSendTestMail(x *c) error {
	var b struct {
		To string `json:"to"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	if b.To == "" {
		b.To = x.user.Email
	}
	if err := s.sendMail(x.ctx(), b.To, "Test message", "This is a test message from your install. Mail works."); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Message: err.Error()}
	}
	return x.ok(map[string]any{"sent_to": b.To})
}

// auditQuery reads the audit log with the URL's filters.
func (s *Server) auditQuery(x *c, workspaceID string) error {
	v := x.r.URL.Query()
	var conds []store.Cond
	if workspaceID != "" {
		conds = append(conds, store.Eq("workspace_id", workspaceID))
	} else if ws := v.Get("workspace"); ws != "" {
		conds = append(conds, store.Eq("workspace_id", ws))
	}
	if a := v.Get("action"); a != "" {
		conds = append(conds, store.Like("action", strings.ReplaceAll(a, "*", "%")))
	}
	if a := v.Get("actor"); a != "" {
		conds = append(conds, store.Eq("actor_id", a))
	}
	if b := x.intParam("before", 0); b > 0 {
		conds = append(conds, store.Lt("at", int64(b)))
	}
	if a := x.intParam("after", 0); a > 0 {
		conds = append(conds, store.Gt("at", int64(a)))
	}
	// Entries are numbered in the order they were written: paging by the
	// last id seen never skips or repeats one, however many share a moment.
	if cur := v.Get("cursor"); cur != "" {
		conds = append(conds, store.Lt("id", cur))
	}
	limit := min(x.intParam("limit", 100), 5000)
	if v.Get("format") == "csv" {
		limit = 50000
	}
	var rows []core.AuditEntry
	if err := s.st.List(x.ctx(), &rows, store.Q{Where: conds, Order: "-id", Limit: limit}); err != nil {
		return err
	}
	if v.Get("format") == "csv" {
		s.audit(x.r, workspaceID, x.user, "audit.exported", "audit", "", nil)
		x.w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		x.w.Header().Set("Content-Disposition", `attachment; filename="audit-log.csv"`)
		cw := csv.NewWriter(x.w)
		cw.Write([]string{"time", "actor", "action", "target_type", "target_id", "workspace", "ip", "data"})
		for _, r := range rows {
			cw.Write([]string{time.UnixMilli(r.At).UTC().Format(time.RFC3339), r.ActorName, r.Action, r.TargetType, r.TargetID, r.WorkspaceID, r.IP, string(r.Data)})
		}
		cw.Flush()
		return cw.Error()
	}
	out := map[string]any{"audit": rows}
	if len(rows) == limit {
		out["next"] = rows[len(rows)-1].ID // pass as cursor= for the page after
	}
	return x.ok(out)
}

func (s *Server) handleListInstallAuditLog(x *c) error { return s.auditQuery(x, "") }

// handleListWorkspaceAuditLog is a workspace's own slice of the audit log, for its admins.
func (s *Server) handleListWorkspaceAuditLog(x *c) error {
	if err := x.admin(); err != nil {
		return err
	}
	return s.auditQuery(x, x.ws.ID)
}

func (s *Server) handleListUsers(x *c) error {
	var us []core.User
	conds := []store.Cond{store.Live}
	if k := x.r.URL.Query().Get("kind"); k != "" {
		conds = append(conds, store.Eq("kind", k))
	}
	if err := s.st.List(x.ctx(), &us, store.Q{Where: conds, Order: "name", Limit: 5000}); err != nil {
		return err
	}
	return x.ok(map[string]any{"users": us})
}

type userPatch struct {
	Disabled *bool `json:"disabled"`
	IsAdmin  *bool `json:"is_admin"`
}

// handleUpdateUser disables or enables an account, or changes who runs the install.
func (s *Server) handleUpdateUser(x *c) error {
	var b userPatch
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	var u core.User
	if err := s.st.Get(ctx, &u, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		return errNotFound("user")
	}
	set := map[string]any{}
	if b.Disabled != nil {
		if *b.Disabled && u.ID == x.user.ID {
			return errBad("you cannot disable your own account")
		}
		if *b.Disabled {
			set["disabled_at"] = time.Now().UnixMilli()
		} else {
			set["disabled_at"] = 0
		}
	}
	if b.IsAdmin != nil {
		if !*b.IsAdmin && u.ID == x.user.ID {
			if n, _ := s.st.Count(ctx, "users", store.Eq("is_admin", true), store.Live, store.Null("disabled_at")); n <= 1 {
				return &engine.Error{Code: engine.CodeConflict, Message: "an install needs someone to run it: make someone else an admin first"}
			}
		}
		set["is_admin"] = *b.IsAdmin
	}
	if len(set) == 0 {
		return x.ok(u)
	}
	if _, err := s.st.Update(ctx, "users", set, store.Eq("id", u.ID)); err != nil {
		return err
	}
	if b.Disabled != nil && *b.Disabled {
		now := time.Now().UnixMilli()
		s.st.Update(ctx, "sessions", map[string]any{"revoked_at": now}, store.Eq("user_id", u.ID), store.Null("revoked_at"))
		s.st.Update(ctx, "api_tokens", map[string]any{"revoked_at": now}, store.Eq("user_id", u.ID), store.Null("revoked_at"))
		s.accessChanged()
	}
	s.audit(x.r, "", x.user, "user.changed", "user", u.ID, b)
	s.st.Get(ctx, &u, store.Eq("id", u.ID))
	return x.ok(u)
}

func (s *Server) handleListWorkspaces(x *c) error {
	ctx := x.ctx()
	var wss []core.Workspace
	// Deleted ones are listed too, marked, for the 30 days they can come back.
	if err := s.st.List(ctx, &wss, store.Q{Order: "name"}); err != nil {
		return err
	}
	type row struct {
		core.Workspace
		Members int `json:"members"`
		Tasks   int `json:"tasks"`
		// DeletedAt is set for a workspace in the trash; it can be restored
		// until it is removed for good 30 days later.
		DeletedAt int64 `json:"deleted_at,omitempty"`
	}
	out := make([]row, len(wss))
	for i, ws := range wss {
		out[i].Workspace, out[i].DeletedAt = ws, ws.DeletedAt
		out[i].Members, _ = s.st.Count(ctx, "members", store.Eq("workspace_id", ws.ID), store.Null("removed_at"))
		out[i].Tasks, _ = s.st.Count(ctx, "tasks", store.Eq("workspace_id", ws.ID), store.Live)
	}
	return x.ok(map[string]any{"workspaces": out})
}

// handleRestoreWorkspace brings a deleted workspace back, within the 30 days
// before it is removed for good.
func (s *Server) handleRestoreWorkspace(x *c) error {
	ctx := x.ctx()
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.r.PathValue("id"))); err != nil {
		return errNotFound("workspace")
	}
	if ws.DeletedAt == 0 {
		return x.ok(map[string]any{"workspace": ws})
	}
	if n, _ := s.st.Count(ctx, "workspaces", store.Eq("slug", ws.Slug), store.Live); n > 0 {
		return &engine.Error{Code: engine.CodeConflict, Message: fmt.Sprintf("another workspace uses the address %q now; rename that one first", ws.Slug)}
	}
	if _, err := s.st.Update(ctx, "workspaces", map[string]any{"deleted_at": 0}, store.Eq("id", ws.ID)); err != nil {
		return err
	}
	ws.DeletedAt = 0
	s.audit(x.r, ws.ID, x.user, "workspace.restored", "workspace", ws.ID, nil)
	return x.ok(map[string]any{"workspace": ws})
}

// handleJoinWorkspace makes the one who runs the install an admin of a workspace
// they are not in, so they can look after it. It is written to the audit
// log of the install and of the workspace, and its members see them join.
func (s *Server) handleJoinWorkspace(x *c) error {
	ctx := x.ctx()
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.r.PathValue("id")), store.Live); err != nil {
		if err := s.st.Get(ctx, &ws, store.Eq("slug", x.r.PathValue("id")), store.Live); err != nil {
			return errNotFound("workspace")
		}
	}
	db := s.st.In(ws.ID)
	if n, _ := db.Count(ctx, "members", store.Eq("user_id", x.user.ID), store.Null("removed_at")); n > 0 {
		return x.ok(map[string]any{"workspace": ws, "already_member": true})
	}
	// The change is made in the name of the workspace's longest-standing owner.
	var owners []core.Member
	if err := db.List(ctx, &owners, store.Q{Where: []store.Cond{store.Eq("role", string(core.RoleOwner)), store.Null("removed_at")}, Order: "created_at", Limit: 1}); err != nil {
		return err
	}
	if len(owners) == 0 {
		return errBad("this workspace has no owner to act for")
	}
	err := s.eng.System(ctx, ws.ID, owners[0].UserID, func(sys *engine.Sys) error {
		return sys.Do("member.add", map[string]any{"user": x.user.ID, "role": string(core.RoleAdmin)})
	})
	if err != nil {
		return err
	}
	s.audit(x.r, ws.ID, x.user, "workspace.joined_by_install_admin", "workspace", ws.ID, nil)
	return x.ok(map[string]any{"workspace": ws})
}

// handleShowInstallHealth is the health panel: what is failing or waiting behind the scenes.
func (s *Server) handleShowInstallHealth(x *c) error {
	ctx := x.ctx()
	out := map[string]any{"version": s.cfg.Version, "database": s.st.Dialect(), "files": s.fileStore().Kind(), "mail": s.mailReady(ctx)}
	out["jobs_waiting"], _ = s.st.Count(ctx, "jobs", store.Null("done_at"))
	out["jobs_failing"], _ = s.st.Count(ctx, "jobs", store.Null("done_at"), store.Gt("attempts", 2))
	out["webhooks_failing"], _ = s.st.Count(ctx, "webhooks", store.Live, store.Gt("failures", 0))
	out["deliveries_dead"] = liveDeliveries(ctx, s.st, store.Eq("state", "dead"))
	out["deliveries_pending"] = liveDeliveries(ctx, s.st, store.Eq("state", "pending"))
	var backups []core.Backup
	if err := s.st.List(ctx, &backups, store.Q{Order: "-started_at", Limit: 1}); err == nil && len(backups) > 0 {
		out["last_backup"] = backups[0]
	}
	out["sources_failing"], _ = s.st.Count(ctx, "doc_sources", store.Live, store.Ne("last_error", ""))
	out["integrations_failing"], _ = s.st.Count(ctx, "integrations", store.Live, store.Ne("last_error", ""))
	return x.ok(out)
}

// keepsADoor refuses a change to the sign-in settings that would leave the
// one making it with no way to sign in: turning passwords off needs a
// passkey or a provider account of theirs that still works.
func (s *Server) keepsADoor(x *c, name string, value json.RawMessage) error {
	ctx := x.ctx()
	on := func(setting string, def bool) bool {
		if setting == name {
			if strings.TrimSpace(string(value)) == "null" {
				// Back to the default: passwords and passkeys on, a provider off.
				return (setting == "auth.password" || setting == "auth.passkeys") && def
			}
			var v struct {
				Enabled *bool `json:"enabled"`
			}
			var b bool
			if json.Unmarshal(value, &b) == nil {
				return b
			}
			if json.Unmarshal(value, &v) == nil && v.Enabled != nil {
				return *v.Enabled
			}
			return false
		}
		if signInSetting(setting) {
			cfg, ok := s.oauthConfig(ctx, strings.TrimPrefix(setting, "auth."))
			return ok && cfg.Enabled
		}
		return s.settingBool(ctx, setting, def)
	}
	if name != "auth.password" && name != "auth.passkeys" && !signInSetting(name) {
		return nil
	}
	if on("auth.password", true) && x.user.PasswordHash != "" {
		return nil
	}
	if on("auth.passkeys", true) {
		if n, _ := s.st.Count(ctx, "passkeys", store.Eq("user_id", x.user.ID)); n > 0 {
			return nil
		}
	}
	for _, p := range signInProviders {
		if on("auth."+p.ID(), false) {
			if n, _ := s.st.Count(ctx, "identities", store.Eq("user_id", x.user.ID), store.Eq("provider", p.ID())); n > 0 {
				return nil
			}
		}
	}
	return &engine.Error{Code: engine.CodeConflict, Message: "this would leave you with no way to sign in: first add a passkey, or sign in once with a provider that stays on"}
}
