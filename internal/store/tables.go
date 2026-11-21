// The registry of tables, which row struct is stored in which
// table, and the order tables are loaded in.
//
// Adding a table takes four steps:
//
//  1. A migration that creates it: a new file with the next number in
//     internal/store/sqlstore/migrations (released files are never
//     edited: see TestMigrationsAreFrozen).
//  2. Its row struct in package core, one field per column, tagged
//     `db:"col"`, `db:"col,null"` or `db:"col,json"` (the rules are in
//     internal/store/sqlstore/record.go). A table of a workspace has a
//     workspace_id column.
//  3. An entry in the list below: table[core.Thing]("things", "thing",
//     inWorkspace), or global for a table outside workspaces.
//  4. The entry's place in that list: it is the order a backup is loaded
//     back in (and the reverse is the order a workspace is purged in), so
//     a table goes after every table it refers to.
//
// A backup takes every registered table; nothing else lists them.

package store

import (
	"reflect"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
)

// Table is one registry entry: where a row type is stored.
type Table struct {
	Name string       // the table's name in the database
	Type reflect.Type // the row struct of package core
	// Noun is what a person calls one row ("task", "invitation"): the
	// words of the error when one is not found.
	Noun string
	// Global tables sit outside workspaces: a workspace-bound DB does not
	// limit them.
	Global bool
}

// Where a table is: inside workspaces, or outside them (Table.Global).
const inWorkspace, global = false, true

// tables is every table, in the order a backup loads them back (the
// reverse is the order a workspace is purged in): a table comes after
// every table it refers to.
var tables = []*Table{
	table[core.Workspace]("workspaces", "workspace", global),
	table[core.User]("users", "user", global),
	table[core.Member]("members", "member", inWorkspace),
	table[core.APIToken]("api_tokens", "token", inWorkspace),
	table[core.ConnectCode]("connect_codes", "connect code", inWorkspace),
	table[core.Project]("projects", "project", inWorkspace),
	table[core.Status]("statuses", "status", inWorkspace),
	table[core.Label]("labels", "label", inWorkspace),
	table[core.Epic]("epics", "epic", inWorkspace),
	table[core.Milestone]("milestones", "milestone", inWorkspace),
	table[core.Cycle]("cycles", "cycle", inWorkspace),
	table[core.Task]("tasks", "task", inWorkspace),
	table[core.TaskLabel]("task_labels", "task label", inWorkspace),
	table[core.Relation]("task_relations", "relation", inWorkspace),
	table[core.Decision]("decisions", "decision", inWorkspace),
	table[core.Option]("decision_options", "option", inWorkspace),
	table[core.Doc]("docs", "page", inWorkspace),
	table[core.Block]("doc_blocks", "block", inWorkspace),
	table[core.DocVersion]("doc_versions", "version", inWorkspace),
	table[core.DBProperty]("db_properties", "property", inWorkspace),
	table[core.DBView]("db_views", "database view", inWorkspace),
	table[core.DocSource]("doc_sources", "source", inWorkspace),
	table[core.Comment]("comments", "comment", inWorkspace),
	table[core.Event]("events", "event", inWorkspace),
	table[core.AppliedChange]("changes", "change", inWorkspace),
	table[core.Cursor]("cursors", "cursor", inWorkspace),
	table[core.View]("views", "view", inWorkspace),
	table[core.Watcher]("watchers", "watcher", inWorkspace),
	table[core.Notification]("notifications", "notification", inWorkspace),
	table[core.TaskLink]("task_links", "link", inWorkspace),
	table[core.Ref]("refs", "reference", inWorkspace),
	table[core.Template]("templates", "template", inWorkspace),
	table[core.Preference]("preferences", "preference", inWorkspace),
	table[core.File]("files", "file", inWorkspace),
	table[core.Attachment]("attachments", "attachment", inWorkspace),
	table[core.Session]("sessions", "session", global),
	table[core.Identity]("identities", "connected account", global),
	table[core.Passkey]("passkeys", "passkey", global),
	table[core.RecoveryCode]("recovery_codes", "recovery code", global),
	table[core.Invite]("invites", "invitation", global),
	table[core.OneTimeToken]("one_time_tokens", "one-time link", global),
	table[core.Setting]("settings", "setting", global),
	table[core.AuditEntry]("audit_log", "audit entry", global),
	table[core.RateCounter]("rate_counters", "rate counter", global),
	table[core.PushSubscription]("push_subscriptions", "push subscription", global),
	table[core.OAuthClient]("oauth_clients", "OAuth client", global),
	table[core.Backup]("backups", "backup", global),
	table[core.Webhook]("webhooks", "webhook", inWorkspace),
	table[core.WebhookDelivery]("webhook_deliveries", "delivery", inWorkspace),
	table[core.Rule]("rules", "rule", inWorkspace),
	table[core.Job]("jobs", "job", global),
	table[core.AgentSession]("agent_sessions", "agent session", inWorkspace),
	table[core.Resource]("resources", "resource", inWorkspace),
	table[core.ResourceClaim]("resource_claims", "claim", inWorkspace),
	table[core.Integration]("integrations", "integration", inWorkspace),
	table[core.Secret]("secrets", "secret", inWorkspace),
	table[core.Presence]("doc_presence", "presence", inWorkspace),
	table[core.TaskKey]("task_keys", "task key", inWorkspace),
}

// table is the entry of row type T.
func table[T any](name, noun string, isGlobal bool) *Table {
	return &Table{Name: name, Type: reflect.TypeFor[T](), Noun: noun, Global: isGlobal}
}

var byType, byName = indexTables()

// indexTables finds the tables by row type and by name.
func indexTables() (map[reflect.Type]*Table, map[string]*Table) {
	byType, byName := map[reflect.Type]*Table{}, map[string]*Table{}
	for _, t := range tables {
		byType[t.Type], byName[t.Name] = t, t
	}
	return byType, byName
}

// TableOf returns the table of a registered row type.
func TableOf(t reflect.Type) (*Table, bool) { tb, ok := byType[t]; return tb, ok }

// TableNamed returns a registered table by name.
func TableNamed(name string) (*Table, bool) { tb, ok := byName[name]; return tb, ok }

// Tables lists every registered table, in an order that is safe to load (a
// table comes after the tables it refers to).
func Tables() []*Table { return slices.Clone(tables) }
