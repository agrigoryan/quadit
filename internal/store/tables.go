// The registry of tables, which row struct is stored in which
// table, and the order tables are loaded in.
//
// Adding a table takes four steps:
//
//  1. A migration that creates it: a new file with the next number in
//     internal/store/sqlstore/migrations (docs/store.md; released files
//     are never edited).
//  2. Its row struct in package core, one field per column, tagged
//     `db:"col"`, `db:"col,null"` or `db:"col,json"` (the rules are in
//     internal/store/sqlstore/record.go). A table of a workspace has a
//     workspace_id column.
//  3. An entry in the list in init below: register[core.Thing]("things",
//     ws), or global for a table outside workspaces.
//  4. The entry's place in that list: it is the order a backup is loaded
//     back in (and the reverse is the order a workspace is purged in), so
//     a table goes after every table it refers to.
//
// A backup takes every registered table; nothing else lists them.

package store

import (
	"reflect"
	"sort"

	"github.com/agrigoryan/quadit/internal/core"
)

// Table is one registry entry: where a row type is stored.
type Table struct {
	Name string       // the table's name in the database
	Type reflect.Type // the row struct of package core
	// Global tables sit outside workspaces: a workspace-bound DB does not
	// limit them.
	Global bool
}

var (
	byType    = map[reflect.Type]*Table{}
	byName    = map[string]*Table{}
	loadOrder = map[string]int{} // table name -> its place in the registry
)

// register adds the table of row type T. Tables are registered parents
// first, which makes the order they are registered in the load order.
func register[T any](name string, global bool) {
	t := &Table{Name: name, Type: reflect.TypeFor[T](), Global: global}
	byType[t.Type] = t
	byName[name] = t
	loadOrder[name] = len(loadOrder)
}

// TableOf returns the table of a registered row type.
func TableOf(t reflect.Type) (*Table, bool) { tb, ok := byType[t]; return tb, ok }

// TableNamed returns a registered table by name.
func TableNamed(name string) (*Table, bool) { tb, ok := byName[name]; return tb, ok }

// Tables lists every registered table, in an order that is safe to load (a
// table comes after the tables it refers to).
func Tables() []*Table {
	out := make([]*Table, 0, len(byName))
	for _, t := range byName {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return loadOrder[out[i].Name] < loadOrder[out[j].Name] })
	return out
}

func init() {
	const ws, global = false, true
	register[core.Workspace]("workspaces", global)
	register[core.User]("users", global)
	register[core.Member]("members", ws)
	register[core.APIToken]("api_tokens", ws)
	register[core.Project]("projects", ws)
	register[core.Status]("statuses", ws)
	register[core.Label]("labels", ws)
	register[core.Epic]("epics", ws)
	register[core.Milestone]("milestones", ws)
	register[core.Cycle]("cycles", ws)
	register[core.Task]("tasks", ws)
	register[core.TaskLabel]("task_labels", ws)
	register[core.Relation]("task_relations", ws)
	register[core.Decision]("decisions", ws)
	register[core.Option]("decision_options", ws)
	register[core.Doc]("docs", ws)
	register[core.Block]("doc_blocks", ws)
	register[core.DocVersion]("doc_versions", ws)
	register[core.DBProperty]("db_properties", ws)
	register[core.DBView]("db_views", ws)
	register[core.DocSource]("doc_sources", ws)
	register[core.Comment]("comments", ws)
	register[core.Event]("events", ws)
	register[core.AppliedChange]("changes", ws)
	register[core.Cursor]("cursors", ws)
	register[core.View]("views", ws)
	register[core.Watcher]("watchers", ws)
	register[core.Notification]("notifications", ws)
	register[core.TaskLink]("task_links", ws)
	register[core.Ref]("refs", ws)
	register[core.Template]("templates", ws)
	register[core.Preference]("preferences", ws)
	register[core.File]("files", ws)
	register[core.Attachment]("attachments", ws)
	register[core.Session]("sessions", global)
	register[core.Identity]("identities", global)
	register[core.Passkey]("passkeys", global)
	register[core.RecoveryCode]("recovery_codes", global)
	register[core.Invite]("invites", global)
	register[core.OneTimeToken]("one_time_tokens", global)
	register[core.Setting]("settings", global)
	register[core.AuditEntry]("audit_log", global)
	register[core.RateCounter]("rate_counters", global)
	register[core.PushSubscription]("push_subscriptions", global)
	register[core.OAuthClient]("oauth_clients", global)
	register[core.Backup]("backups", global)
	register[core.Webhook]("webhooks", ws)
	register[core.WebhookDelivery]("webhook_deliveries", ws)
	register[core.Rule]("rules", ws)
	register[core.Job]("jobs", global)
	register[core.AgentSession]("agent_sessions", ws)
	register[core.Resource]("resources", ws)
	register[core.ResourceClaim]("resource_claims", ws)
	register[core.Integration]("integrations", ws)
	register[core.Secret]("secrets", ws)
	register[core.Presence]("doc_presence", ws)
	register[core.TaskKey]("task_keys", ws)
}
