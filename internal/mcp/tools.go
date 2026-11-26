package mcp

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"net/url"
	"slices"
	"sort"
	"strings"
)

// The MCP tools: their list, what each takes, and the API path most of them read.

// tool is one tool: what it is called, what it takes, and how it maps
// onto the API.
type tool struct {
	Name  string
	Desc  string
	Props map[string]arg // argument -> its schema; a leading "!" marks it required
	Run   func(c caller, a map[string]any) (string, bool)
}

// pictureMark starts the result of a tool that answers with a PNG, base64 after it.
const pictureMark = "\x00png:"

// The tools, in the order a client is shown them. Most read one API path
// (get); the ones that do more are in calls.go.
var tools = []tool{
	{Name: "whoami", Desc: "Who am I: role, projects, what needs approval, hand-off limit, unread count, feed position. Call first in a session.", Run: readPathTool("/me")},
	{Name: "my_work", Desc: "What waits on me, questions asked of me, tasks assigned to me, and my unread inbox. One line each.", Run: readPathTool("/my-work")},
	{Name: "tasks", Desc: "Find tasks. All filters combine. Returns one line per task; count=true returns only the number.",
		Props: map[string]arg{"project": text("project key"), "assignee": text("me, @handle or none"), "status": text("status name or category (backlog, unstarted, started, waiting, done, canceled)"),
			"open": flag("true for not done and not canceled"), "waiting_on": text("me or @handle"), "label": text("label name"), "epic": text("epic name, or none"), "cycle": textOrInteger("current, next, a number, or none"),
			"priority": textOrInteger("1 urgent, 2 high, 3 medium, 4 low"), "estimate": textOrInteger("points, a T-shirt size (M) or none; comma-separated for any of them"), "has_open_decision": flag("true"), "asked": text("tasks with an open question asked of this member"),
			"changed_since": integer("feed position: tasks with any activity after it"), "mentions": text("me or @handle"), "q": text("text in the title"), "parent": text("task key"),
			"creator": text("me or @handle"), "held_by": text("who has taken it: me or @handle"), "due_before": text("YYYY-MM-DD"), "due_after": text("YYYY-MM-DD"),
			"fields": text("comma-separated fields to return instead of the line, e.g. key,title,status"),
			"view":   text("a saved view's slug"), "sort": text("created, -created, rank, priority, due, -activity, -updated, key"), "limit": integer("default 50"), "cursor": text("the cursor the last page ended with, to read on"), "offset": integer(""), "count": flag("true")},
		Run: readPathTool("/tasks")},
	{Name: "task", Desc: "One task with its description, decisions (with numbered options), comments, sub-tasks, links and files. since=<seq> returns only what changed after that feed position.",
		Props: map[string]arg{"!key": text("task key, e.g. SVA-12"), "since": integer("feed position"), "full": flag("true to not cut long text")}, Run: readPathTool("/tasks/{key}", "key")},
	{Name: "context", Desc: "Everything needed to work on a task in one call: the task, its parents, epic, standing preferences, recent decisions in the project, linked docs.",
		Props: map[string]arg{"!key": text("task key")}, Run: readPathTool("/tasks/{key}/context", "key")},
	{Name: "search", Desc: "Full-text search across tasks, decisions, comments and docs.", Props: map[string]arg{"!q": text("text"), "kind": text("task, comment, decision, doc")}, Run: readPathTool("/search")},
	{Name: "inbox", Desc: "My inbox: mentions, assignments, answers to my questions, replies. Unread only unless all=true.", Props: map[string]arg{"all": flag("true")}, Run: readPathTool("/inbox")},
	{Name: "events", Desc: "The change feed after a position, one line per event. wait=N holds the call up to N seconds until something arrives (use it instead of polling). " +
		"cursor=NAME reads from the position the server keeps for me; call ack to move it. mine=true keeps to tasks I am assigned to, mentioned in or watching; others=true hides my own changes. " +
		"The task filters of the tasks tool work here too.",
		Props: map[string]arg{"after": integer("feed position"), "cursor": text("name of a server-kept cursor, e.g. main"), "wait": integer("seconds, up to 55"), "mine": flag("true"), "others": flag("true"),
			"task": text("task key"), "types": text("comma-separated event types"), "inbox": flag("true for only my inbox items"), "limit": integer("")},
		Run: readPathTool("/events")},
	{Name: "ack", Desc: "Mark the feed handled up to a position, for a server-kept cursor.", Props: map[string]arg{"!seq": integer("feed position"), "cursor": text("cursor name, default main"), "dry_run": flag("true checks the position without moving the cursor")},
		Run: toolAck},
	{Name: "decisions", Desc: "The decision log: questions with their options, the answer, the reason and the date.",
		Props: map[string]arg{"state": text("answered (default: any but open), open, picked, sent_back, not_needed, all"), "project": text("project key"), "q": text("text in the question"), "asked": text("me or @handle")}, Run: readPathTool("/decisions")},
	{Name: "layout", Desc: "A project's statuses, labels, members, agents, epics, cycles and templates, by name, and the estimates it takes.", Props: map[string]arg{"!project": text("project key")},
		Run: readPathTool("/projects/{project}/layout", "project")},
	{Name: "docs", Desc: "The page tree with ids.", Run: readPathTool("/docs")},
	{Name: "doc", Desc: "One page as Markdown, then its open comment threads: each with its id, what it is on (words of a block, a block, or \"on the page\") and its comments and replies by whom and when. " +
		"The words a thread is on are <span data-comment=\"THREAD_ID\">words</span> in the Markdown (several threads: ids space-separated); doc.write takes the spans back, and keeps a thread on its words when a span is left out. " +
		"Reply with change comment.create {parent: thread id, body}; start a thread on words with comment.create {doc, block, quote: \"the exact words\", body} (occurrence: 2 when they are in the block more than once), on a block without quote; resolve one with comment.update {id, resolved: true}.",
		Props: map[string]arg{"!id": text("page id"), "full": flag("true to not cut long text"), "resolved": flag("true to show the resolved threads too"), "comments": flag("false to leave the threads out")},
		Run:   readPathTool("/docs/{id}", "id")},
	{Name: "rows", Desc: "A database's rows as a table, with formulas worked out.",
		Props: map[string]arg{"!id": text("database id"), "filter": text("Prop:op:value, comma-separated; ops: is, is_not, contains, gt, lt, empty, not_empty, checked, unchecked"), "sort": text("Prop or -Prop"), "view": text("a view's name")},
		Run:   readPathTool("/docs/{id}/rows", "id")},
	{Name: "memory", Desc: "My notes from earlier sessions (agents only). Read at the start of a session.", Run: readPathTool("/memory")},
	{Name: "remember", Desc: "Save a note to my memory: the page with this title, made if new. mode=append adds to it.",
		Props: map[string]arg{"!title": text("page title"), "!markdown": text("the note"), "mode": text("replace (default) or append"), "dry_run": flag("true checks the note without saving it")},
		Run:   toolRemember},
	{Name: "changes", Desc: "Every change type with its arguments. Read once to learn what change can do.", Run: readPathTool("/api/v1/changes")},
	{Name: "change", Desc: "Make one change. Common types: task.create {project, title, description, assignee, labels, parent}; task.update {id, status, assignee, waiting_on, priority, estimate, add_labels} (an estimate is points or a T-shirt size, on the project's scale; null clears it); " +
		"task.take {id}; comment.create {task, body, waiting_on} (add evidence {checked, measured, not_verified} to post a result, and attachments:[{file}] with ids from upload to show what you made: a picture, a screenshot, a clip); " +
		"comment.create {doc, block, quote, body} on words of a page (quote: the exact words of the block; occurrence: N picks one when they are there more than once), without quote on a block, without block on the page, {parent, body} to reply in a comment's thread; comment.update {id, resolved}; " +
		"decision.open {task, question, options:[{label, description, attachments:[{file}]}], recommended, recommendation, ask} (the ask tool does this, with files, in one call); decision.pick {id, option, note}; " +
		"doc.create {title, markdown, parent}; doc.write {doc, markdown, mode} (a write that takes out the words a comment thread is on says so in its warnings; the thread stays open, on the page). Names work wherever ids do (SVA-12, @handle, status and label names). " +
		"Every change type with all of its arguments is listed by the changes tool (GET /api/v1/changes). " +
		"A refusal says what was wrong and lists what would have been accepted. dry_run=true checks without writing.",
		Props: map[string]arg{"type": text("change type, e.g. task.update"), "args": object("the change's arguments, an object"), "approval": text("id of an approved decision, when the change needs approval"), "dry_run": flag("true checks without writing"),
			"id": text("a UUID you make for this change; sending the same id again does nothing, so a retry is safe"), "for": text("@handle of the member this is done for; it then runs with their access"),
			"changes": changeList("instead of type and args: a list of {type, args} applied together, all or nothing")},
		Run: toolChange},
	{Name: "ask", Desc: "Ask a person: a choice (two or more options, each with its own files) or, with no options, a plain yes or no. " +
		"Files are ids of files stored first with upload; files gives the question's own, shown before the options. " +
		"For a change refused with needs_approval, give no options and action (and args): once approved, send that change with approval set to the decision's id. " +
		"The task then waits on the person asked; the answer comes in the feed and inbox.",
		Props: map[string]arg{"!task": text("task key"), "!question": text("the question, one line"), "details": text("more about it, Markdown"),
			"options":     optionList("the choices: [{label, description, files: [file ids]}], two or more; none for a yes or no"),
			"files":       textList("ids of files shown with the question itself, before the options"),
			"recommended": textOrInteger("the option you recommend, by number from 1 or by label"), "why": text("why you recommend it"),
			"action": text("yes or no only: the change type to be approved, e.g. task.delete"), "args": object("with action: the arguments that change will be sent with, an object; default {id: task}"),
			"ask": text("@handle of whom to ask; by default the person responsible for me"), "dry_run": flag("true checks without writing"),
			"id": text("a UUID you make for this question; sending the same id again does nothing twice")},
		Run: toolAsk},
	{Name: "dashboard", Desc: "Where everything stands: what waits on me, epics with progress, flow, agents, recent decisions, and for an admin of the whole workspace its health.", Props: map[string]arg{"project": text("project key")}, Run: readPathTool("/dashboard")},
	{Name: "agents", Desc: "What every agent is doing now, what it holds, and whether anything is listening for it.", Run: readPathTool("/agents")},
	{Name: "render", Desc: "A picture of a task or a page as a person sees it, to check how work looks. Give task or doc.",
		Props: map[string]arg{"task": text("task key"), "doc": text("page id"), "width": integer("390 for a phone, 1280 (default) for a desktop"), "theme": text("light or dark")},
		Run:   toolRender},
	{Name: "file", Desc: "A file's details: name, type, size, checksum, address, and whether its upload is complete.", Props: map[string]arg{"!id": text("file id")}, Run: readPathTool("/files/{id}", "id")},
	{Name: "secrets", Desc: "The secrets (keys, passwords) I may use, by name, with the hosts each may be sent to. Values are never shown.", Run: readPathTool("/secrets")},
	{Name: "secret_request", Desc: "Make an HTTP request with a secret I cannot read: write {{secret}} where the value belongs (a header, the URL or the body); {{basic:USER}} gives base64 of USER:secret. " +
		"It goes only to the secret's hosts, and the value is blanked out of the answer; an answer that is not text comes back without its body (body_omitted).",
		Props: map[string]arg{"!name": text("the secret's name"), "!url": text("full https address"), "method": text("GET (default), POST, PUT, PATCH, DELETE"),
			"headers": headers(`JSON object, e.g. {"Authorization": "Bearer {{secret}}"}`), "body": text("request body, as text"),
			"approval": text(`for a method other than GET, when I must ask first: an approved decision for secret.send whose args are this whole request as written, {"name", "method", "url", "headers", "body"} with {{secret}} left in (the refusal gives them); a request with another body or header needs its own`)},
		Run: toolSecretRequest},
	{Name: "upload", Desc: "Store a file and get its id and address. A large file goes in parts: first name, size and the first part; then id, offset and the next part, until the answer says ready. Attach it with change attachment.add {file, task|comment|decision|option}, or name it in comment.create {attachments:[{file}]}.",
		Props: map[string]arg{"name": text("file name with its extension"), "text": text("the content, as text"), "base64": text("or the content, base64-encoded"),
			"size": integer("for a large file sent in parts: its total size in bytes, with the first part in base64"), "id": text("later parts: the file id the first answer gave"), "offset": integer("later parts: bytes received so far")},
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
	for name, schema := range t.Props {
		if strings.HasPrefix(name, "!") {
			name = name[1:]
			required = append(required, name)
		}
		props[name] = schema
	}
	// Props is a map, so it has no order of its own: the same tool is
	// described the same way every time.
	sort.Strings(required)
	return map[string]any{"type": "object", "properties": props, "required": required}
}

// arg is the JSON schema of one argument of a tool: what a client is told
// it takes, and what checkArgs holds a call to.
type arg map[string]any

func described(a arg, desc string) arg {
	if desc != "" {
		a["description"] = desc
	}
	return a
}

func text(desc string) arg    { return described(arg{"type": "string"}, desc) }
func integer(desc string) arg { return described(arg{"type": "integer"}, desc) }
func flag(desc string) arg    { return described(arg{"type": "boolean"}, desc) }
func textOrInteger(desc string) arg {
	return described(arg{"type": []string{"string", "integer"}}, desc)
}
func object(desc string) arg { return described(arg{"type": "object"}, desc) }
func textList(desc string) arg {
	return described(arg{"type": "array", "items": arg{"type": "string"}}, desc)
}

// headers is an object of header values, or that object as JSON text.
func headers(desc string) arg { return described(arg{"type": []string{"object", "string"}}, desc) }

func changeList(desc string) arg {
	return described(arg{"type": "array", "items": arg{"type": "object", "required": []string{"type"},
		"properties": map[string]any{"type": arg{"type": "string"}, "args": arg{"type": "object"}}}}, desc)
}

func optionList(desc string) arg {
	return described(arg{"type": "array", "items": arg{"type": "object", "required": []string{"label"},
		"properties": map[string]any{"label": arg{"type": "string"}, "description": arg{"type": "string"}, "files": textList("")}}}, desc)
}

// checkArgs holds a call's arguments to the schema the tool advertises
// (toolSchema), all the way down: a required argument, or a required field
// of an object in a list, is there, and every value given is of its type.
// So a value of the wrong type is refused and never quietly dropped: a dry
// run asked for as "true" must not become a real write. A missing or null
// argument is one not given. Arguments the tool does not name pass (a read
// takes any task filter), except dry_run: a tool without one cannot check
// without doing. An object or a list may come as its JSON text, which some
// clients send; that is the same value, written differently.
func checkArgs(t tool, a map[string]any) error {
	if _, dry := a["dry_run"]; dry && t.Props["dry_run"] == nil {
		return fmt.Errorf("%s has no dry run: it cannot check without doing", t.Name)
	}
	return checkObject(arg(toolSchema(t)), a, "")
}

// checkValue holds v, as JSON decoded it, to schema, and says what is wrong
// with it, naming where in the argument it is (options[1].label).
func checkValue(schema arg, v any, at string) error {
	types, ok := schema["type"].([]string)
	if !ok {
		types = []string{fmt.Sprint(schema["type"])}
	}
	for _, typ := range types {
		switch typ {
		case "string":
			if _, ok := v.(string); ok {
				return nil
			}
		case "integer":
			if n, ok := v.(float64); ok && n == math.Trunc(n) {
				return nil
			}
		case "boolean":
			if _, ok := v.(bool); ok {
				return nil
			}
		case "object":
			fields, ok := v.(map[string]any)
			if text, isText := v.(string); isText {
				ok = json.Unmarshal([]byte(text), &fields) == nil
			}
			if ok {
				return checkObject(schema, fields, at)
			}
		case "array":
			items, _ := schema["items"].(arg)
			if text, ok := v.(string); ok {
				var list []any
				if json.Unmarshal([]byte(text), &list) != nil {
					if items["type"] == "string" {
						return nil // ids written with commas
					}
					continue
				}
				v = list
			}
			list, ok := v.([]any)
			if !ok {
				continue
			}
			for i, item := range list {
				if items == nil {
					break
				}
				if err := checkValue(items, item, fmt.Sprintf("%s[%d]", at, i)); err != nil {
					return err
				}
			}
			return nil
		}
	}
	return fmt.Errorf("%s must be %s", at, typeWords(schema["type"]))
}

// checkObject holds the fields of an object to its schema: the required
// ones there (not null), and each that is given, of its type. Fields the
// schema does not name pass.
func checkObject(schema arg, fields map[string]any, at string) error {
	field := func(name string) string {
		if at == "" {
			return name
		}
		return at + "." + name
	}
	required, _ := schema["required"].([]string)
	for _, name := range required {
		if fields[name] == nil {
			return fmt.Errorf("%s is missing", field(name))
		}
	}
	properties, _ := schema["properties"].(map[string]any)
	for _, name := range slices.Sorted(maps.Keys(properties)) {
		propertySchema, _ := properties[name].(arg)
		if v := fields[name]; v != nil && propertySchema != nil {
			if err := checkValue(propertySchema, v, field(name)); err != nil {
				return err
			}
		}
	}
	return nil
}

// typeWords says a schema type as a person would.
func typeWords(typ any) string {
	words := map[string]string{"string": "text", "integer": "a whole number", "boolean": "true or false", "object": "an object", "array": "a list"}
	types, ok := typ.([]string)
	if !ok {
		types = []string{fmt.Sprint(typ)}
	}
	said := make([]string, len(types))
	for i, t := range types {
		said[i] = words[t]
	}
	return strings.Join(said, " or ")
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
