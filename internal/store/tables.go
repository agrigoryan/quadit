package store

import (
	"reflect"
	"sort"

	"github.com/agrigoryan/quadit/internal/core"
)

// Table describes where a row type is stored.
type Table struct {
	Name string
	Type reflect.Type
	// Global tables sit outside workspaces: a workspace-bound DB does not
	// limit them.
	Global bool
}

var (
	byType = map[reflect.Type]*Table{}
	byName = map[string]*Table{}
)

func reg[T any](name string, global bool) {
	t := &Table{Name: name, Type: reflect.TypeFor[T](), Global: global}
	byType[t.Type] = t
	byName[name] = t
}

// TableOf returns the table of a registered row type.
func TableOf(t reflect.Type) (*Table, bool) { tb, ok := byType[t]; return tb, ok }

// TableNamed returns a registered table by name.
func TableNamed(name string) (*Table, bool) { tb, ok := byName[name]; return tb, ok }

// Tables lists every registered table by name, in an order that is safe to
// load (a table comes after the tables it refers to).
func Tables() []*Table {
	out := make([]*Table, 0, len(byName))
	for _, t := range byName {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return loadOrder[out[i].Name] < loadOrder[out[j].Name] })
	return out
}

var loadOrder = map[string]int{}

func init() {
	const ws, global = false, true
	reg[core.Workspace]("workspaces", global)
	reg[core.User]("users", global)
	reg[core.Member]("members", ws)
	reg[core.APIToken]("api_tokens", ws)
	reg[core.Project]("projects", ws)
	reg[core.Status]("statuses", ws)
	reg[core.Label]("labels", ws)
	reg[core.Epic]("epics", ws)
	reg[core.Milestone]("milestones", ws)
	reg[core.Cycle]("cycles", ws)
	reg[core.Task]("tasks", ws)
	reg[core.TaskLabel]("task_labels", ws)
	reg[core.Relation]("task_relations", ws)
	reg[core.Decision]("decisions", ws)
	reg[core.Option]("decision_options", ws)
	reg[core.Doc]("docs", ws)
	reg[core.Block]("doc_blocks", ws)
	reg[core.DocVersion]("doc_versions", ws)
	reg[core.DBProperty]("db_properties", ws)
	reg[core.DBView]("db_views", ws)
	reg[core.DocSource]("doc_sources", ws)
	reg[core.Comment]("comments", ws)
	reg[core.Event]("events", ws)
	reg[core.AppliedChange]("changes", ws)
	reg[core.Cursor]("cursors", ws)
	reg[core.View]("views", ws)
	reg[core.Watcher]("watchers", ws)
	reg[core.Notification]("notifications", ws)
	reg[core.TaskLink]("task_links", ws)
	reg[core.Ref]("refs", ws)
	reg[core.Template]("templates", ws)
	reg[core.Preference]("preferences", ws)
	reg[core.File]("files", ws)
	reg[core.Attachment]("attachments", ws)
	reg[core.Session]("sessions", global)
	reg[core.Identity]("identities", global)
	reg[core.Passkey]("passkeys", global)
	reg[core.RecoveryCode]("recovery_codes", global)
	reg[core.Invite]("invites", global)
	reg[core.OneTimeToken]("one_time_tokens", global)
	reg[core.Setting]("settings", global)
	reg[core.AuditEntry]("audit_log", global)
	reg[core.RateCounter]("rate_counters", global)
	reg[core.PushSubscription]("push_subscriptions", global)
	reg[core.OAuthClient]("oauth_clients", global)
	reg[core.Backup]("backups", global)
	reg[core.Webhook]("webhooks", ws)
	reg[core.WebhookDelivery]("webhook_deliveries", ws)
	reg[core.Rule]("rules", ws)
	reg[core.Job]("jobs", global)
	reg[core.AgentSession]("agent_sessions", ws)
	reg[core.Resource]("resources", ws)
	reg[core.ResourceClaim]("resource_claims", ws)
	reg[core.Integration]("integrations", ws)
	reg[core.Secret]("secrets", ws)
	reg[core.Presence]("doc_presence", ws)
	reg[core.TaskKey]("task_keys", ws)

	// Load order for restores: parents before children.
	for i, n := range []string{"workspaces", "users", "members", "api_tokens", "projects", "statuses", "labels",
		"epics", "milestones", "cycles", "tasks", "task_labels", "task_relations", "decisions", "decision_options",
		"docs", "doc_blocks", "doc_versions", "db_properties", "db_views", "doc_sources", "comments", "events",
		"changes", "cursors", "views", "watchers", "notifications", "task_links", "refs", "templates", "preferences",
		"files", "attachments", "sessions", "identities", "passkeys", "recovery_codes", "invites", "one_time_tokens",
		"settings", "audit_log", "rate_counters", "push_subscriptions", "oauth_clients", "backups", "webhooks",
		"webhook_deliveries", "rules", "jobs", "agent_sessions", "resources", "resource_claims", "integrations", "secrets", "doc_presence", "task_keys"} {
		loadOrder[n] = i
	}
}
