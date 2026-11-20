package server

// The install admin's API: settings, people, workspaces, the audit log and the health panel.

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/settings"
	"github.com/agrigoryan/quadit/internal/store"
)

// adminRoutes are the install admin's routes, and the workspace's audit log.
func (s *Server) adminRoutes() []route {
	return []route{
		{"GET /api/v1/admin/settings", s.signedIn(s.installAdmin(s.handleListSettings)), "The install's settings; secrets are blanked.", "", "install"},
		{"PUT /api/v1/admin/settings/{name}", s.signedIn(s.installAdmin(s.handleUpdateSetting)), "Set one setting. Body: its JSON value.", "", "install"},
		{"POST /api/v1/admin/mail/test", s.signedIn(s.installAdmin(s.handleSendTestMail)), "Send a test message through the mail server. Body: {to}.", "", "install"},
		{"GET /api/v1/admin/audit", s.signedIn(s.installAdmin(s.handleListInstallAuditLog)), "The install's audit log, newest first.", "action: a name, * for any run of letters; actor; workspace; cursor: the last id seen; limit; format: csv", "install"},
		{"GET /api/v1/admin/users", s.signedIn(s.installAdmin(s.handleListUsers)), "Every account on the install.", "kind: person or agent", "install"},
		{"PATCH /api/v1/admin/users/{id}", s.signedIn(s.installAdmin(s.handleUpdateUser)), "Disable or enable an account, or change who runs the install. Body: {disabled, is_admin}.", "", "install"},
		{"GET /api/v1/admin/workspaces", s.signedIn(s.installAdmin(s.handleListWorkspaces)), "Every workspace, deleted ones included for the 30 days they can be restored.", "", "install"},
		{"POST /api/v1/admin/workspaces/{id}/join", s.signedIn(s.installAdmin(s.handleJoinWorkspace)), "Become an admin of a workspace, on the record.", "", "install"},
		{"POST /api/v1/admin/workspaces/{id}/restore", s.signedIn(s.installAdmin(s.handleRestoreWorkspace)), "Bring a deleted workspace back.", "", "install"},
		{"GET /api/v1/admin/health", s.signedIn(s.installAdmin(s.handleShowInstallHealth)), "What is failing or waiting behind the scenes.", "", "install"},
		{"GET /api/v1/w/{ws}/audit", s.workspaceMember(s.handleListWorkspaceAuditLog), "This workspace's part of the audit log, newest first. Admins.", "action; actor; cursor: the last id seen; before; after; limit; format: csv", "admin"},
	}
}

// installAdmin lets through only people who run the install.
func (s *Server) installAdmin(h handler) handler {
	return func(x *c) error {
		// A person who runs the install, signed in or with a token of their
		// own that is not narrowed: what the admin pages do, a script can do.
		if !x.user.IsAdmin || x.user.Kind != core.KindPerson || !x.hasFullAccess() {
			return errForbidden("this is for the people who run the install (signed in, or with a personal token that is not read-only or limited to projects)")
		}
		return h(x)
	}
}

func (s *Server) handleListSettings(x *c) error {
	all, err := s.settings.List(x.ctx())
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"settings": all})
}

// handleUpdateSetting sets one install setting. The body is its JSON value.
func (s *Server) handleUpdateSetting(x *c) error {
	name := x.r.PathValue("name")
	var value json.RawMessage
	if err := json.NewDecoder(http.MaxBytesReader(x.w, x.r.Body, 1<<20)).Decode(&value); err != nil {
		return errBad("the body must be the setting's JSON value")
	}
	if s.settings.FromEnv(x.ctx(), name) {
		return &engine.Error{Code: engine.CodeConflict, Message: fmt.Sprintf("%s is set by the environment variable %s, which wins; change it there", name, settings.EnvName(name))}
	}
	if err := s.keepsADoor(x, name, value); err != nil {
		return err
	}
	if err := s.settings.Set(x.ctx(), name, value, x.user.ID); err != nil {
		return err
	}
	// The record says what it was set to, with anything secret blanked;
	// a setting that cannot be read back is recorded without its value.
	all, err := s.settings.List(x.ctx())
	s.audit(x.r, "", x.user, "setting.changed", "setting", name, all[name])
	if err != nil {
		return err
	}
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
	if b.To == "" {
		return &engine.Error{Code: engine.CodeInvalid, Field: "to", Message: "say where to send it: your account has no email address"}
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
		return err
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
			admins, err := s.st.Count(ctx, "users", store.Eq("is_admin", true), store.Live, store.Null("disabled_at"))
			if err != nil {
				return err
			}
			if admins <= 1 {
				return &engine.Error{Code: engine.CodeConflict, Message: "an install needs someone to run it: make someone else an admin first"}
			}
		}
		set["is_admin"] = *b.IsAdmin
	}
	if len(set) == 0 {
		return x.ok(u)
	}
	disabling := b.Disabled != nil && *b.Disabled
	// A disabled account is signed out everywhere and its tokens end, in
	// the same write: it is not disabled while they still work.
	err := s.st.Atomic(ctx, func(db store.DB) error {
		if _, err := db.Update(ctx, "users", set, store.Eq("id", u.ID)); err != nil {
			return err
		}
		if disabling {
			return revokeAccess(ctx, db, u.ID)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if disabling {
		s.accessChanged()
	}
	s.audit(x.r, "", x.user, "user.changed", "user", u.ID, b)
	if err := s.st.Get(ctx, &u, store.Eq("id", u.ID)); err != nil {
		return err
	}
	return x.ok(u)
}

// revokeAccess ends every session and token of a person.
func revokeAccess(ctx context.Context, db store.DB, userID string) error {
	now := time.Now().UnixMilli()
	if _, err := db.Update(ctx, "sessions", map[string]any{"revoked_at": now}, store.Eq("user_id", userID), store.Null("revoked_at")); err != nil {
		return err
	}
	_, err := db.Update(ctx, "api_tokens", map[string]any{"revoked_at": now}, store.Eq("user_id", userID), store.Null("revoked_at"))
	return err
}

// handleListWorkspaces lists every workspace on the install, with how many
// members and tasks each has.
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
		var err error
		if out[i].Members, err = s.st.Count(ctx, "members", store.Eq("workspace_id", ws.ID), store.Null("removed_at")); err != nil {
			return err
		}
		if out[i].Tasks, err = s.st.Count(ctx, "tasks", store.Eq("workspace_id", ws.ID), store.Live); err != nil {
			return err
		}
	}
	return x.ok(map[string]any{"workspaces": out})
}

// handleRestoreWorkspace brings a deleted workspace back, within the 30 days
// before it is removed for good.
func (s *Server) handleRestoreWorkspace(x *c) error {
	ctx := x.ctx()
	var ws core.Workspace
	if err := s.st.Get(ctx, &ws, store.Eq("id", x.r.PathValue("id"))); err != nil {
		return err
	}
	if ws.DeletedAt == 0 {
		return x.ok(map[string]any{"workspace": ws})
	}
	if n, err := s.st.Count(ctx, "workspaces", store.Eq("slug", ws.Slug), store.Live); err != nil {
		return err
	} else if n > 0 {
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
	there, err := store.Find(ctx, s.st, &ws, store.Eq("id", x.r.PathValue("id")), store.Live)
	if err != nil {
		return err
	}
	if !there {
		if err := s.st.Get(ctx, &ws, store.Eq("slug", x.r.PathValue("id")), store.Live); err != nil {
			return err
		}
	}
	db := s.st.In(ws.ID)
	if n, err := db.Count(ctx, "members", store.Eq("user_id", x.user.ID), store.Null("removed_at")); err != nil {
		return err
	} else if n > 0 {
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
	err = s.eng.System(ctx, ws.ID, owners[0].UserID, func(sys *engine.Sys) error {
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
	counts := []struct {
		key   string
		table string
		where []store.Cond
	}{
		{"jobs_waiting", "jobs", []store.Cond{store.Null("done_at")}},
		{"jobs_failing", "jobs", []store.Cond{store.Null("done_at"), store.Gt("attempts", 2)}},
		{"webhooks_failing", "webhooks", []store.Cond{store.Live, store.Gt("failures", 0)}},
		{"sources_failing", "doc_sources", []store.Cond{store.Live, store.Ne("last_error", "")}},
		{"integrations_failing", "integrations", []store.Cond{store.Live, store.Ne("last_error", "")}},
	}
	for _, count := range counts {
		n, err := s.st.Count(ctx, count.table, count.where...)
		if err != nil {
			return err
		}
		out[count.key] = n
	}
	out["deliveries_dead"] = liveDeliveries(ctx, s.st, store.Eq("state", core.DeliveryDead))
	out["deliveries_pending"] = liveDeliveries(ctx, s.st, store.Eq("state", core.DeliveryPending))
	var backups []core.Backup
	if err := s.st.List(ctx, &backups, store.Q{Order: "-started_at", Limit: 1}); err == nil && len(backups) > 0 {
		out["last_backup"] = backups[0]
	}
	return x.ok(out)
}

// keepsADoor refuses a change to the sign-in settings that would leave the
// one making it with no way to sign in: turning passwords off needs a
// passkey or a provider account of theirs that still works. The local
// owner of a server the desktop app runs always has the app.
func (s *Server) keepsADoor(x *c, name string, value json.RawMessage) error {
	if name != "auth.password" && name != "auth.passkeys" && !signInSetting(name) {
		return nil
	}
	ctx := x.ctx()
	if s.cfg.AppKey != "" {
		var localOwner string
		if err := s.settings.Checked(ctx, localOwnerSetting, &localOwner); err != nil {
			return err
		}
		if localOwner == x.user.ID {
			return nil
		}
	}
	change := settingChange{name: name, value: value}
	if on, err := s.doorOn(ctx, change, "auth.password", true); err != nil {
		return err
	} else if on && x.user.PasswordHash != "" {
		return nil
	}
	if on, err := s.doorOn(ctx, change, "auth.passkeys", true); err != nil {
		return err
	} else if on {
		n, err := s.st.Count(ctx, "passkeys", store.Eq("user_id", x.user.ID))
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
	}
	for _, p := range signInProviders {
		on, err := s.doorOn(ctx, change, "auth."+p.ID(), false)
		if err != nil {
			return err
		}
		if !on {
			continue
		}
		n, err := s.st.Count(ctx, "identities", store.Eq("user_id", x.user.ID), store.Eq("provider", p.ID()))
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
	}
	return &engine.Error{Code: engine.CodeConflict, Message: "this would leave you with no way to sign in: first add a passkey, or sign in once with a provider that stays on"}
}

// settingChange is a setting about to be saved with a new value.
type settingChange struct {
	name  string
	value json.RawMessage
}

// doorOn reports whether a way of signing in would be on after a change:
// the setting being changed as it would be, any other as it is.
func (s *Server) doorOn(ctx context.Context, change settingChange, setting string, def bool) (bool, error) {
	if setting == change.name {
		return changedSettingOn(setting, change.value, def), nil
	}
	if signInSetting(setting) {
		cfg, ok := s.oauthConfig(ctx, strings.TrimPrefix(setting, "auth."))
		return ok && cfg.Enabled, nil
	}
	return s.settings.CheckedBool(ctx, setting, def)
}

// changedSettingOn reads whether a sign-in setting's new value turns it on:
// a bool, or an object with "enabled".
func changedSettingOn(setting string, value json.RawMessage, def bool) bool {
	if strings.TrimSpace(string(value)) == "null" {
		// Back to the default: passwords and passkeys on, a provider off.
		return (setting == "auth.password" || setting == "auth.passkeys") && def
	}
	var b bool
	if json.Unmarshal(value, &b) == nil {
		return b
	}
	var v struct {
		Enabled *bool `json:"enabled"`
	}
	if json.Unmarshal(value, &v) == nil && v.Enabled != nil {
		return *v.Enabled
	}
	return false
}
