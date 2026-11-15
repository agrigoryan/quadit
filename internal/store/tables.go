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
//     "thing", ws), or global for a table outside workspaces.
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
	// Noun is what a person calls one row ("task", "invitation"): the
	// words of the error when one is not found.
	Noun string
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
func register[T any](name, noun string, global bool) {
	t := &Table{Name: name, Type: reflect.TypeFor[T](), Noun: noun, Global: global}
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
	register[core.Workspace]("workspaces", "workspace", global)
	register[core.User]("users", "user", global)
	register[core.Member]("members", "member", ws)
	register[core.APIToken]("api_tokens", "token", ws)
	register[core.Project]("projects", "project", ws)
	register[core.Status]("statuses", "status", ws)
	register[core.Label]("labels", "label", ws)
	register[core.Epic]("epics", "epic", ws)
	register[core.Milestone]("milestones", "milestone", ws)
	register[core.Cycle]("cycles", "cycle", ws)
	register[core.Task]("tasks", "task", ws)
	register[core.TaskLabel]("task_labels", "task label", ws)
	register[core.Relation]("task_relations", "relation", ws)
	register[core.Decision]("decisions", "decision", ws)
	register[core.Option]("decision_options", "option", ws)
	register[core.Doc]("docs", "page", ws)
	register[core.Block]("doc_blocks", "block", ws)
	register[core.DocVersion]("doc_versions", "version", ws)
	register[core.DBProperty]("db_properties", "property", ws)
	register[core.DBView]("db_views", "database view", ws)
	register[core.DocSource]("doc_sources", "source", ws)
	register[core.Comment]("comments", "comment", ws)
	register[core.Event]("events", "event", ws)
	register[core.AppliedChange]("changes", "change", ws)
	register[core.Cursor]("cursors", "cursor", ws)
	register[core.View]("views", "view", ws)
	register[core.Watcher]("watchers", "watcher", ws)
	register[core.Notification]("notifications", "notification", ws)
	register[core.TaskLink]("task_links", "link", ws)
	register[core.Ref]("refs", "reference", ws)
	register[core.Template]("templates", "template", ws)
	register[core.Preference]("preferences", "preference", ws)
	register[core.File]("files", "file", ws)
	register[core.Attachment]("attachments", "attachment", ws)
	register[core.Session]("sessions", "session", global)
	register[core.Identity]("identities", "connected account", global)
	register[core.Passkey]("passkeys", "passkey", global)
	register[core.RecoveryCode]("recovery_codes", "recovery code", global)
	register[core.Invite]("invites", "invitation", global)
	register[core.OneTimeToken]("one_time_tokens", "one-time link", global)
	register[core.Setting]("settings", "setting", global)
	register[core.AuditEntry]("audit_log", "audit entry", global)
	register[core.RateCounter]("rate_counters", "rate counter", global)
	register[core.PushSubscription]("push_subscriptions", "push subscription", global)
	register[core.OAuthClient]("oauth_clients", "OAuth client", global)
	register[core.Backup]("backups", "backup", global)
	register[core.Webhook]("webhooks", "webhook", ws)
	register[core.WebhookDelivery]("webhook_deliveries", "delivery", ws)
	register[core.Rule]("rules", "rule", ws)
	register[core.Job]("jobs", "job", global)
	register[core.AgentSession]("agent_sessions", "agent session", ws)
	register[core.Resource]("resources", "resource", ws)
	register[core.ResourceClaim]("resource_claims", "claim", ws)
	register[core.Integration]("integrations", "integration", ws)
	register[core.Secret]("secrets", "secret", ws)
	register[core.Presence]("doc_presence", "presence", ws)
	register[core.TaskKey]("task_keys", "task key", ws)
}
