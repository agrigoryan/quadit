package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
)

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/openapi.json", s.hOpenAPI)
	})
}

// op is one operation of the API, described for the OpenAPI document.
type op struct {
	Method, Path, Summary string
	Query                 string // "name: what it does; name2: …"
	Tag                   string
}

const taskFilters = "project: key; assignee: me, @handle or none; status: name or category; open: true; waiting_on: me or @handle; label: name; " +
	"epic: name or none; cycle: current, next, number or none; priority: 1-4; has_open_decision: true; asked: member; changed_since: feed position; " +
	"mentions: member; watching: true; q: text in the title; parent: task key; sort: created, -created, rank, priority, due, -activity, -updated, key; limit; offset"

// apiOps is the read surface and the few write endpoints that are not
// changes. Every other write is a change, described from the engine's catalog.
var apiOps = []op{
	{"POST", "/changes", "Apply one change, or a batch that succeeds or fails together. Body: {id, type, args} or {changes: […], dry_run}. " +
		"The id is made by the caller; sending the same id again applies nothing twice.", "events: true to get the events back; dry_run: true to check without writing", "write"},
	{"GET", "/me", "Who am I: role, projects, what needs approval, budget left, unread count, feed position, cursors.", "", "orient"},
	{"GET", "/my-work", "What waits on me, questions asked of me, tasks assigned to me, my unread inbox.", "", "orient"},
	{"GET", "/projects/{key}/layout", "A project's statuses, labels, members, epics, cycles and templates, by name.", "", "orient"},
	{"GET", "/tasks", "Find tasks. All filters combine.", taskFilters + "; view: a saved view's slug; count: true for the number only; fields: comma-separated; raw: true for stored rows", "find"},
	{"GET", "/tasks/{ref}", "One task with decisions, comments, sub-tasks, relations, links and files.", "since: feed position, to get only what changed after it; full: true to not cut long text; max_chars; raw: true", "find"},
	{"GET", "/tasks/{ref}/context", "The context pack: the task, its parents, epic, standing preferences, recent decisions, linked docs.", "full: true", "find"},
	{"GET", "/search", "Full-text search across tasks, decisions, comments and docs.", "q: text; kind: task, comment, decision, doc; limit", "find"},
	{"GET", "/decisions", "The decision log.", "state: answered, open, picked, sent_back, all; project; q; asked; trash: true for deleted ones; limit; offset", "find"},
	{"POST", "/import", "Import work from an uploaded export or a service. Body: {kind, file | source, options: {project, token, workspace}, dry_run}. Kinds: linear, asana, trello, notion, obsidian, markdown, github, orbit. Admins.", "", "admin"},
	{"GET", "/audit", "This workspace's part of the audit log, newest first. Admins.", "action; actor; cursor: the last id seen; limit; format: csv", "admin"},
	{"GET", "/secrets", "The secrets the caller may use: names, hosts and what they are for. Values are never returned.", "", "secrets"},
	{"POST", "/secrets/{name}/request", "Make an HTTP request with a secret the caller cannot read. Body: {method, url, headers, body}; write {{secret}} where the value belongs. Only to the secret's hosts; redirects are not followed; the value is blanked out of the answer.", "", "secrets"},
	{"POST", "/secrets/env", "For a companion's token made for secrets: the values of secrets marked env. Body: {names}.", "", "secrets"},
	{"GET", "/inbox", "The caller's inbox.", "all: true to include read items; limit", "find"},
	{"GET", "/events", "The change feed after a position. wait holds the request until something matching arrives. Task filters narrow it to the events of matching tasks.",
		"after: feed position; cursor: name of a server-kept cursor; ack: move that cursor to this position first; wait: seconds, up to 55; mine: true; others: true; " +
			"inbox: true; task: key; types: comma-separated; compact: true for one line per event; limit; " + taskFilters, "follow"},
	{"GET", "/events/stream", "The live stream (server-sent events), one message per feed event.", "after: feed position", "follow"},
	{"GET", "/cursors/{name}", "Where a server-kept cursor stands.", "", "follow"},
	{"PUT", "/cursors/{name}", "Mark the feed handled up to a position. Body: {seq}. A cursor never moves back.", "", "follow"},
	{"GET", "/bootstrap", "The whole workspace as rows, for a client that keeps a local copy and then follows the feed.", "", "sync"},
	{"GET", "/list/{collection}", "Rows of one kind as stored: members, projects, statuses, labels, epics, milestones, cycles, views, templates, preferences, resources, claims, sessions, relations, links, webhooks, deliveries, rules, integrations.",
		"project; task; trash: true; limit; offset", "sync"},
	{"GET", "/dashboard", "Where everything stands: waiting on me, epics with progress, flow, agents, recent decisions, health.", "project: key", "oversight"},
	{"GET", "/agents", "What every agent is doing now, and whether anything is listening for it.", "", "oversight"},
	{"GET", "/cycles/{id}/chart", "A cycle's scope against done, day by day.", "", "oversight"},
	{"GET", "/docs", "The page tree.", "", "docs"},
	{"GET", "/docs/{id}", "One page: rows for the editor, or Markdown with format=md.", "format: md or text; full: true", "docs"},
	{"GET", "/docs/{id}/versions", "A page's kept versions.", "", "docs"},
	{"GET", "/docs/{id}/versions/{version}", "One version's content.", "format: md", "docs"},
	{"GET", "/docs/{id}/rows", "A database's rows with formulas and rollups worked out.", "filter: Prop:op:value, comma-separated; sort: Prop or -Prop; view: name", "docs"},
	{"POST", "/docs/{id}/presence", "Say which block I am in; returns who else is in the page. Body: {block}.", "", "docs"},
	{"GET", "/memory", "An agent's notes from earlier sessions, as Markdown.", "agent: @handle (default: the caller)", "docs"},
	{"POST", "/memory", "Save a note: {title, markdown, mode}.", "", "docs"},
	{"POST", "/files", "Upload a file: the body is the file, or a multipart form with a file field. With size= a large file continues with PATCH.", "name: file name; size: full size in bytes, for an upload in parts", "files"},
	{"PATCH", "/files/{id}", "Send the next part of an upload.", "offset: bytes already received", "files"},
	{"GET", "/files/{id}", "A file's details and addresses.", "", "files"},
	{"GET", "/render", "A PNG of a task or page as a person sees it.", "task: key; doc: id; width: 390 for a phone, 1280 for a desktop; theme: dark; full: true", "files"},
	{"GET", "/tokens", "API tokens (one's own; all of them for admins).", "", "admin"},
	{"POST", "/tokens", "Issue a token: {user, name, read_only, projects, expires_days}. The token is in the answer once.", "", "admin"},
	{"DELETE", "/tokens/{id}", "Revoke a token at once.", "", "admin"},
	{"GET", "/invites", "Open invitations.", "", "admin"},
	{"POST", "/invites", "Invite by link or email: {email, role, expires_days, max_uses}.", "", "admin"},
	{"GET", "/audit", "The workspace's audit log.", "action; actor; before; after; limit; format: csv", "admin"},
	{"GET", "/export", "The whole workspace as a zip of Markdown, JSON and the original files.", "", "admin"},
}

// hOpenAPI describes the API as an OpenAPI 3.1 document, built from the
// routes above and the engine's catalog of changes.
// installOps are the calls outside any workspace: accounts and sign-in, and
// the install's own administration. An agent seldom needs them; a script
// that sets an install up does.
var installOps = []op{
	{"GET", "/auth/config", "What this install offers for signing in, and whether it has been set up.", "", "account"},
	{"POST", "/auth/setup", "First run: make the first person and workspace. Body: {name, email, password, workspace_name}.", "", "account"},
	{"POST", "/auth/login", "Sign in with email and password. Body: {email, password}. Answers with a session cookie; with two-step on, the second step follows.", "", "account"},
	{"POST", "/auth/second-step", "Finish signing in with an authenticator code or a recovery code. Body: {code}.", "", "account"},
	{"POST", "/auth/logout", "Sign out of this session.", "", "account"},
	{"GET", "/auth/me", "The signed-in account and the workspaces it is in.", "", "account"},
	{"PATCH", "/auth/me", "Change the profile: {name, avatar, timezone, theme, locale}; {email, password} changes the sign-in address.", "", "account"},
	{"POST", "/auth/password", "Change the password. Body: {current, password}. Signed in only.", "", "account"},
	{"POST", "/auth/register", "Make an account, when open registration is on. Body: {name, email, password}.", "", "account"},
	{"GET", "/auth/invite/{token}", "What an invitation is for.", "", "account"},
	{"POST", "/auth/invite/{token}", "Accept an invitation, making an account if needed. Body: {name, email, password}.", "", "account"},
	{"POST", "/auth/reset/request", "Ask for a password reset by mail. Body: {email}.", "", "account"},
	{"POST", "/auth/reset/confirm", "Set a new password with the mailed token. Body: {token, password}.", "", "account"},
	{"GET", "/auth/sessions", "The devices signed in to this account.", "", "account"},
	{"DELETE", "/auth/sessions/{id}", "Sign one device out.", "", "account"},
	{"POST", "/auth/totp/start", "Begin setting up two-step codes; answers with the secret to scan.", "", "account"},
	{"POST", "/auth/totp/enable", "Turn two-step on with a first code. Body: {code}. Answers with recovery codes.", "", "account"},
	{"POST", "/auth/totp/disable", "Turn two-step off. Body: {password}.", "", "account"},
	{"POST", "/auth/recovery-codes", "Make a new set of recovery codes.", "", "account"},
	{"GET", "/auth/passkeys", "The account's passkeys.", "", "account"},
	{"GET", "/auth/identities", "The provider accounts (Google, GitHub, OpenID Connect) linked to this one.", "", "account"},
	{"GET", "/auth/oauth/{provider}/start", "Begin signing in with a provider: google, github or oidc.", "", "account"},
	{"POST", "/workspaces", "Make a workspace. Body: {name, slug}.", "", "account"},
	{"GET", "/push/key", "The key a browser needs to subscribe to push notifications.", "", "account"},
	{"POST", "/push/subscriptions", "Register this browser for push. Body: the browser's subscription {endpoint, keys}.", "", "account"},
	{"POST", "/push/test", "Send a test notification to this account's browsers.", "", "account"},
	{"GET", "/admin/settings", "The install's settings; secrets are blanked.", "", "install"},
	{"PUT", "/admin/settings/{name}", "Set one setting. Body: its JSON value.", "", "install"},
	{"POST", "/admin/mail/test", "Send a test message through the mail server. Body: {to}.", "", "install"},
	{"GET", "/admin/users", "Every account on the install.", "kind: person or agent", "install"},
	{"PATCH", "/admin/users/{id}", "Disable or enable an account, or change who runs the install. Body: {disabled, is_admin}.", "", "install"},
	{"GET", "/admin/workspaces", "Every workspace, deleted ones included for the 30 days they can be restored.", "", "install"},
	{"POST", "/admin/workspaces/{id}/join", "Become an admin of a workspace, on the record.", "", "install"},
	{"POST", "/admin/workspaces/{id}/restore", "Bring a deleted workspace back.", "", "install"},
	{"GET", "/admin/audit", "The install's audit log, newest first.", "action: a name, * for any run of letters; actor; workspace; cursor: the last id seen; limit; format: csv", "install"},
	{"GET", "/admin/health", "What is failing or waiting behind the scenes.", "", "install"},
	{"GET", "/admin/backups", "The backups taken.", "", "install"},
	{"POST", "/admin/backups", "Take a backup now.", "", "install"},
	{"POST", "/admin/backups/{id}/restore-item", "Bring one task or page back from a backup, as it was then. Body: {workspace, task} or {workspace, doc}.", "", "install"},
}

func (s *Server) hOpenAPI(w http.ResponseWriter, r *http.Request) {
	paths := map[string]map[string]any{}
	for _, o := range installOps {
		path := "/api/v1" + o.Path
		params := []map[string]any{}
		for _, seg := range strings.Split(o.Path, "/") {
			if strings.HasPrefix(seg, "{") {
				params = append(params, map[string]any{"name": strings.Trim(seg, "{}"), "in": "path", "required": true, "schema": map[string]string{"type": "string"}})
			}
		}
		for _, q := range strings.Split(o.Query, ";") {
			if name, desc, _ := strings.Cut(strings.TrimSpace(q), ":"); name != "" {
				params = append(params, map[string]any{"name": name, "in": "query", "schema": map[string]string{"type": "string"}, "description": strings.TrimSpace(desc)})
			}
		}
		if paths[path] == nil {
			paths[path] = map[string]any{}
		}
		paths[path][strings.ToLower(o.Method)] = map[string]any{"summary": o.Summary, "tags": []string{o.Tag}, "parameters": params,
			"responses": map[string]any{
				"200":     map[string]any{"description": "JSON."},
				"default": map[string]any{"description": "A refusal.", "content": map[string]any{"application/json": map[string]any{"schema": map[string]string{"$ref": "#/components/schemas/Error"}}}},
			}}
	}
	for _, o := range apiOps {
		path := "/api/v1/w/{workspace}" + o.Path
		params := []map[string]any{{"name": "workspace", "in": "path", "required": true, "schema": map[string]string{"type": "string"},
			"description": "The workspace's slug, or - for the workspace of the token used."}}
		for _, seg := range strings.Split(o.Path, "/") {
			if strings.HasPrefix(seg, "{") {
				params = append(params, map[string]any{"name": strings.Trim(seg, "{}"), "in": "path", "required": true, "schema": map[string]string{"type": "string"}})
			}
		}
		for _, q := range strings.Split(o.Query, ";") {
			name, desc, _ := strings.Cut(strings.TrimSpace(q), ":")
			if name == "" {
				continue
			}
			params = append(params, map[string]any{"name": name, "in": "query", "schema": map[string]string{"type": "string"}, "description": strings.TrimSpace(desc)})
		}
		item := map[string]any{"summary": o.Summary, "tags": []string{o.Tag}, "parameters": params,
			"responses": map[string]any{
				"200":     map[string]any{"description": "JSON, or one line per item as text/plain when format=text or Accept: text/plain."},
				"default": map[string]any{"description": "A refusal.", "content": map[string]any{"application/json": map[string]any{"schema": map[string]string{"$ref": "#/components/schemas/Error"}}}},
			}}
		if o.Path == "/changes" {
			item["requestBody"] = map[string]any{"required": true, "content": map[string]any{"application/json": map[string]any{"schema": map[string]any{
				"oneOf": []map[string]string{{"$ref": "#/components/schemas/Change"}, {"$ref": "#/components/schemas/Batch"}}}}}}
		}
		if paths[path] == nil {
			paths[path] = map[string]any{}
		}
		paths[path][strings.ToLower(o.Method)] = item
	}
	// Each change type with its arguments.
	changes := []map[string]any{}
	for _, ci := range engine.Catalog() {
		props := map[string]any{}
		for _, a := range ci.Args {
			props[a.Name] = map[string]string{"description": a.Type}
		}
		changes = append(changes, map[string]any{"title": ci.Type, "description": "Least role: " + string(ci.Role), "type": "object", "properties": map[string]any{
			"id":   map[string]string{"type": "string", "description": "A UUID made by the caller."},
			"type": map[string]any{"const": ci.Type},
			"args": map[string]any{"type": "object", "properties": props, "additionalProperties": false},
		}, "required": []string{"id", "type"}})
	}
	doc := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{"title": "Quadit API", "version": s.cfg.Version, "description": "One API for people's browsers and for agents. " +
			"Reads return JSON, or compact text with format=text. Every write is a named change sent to /changes. " +
			"Names work wherever ids do: project keys, task keys (SVA-12), @handles, status and label names. " +
			"A refusal has a code, a message, the allowed values and the nearest match. Rate limits answer 429 with Retry-After."},
		"servers":  []map[string]string{{"url": s.cfg.BaseURL}},
		"security": []map[string][]string{{"token": {}}},
		"paths":    paths,
		"components": map[string]any{
			"securitySchemes": map[string]any{"token": map[string]string{"type": "http", "scheme": "bearer", "description": "An API token (qd_…) issued in the workspace's settings."}},
			"schemas": map[string]any{
				"Change": map[string]any{"oneOf": changes},
				"Batch": map[string]any{"type": "object", "properties": map[string]any{"changes": map[string]any{"type": "array", "items": map[string]string{"$ref": "#/components/schemas/Change"}},
					"dry_run": map[string]string{"type": "boolean"}}},
				"Error": map[string]any{"type": "object", "properties": map[string]any{"error": map[string]any{"type": "object", "properties": map[string]any{
					"code":    map[string]any{"enum": []string{"invalid", "forbidden", "not_found", "conflict", "stale", "needs_approval", "budget_exceeded", "unauthorized", "rate_limited"}},
					"message": map[string]string{"type": "string"}, "field": map[string]string{"type": "string"},
					"allowed": map[string]any{"type": "array", "items": map[string]string{"type": "string"}}, "nearest": map[string]string{"type": "string"},
					"index": map[string]string{"type": "integer", "description": "Which change of a batch was refused."}}}}},
			},
		},
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", " ")
	enc.Encode(doc)
}
