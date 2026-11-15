package mcp

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// The MCP tools: their list, what each takes, and the API path most of them read.

// tool is one tool: what it is called, what it takes, and how it maps
// onto the API.
type tool struct {
	Name  string
	Desc  string
	Props map[string]string // argument -> description; a leading "!" marks it required
	Run   func(c caller, a map[string]any) (string, bool)
}

// pictureMark starts the result of a tool that answers with a PNG, base64 after it.
const pictureMark = "\x00png:"

// The tools, in the order a client is shown them. Most read one API path
// (get); the ones that do more are in calls.go.
var tools = []tool{
	{Name: "whoami", Desc: "Who am I: role, projects, what needs approval, budget left, unread count, feed position. Call first in a session.", Run: readPathTool("/me")},
	{Name: "my_work", Desc: "What waits on me, questions asked of me, tasks assigned to me, and my unread inbox. One line each.", Run: readPathTool("/my-work")},
	{Name: "tasks", Desc: "Find tasks. All filters combine. Returns one line per task; count=true returns only the number.",
		Props: map[string]string{"project": "project key", "assignee": "me, @handle or none", "status": "status name or category (backlog, unstarted, started, waiting, done, canceled)",
			"open": "true for not done and not canceled", "waiting_on": "me or @handle", "label": "label name", "epic": "epic name, or none", "cycle": "current, next, a number, or none",
			"priority": "1 urgent, 2 high, 3 medium, 4 low", "has_open_decision": "true", "asked": "tasks with an open question asked of this member",
			"changed_since": "feed position: tasks with any activity after it", "mentions": "me or @handle", "q": "text in the title", "parent": "task key",
			"creator": "me or @handle", "held_by": "who has taken it: me or @handle", "due_before": "YYYY-MM-DD", "due_after": "YYYY-MM-DD",
			"fields": "comma-separated fields to return instead of the line, e.g. key,title,status",
			"view":   "a saved view's slug", "sort": "created, -created, rank, priority, due, -activity, -updated, key", "limit": "default 50", "cursor": "the cursor the last page ended with, to read on", "offset": "", "count": "true"},
		Run: readPathTool("/tasks")},
	{Name: "task", Desc: "One task with its description, decisions (with numbered options), comments, sub-tasks, links and files. since=<seq> returns only what changed after that feed position.",
		Props: map[string]string{"!key": "task key, e.g. SVA-12", "since": "feed position", "full": "true to not cut long text"}, Run: readPathTool("/tasks/{key}", "key")},
	{Name: "context", Desc: "Everything needed to work on a task in one call: the task, its parents, epic, standing preferences, recent decisions in the project, linked docs.",
		Props: map[string]string{"!key": "task key"}, Run: readPathTool("/tasks/{key}/context", "key")},
	{Name: "search", Desc: "Full-text search across tasks, decisions, comments and docs.", Props: map[string]string{"!q": "text", "kind": "task, comment, decision, doc"}, Run: readPathTool("/search")},
	{Name: "inbox", Desc: "My inbox: mentions, assignments, answers to my questions, replies. Unread only unless all=true.", Props: map[string]string{"all": "true"}, Run: readPathTool("/inbox")},
	{Name: "events", Desc: "The change feed after a position, one line per event. wait=N holds the call up to N seconds until something arrives (use it instead of polling). " +
		"cursor=NAME reads from the position the server keeps for me; call ack to move it. mine=true keeps to tasks I am assigned to, mentioned in or watching; others=true hides my own changes. " +
		"The task filters of the tasks tool work here too.",
		Props: map[string]string{"after": "feed position", "cursor": "name of a server-kept cursor, e.g. main", "wait": "seconds, up to 55", "mine": "true", "others": "true",
			"task": "task key", "types": "comma-separated event types", "inbox": "true for only my inbox items", "limit": ""},
		Run: readPathTool("/events")},
	{Name: "ack", Desc: "Mark the feed handled up to a position, for a server-kept cursor.", Props: map[string]string{"!seq": "feed position", "cursor": "cursor name, default main"},
		Run: toolAck},
	{Name: "decisions", Desc: "The decision log: questions with their options, the answer, the reason and the date.",
		Props: map[string]string{"state": "answered (default), open, picked, sent_back, all", "project": "project key", "q": "text in the question", "asked": "me or @handle"}, Run: readPathTool("/decisions")},
	{Name: "layout", Desc: "A project's statuses, labels, members, agents, epics, cycles and templates, by name.", Props: map[string]string{"!project": "project key"},
		Run: readPathTool("/projects/{project}/layout", "project")},
	{Name: "docs", Desc: "The page tree with ids.", Run: readPathTool("/docs")},
	{Name: "doc", Desc: "One page as Markdown.", Props: map[string]string{"!id": "page id", "full": "true to not cut long text"}, Run: readPathTool("/docs/{id}", "id")},
	{Name: "rows", Desc: "A database's rows as a table, with formulas worked out.",
		Props: map[string]string{"!id": "database id", "filter": "Prop:op:value, comma-separated; ops: is, is_not, contains, gt, lt, empty, not_empty, checked, unchecked", "sort": "Prop or -Prop", "view": "a view's name"},
		Run:   readPathTool("/docs/{id}/rows", "id")},
	{Name: "memory", Desc: "My notes from earlier sessions (agents only). Read at the start of a session.", Run: readPathTool("/memory")},
	{Name: "remember", Desc: "Save a note to my memory: the page with this title, made if new. mode=append adds to it.",
		Props: map[string]string{"!title": "page title", "!markdown": "the note", "mode": "replace (default) or append"},
		Run:   toolRemember},
	{Name: "changes", Desc: "Every change type with its arguments. Read once to learn what change can do.", Run: readPathTool("/api/v1/changes")},
	{Name: "change", Desc: "Make one change. Common types: task.create {project, title, description, assignee, labels, parent}; task.update {id, status, assignee, waiting_on, priority, add_labels}; " +
		"task.take {id}; comment.create {task, body, waiting_on} (add evidence {checked, measured, not_verified} to post a result); " +
		"decision.open {task, question, options:[{label, description, attachments:[{file}]}], recommended, recommendation, ask} (the ask tool does this, with files, in one call); decision.pick {id, option, note}; " +
		"doc.create {title, markdown, parent}; doc.write {doc, markdown, mode}. Names work wherever ids do (SVA-12, @handle, status and label names). " +
		"Every change type with all of its arguments is listed by the changes tool (GET /api/v1/changes). " +
		"A refusal says what was wrong and lists what would have been accepted. dry_run=true checks without writing.",
		Props: map[string]string{"type": "change type, e.g. task.update", "args": "the change's arguments, an object", "approval": "id of an approved decision, when the change needs approval", "dry_run": "true",
			"id": "a UUID you make for this change; sending the same id again does nothing, so a retry is safe", "for": "@handle of the member this is done for; it then runs with their access",
			"changes": "instead of type and args: a list of {type, args} applied together, all or nothing"},
		Run: toolChange},
	{Name: "ask", Desc: "Ask a person: a choice (two or more options, each with its own files) or, with no options, a plain yes or no. " +
		"Files are ids of files stored first with upload; files gives the question's own, shown before the options. " +
		"For a change refused with needs_approval, give no options and action (and args): once approved, send that change with approval set to the decision's id. " +
		"The task then waits on the person asked; the answer comes in the feed and inbox.",
		Props: map[string]string{"!task": "task key", "!question": "the question, one line", "details": "more about it, Markdown",
			"options":     "the choices: [{label, description, files: [file ids]}], two or more; none for a yes or no",
			"files":       "ids of files shown with the question itself, before the options",
			"recommended": "the option you recommend, by number from 1 or by label", "why": "why you recommend it",
			"action": "yes or no only: the change type to be approved, e.g. task.delete", "args": "with action: the arguments that change will be sent with, an object; default {id: task}",
			"ask": "@handle of whom to ask; by default the person responsible for me", "dry_run": "true",
			"id": "a UUID you make for this question; sending the same id again does nothing twice"},
		Run: toolAsk},
	{Name: "dashboard", Desc: "Where everything stands: what waits on me, epics with progress, flow, agents, recent decisions, health.", Props: map[string]string{"project": "project key"}, Run: readPathTool("/dashboard")},
	{Name: "agents", Desc: "What every agent is doing now, what it holds, and whether anything is listening for it.", Run: readPathTool("/agents")},
	{Name: "render", Desc: "A picture of a task or a page as a person sees it, to check how work looks. Give task or doc.",
		Props: map[string]string{"task": "task key", "doc": "page id", "width": "390 for a phone, 1280 (default) for a desktop", "theme": "light or dark"},
		Run:   toolRender},
	{Name: "file", Desc: "A file's details: name, type, size, checksum, address, and whether its upload is complete.", Props: map[string]string{"!id": "file id"}, Run: readPathTool("/files/{id}", "id")},
	{Name: "secrets", Desc: "The secrets (keys, passwords) I may use, by name, with the hosts each may be sent to. Values are never shown.", Run: readPathTool("/secrets")},
	{Name: "secret_request", Desc: "Make an HTTP request with a secret I cannot read: write {{secret}} where the value belongs (a header, the URL or the body); {{basic:USER}} gives base64 of USER:secret. " +
		"It goes only to the secret's hosts, and the value is blanked out of the answer.",
		Props: map[string]string{"!name": "the secret's name", "!url": "full https address", "method": "GET (default), POST, PUT, PATCH, DELETE",
			"headers": `JSON object, e.g. {"Authorization": "Bearer {{secret}}"}`, "body": "request body, as text"},
		Run: toolSecretRequest},
	{Name: "upload", Desc: "Store a file and get its id and address. A large file goes in parts: first name, size and the first part; then id, offset and the next part, until the answer says ready. Attach it with change attachment.add {file, task|comment|decision|option}, or name it in comment.create {attachments:[{file}]}.",
		Props: map[string]string{"name": "file name with its extension", "text": "the content, as text", "base64": "or the content, base64-encoded",
			"size": "for a large file sent in parts: its total size in bytes, with the first part in base64", "id": "later parts: the file id the first answer gave", "offset": "later parts: bytes received so far"},
		Run: toolUpload},
}

// toolList is the answer to tools/list: every tool with what it takes.
func toolList() map[string]any {
	list := make([]map[string]any, len(tools))
	for i, t := range tools {
		list[i] = map[string]any{"name": t.Name, "description": t.Desc, "inputSchema": toolSchema(t)}
	}
	return map[string]any{"tools": list}
}

// toolSchema is a tool's input schema: each argument with its type and
// what it is for, and which are required.
func toolSchema(t tool) map[string]any {
	props := map[string]any{}
	required := []string{}
	for name, desc := range t.Props {
		typ := "string"
		if strings.HasPrefix(name, "!") {
			name = name[1:]
			required = append(required, name)
		}
		if name == "args" {
			typ = "object"
		}
		p := map[string]any{"type": typ}
		if name == "changes" {
			p = map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"type": map[string]any{"type": "string"}, "args": map[string]any{"type": "object"}}, "required": []string{"type"}}}
			typ = "array"
		}
		if name == "options" {
			p, typ = map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
				"label": map[string]any{"type": "string"}, "description": map[string]any{"type": "string"},
				"files": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}}, "required": []string{"label"}}}, "array"
		}
		if name == "files" {
			p, typ = map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "array"
		}
		if name == "headers" {
			p, typ = map[string]any{"type": []string{"object", "string"}}, "object"
		}
		if typ == "string" {
			// Numbers and true/false are welcome too; they are read as text.
			p = map[string]any{"type": []string{"string", "number", "boolean"}}
		}
		if desc != "" {
			p["description"] = desc
		}
		props[name] = p
	}
	// Props is a map, so it has no order of its own: the same tool is
	// described the same way every time.
	sort.Strings(required)
	return map[string]any{"type": "object", "properties": props, "required": required}
}

// readPathTool makes a tool that reads one API path in text form. Arguments named
// in path are filled into it; the rest become URL parameters.
func readPathTool(path string, pathArgs ...string) func(c caller, a map[string]any) (string, bool) {
	return func(c caller, a map[string]any) (string, bool) {
		p := path
		q := url.Values{"format": {"text"}}
		for k := range a {
			used := false
			for _, pa := range pathArgs {
				if pa == k {
					p = strings.Replace(p, "{"+k+"}", url.PathEscape(argText(a, k)), 1)
					used = true
				}
			}
			if !used && a[k] != nil && argText(a, k) != "" {
				q.Set(k, argText(a, k))
			}
		}
		if strings.Contains(p, "{") {
			return "missing argument: " + p[strings.Index(p, "{")+1:strings.Index(p, "}")], false
		}
		return c.callAPI("GET", p, q, nil)
	}
}

// argText reads an argument as text, whatever JSON type the client sent it as.
func argText(a map[string]any, k string) string {
	switch v := a[k].(type) {
	case string:
		return v
	case nil:
		return ""
	case float64:
		return strings.TrimSuffix(fmt.Sprintf("%f", v), ".000000")
	case bool:
		if v {
			return "1"
		}
		return "0"
	case []any:
		parts := make([]string, len(v))
		for i, e := range v {
			parts[i] = fmt.Sprint(e)
		}
		return strings.Join(parts, ",")
	}
	return fmt.Sprint(a[k])
}
