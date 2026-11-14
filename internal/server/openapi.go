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
	{"GET", "/decisions", "The decision log.", "state: answered, open, picked, sent_back, all; project; q; asked; limit; offset", "find"},
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
func (s *Server) hOpenAPI(w http.ResponseWriter, r *http.Request) {
	paths := map[string]map[string]any{}
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
