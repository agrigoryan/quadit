package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
)

// The MCP server gives any MCP client the same surface as the API, under
// the same permissions, with results in the compact text form. It speaks
// MCP's streamable HTTP transport: JSON-RPC requests posted to /mcp.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("POST /mcp", s.hMCP)
		m.HandleFunc("GET /mcp", func(w http.ResponseWriter, r *http.Request) {
			// No server-to-client stream is offered; clients poll with tools.
			w.Header().Set("Allow", "POST")
			http.Error(w, "this server answers each request directly; use POST", http.StatusMethodNotAllowed)
		})
	})
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

var mcpVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// mcpTool is one tool: what it is called, what it takes, and how it maps
// onto the API.
type mcpTool struct {
	Name  string
	Desc  string
	Props map[string]string // argument -> description; a leading "!" marks it required
	Run   func(s *Server, token string, a map[string]any) (string, bool)
}

func str(a map[string]any, k string) string {
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

// get makes a tool that reads one API path in text form. Arguments named
// in path are filled into it; the rest become URL parameters.
func get(path string, pathArgs ...string) func(s *Server, token string, a map[string]any) (string, bool) {
	return func(s *Server, token string, a map[string]any) (string, bool) {
		p := path
		q := url.Values{"format": {"text"}}
		for k := range a {
			used := false
			for _, pa := range pathArgs {
				if pa == k {
					p = strings.Replace(p, "{"+k+"}", url.PathEscape(str(a, k)), 1)
					used = true
				}
			}
			if !used && a[k] != nil && str(a, k) != "" {
				q.Set(k, str(a, k))
			}
		}
		if strings.Contains(p, "{") {
			return "missing argument: " + p[strings.Index(p, "{")+1:strings.Index(p, "}")], false
		}
		return s.internal(token, "GET", p, q, nil)
	}
}

var mcpTools = []mcpTool{
	{Name: "whoami", Desc: "Who am I: role, projects, what needs approval, budget left, unread count, feed position. Call first in a session.", Run: get("/me")},
	{Name: "my_work", Desc: "What waits on me, questions asked of me, tasks assigned to me, and my unread inbox. One line each.", Run: get("/my-work")},
	{Name: "tasks", Desc: "Find tasks. All filters combine. Returns one line per task; count=true returns only the number.",
		Props: map[string]string{"project": "project key", "assignee": "me, @handle or none", "status": "status name or category (backlog, unstarted, started, waiting, done, canceled)",
			"open": "true for not done and not canceled", "waiting_on": "me or @handle", "label": "label name", "epic": "epic name, or none", "cycle": "current, next, a number, or none",
			"priority": "1 urgent, 2 high, 3 medium, 4 low", "has_open_decision": "true", "asked": "tasks with an open question asked of this member",
			"changed_since": "feed position: tasks with any activity after it", "mentions": "me or @handle", "q": "text in the title", "parent": "task key",
			"view": "a saved view's slug", "sort": "created, -created, rank, priority, due, -activity, -updated, key", "limit": "default 50", "offset": "", "count": "true"},
		Run: get("/tasks")},
	{Name: "task", Desc: "One task with its description, decisions (with numbered options), comments, sub-tasks, links and files. since=<seq> returns only what changed after that feed position.",
		Props: map[string]string{"!key": "task key, e.g. SVA-12", "since": "feed position", "full": "true to not cut long text"}, Run: get("/tasks/{key}", "key")},
	{Name: "context", Desc: "Everything needed to work on a task in one call: the task, its parents, epic, standing preferences, recent decisions in the project, linked docs.",
		Props: map[string]string{"!key": "task key"}, Run: get("/tasks/{key}/context", "key")},
	{Name: "search", Desc: "Full-text search across tasks, decisions, comments and docs.", Props: map[string]string{"!q": "text", "kind": "task, comment, decision, doc"}, Run: get("/search")},
	{Name: "inbox", Desc: "My inbox: mentions, assignments, answers to my questions, replies. Unread only unless all=true.", Props: map[string]string{"all": "true"}, Run: get("/inbox")},
	{Name: "events", Desc: "The change feed after a position, one line per event. wait=N holds the call up to N seconds until something arrives (use it instead of polling). " +
		"cursor=NAME reads from the position the server keeps for me; call ack to move it. mine=true keeps to tasks I am assigned to, mentioned in or watching; others=true hides my own changes. " +
		"The task filters of the tasks tool work here too.",
		Props: map[string]string{"after": "feed position", "cursor": "name of a server-kept cursor, e.g. main", "wait": "seconds, up to 55", "mine": "true", "others": "true",
			"task": "task key", "types": "comma-separated event types", "inbox": "true for only my inbox items", "limit": ""},
		Run: get("/events")},
	{Name: "ack", Desc: "Mark the feed handled up to a position, for a server-kept cursor.", Props: map[string]string{"!seq": "feed position", "cursor": "cursor name, default main"},
		Run: func(s *Server, token string, a map[string]any) (string, bool) {
			name := str(a, "cursor")
			if name == "" {
				name = "main"
			}
			body, _ := json.Marshal(map[string]any{"seq": a["seq"]})
			return s.internal(token, "PUT", "/cursors/"+url.PathEscape(name), nil, body)
		}},
	{Name: "decisions", Desc: "The decision log: questions with their options, the answer, the reason and the date.",
		Props: map[string]string{"state": "answered (default), open, picked, sent_back, all", "project": "project key", "q": "text in the question", "asked": "me or @handle"}, Run: get("/decisions")},
	{Name: "layout", Desc: "A project's statuses, labels, members, agents, epics, cycles and templates, by name.", Props: map[string]string{"!project": "project key"},
		Run: get("/projects/{project}/layout", "project")},
	{Name: "docs", Desc: "The page tree with ids.", Run: get("/docs")},
	{Name: "doc", Desc: "One page as Markdown.", Props: map[string]string{"!id": "page id", "full": "true to not cut long text"}, Run: get("/docs/{id}", "id")},
	{Name: "rows", Desc: "A database's rows as a table, with formulas worked out.",
		Props: map[string]string{"!id": "database id", "filter": "Prop:op:value, comma-separated; ops: is, is_not, contains, gt, lt, empty, not_empty, checked, unchecked", "sort": "Prop or -Prop", "view": "a view's name"},
		Run:   get("/docs/{id}/rows", "id")},
	{Name: "memory", Desc: "My notes from earlier sessions (agents only). Read at the start of a session.", Run: get("/memory")},
	{Name: "remember", Desc: "Save a note to my memory: the page with this title, made if new. mode=append adds to it.",
		Props: map[string]string{"!title": "page title", "!markdown": "the note", "mode": "replace (default) or append"},
		Run: func(s *Server, token string, a map[string]any) (string, bool) {
			body, _ := json.Marshal(map[string]any{"title": a["title"], "markdown": a["markdown"], "mode": str(a, "mode")})
			return s.internal(token, "POST", "/memory", nil, body)
		}},
	{Name: "changes", Desc: "Every change type with its arguments. Read once to learn what change can do.", Run: get("/api/v1/changes")},
	{Name: "change", Desc: "Make one change. Common types: task.create {project, title, description, assignee, labels, parent}; task.update {id, status, assignee, waiting_on, priority, add_labels}; " +
		"task.take {id}; comment.create {task, body, waiting_on} (add evidence {checked, measured, not_verified} to post a result); " +
		"decision.open {task, question, options:[{label, description}], recommended, recommendation, ask}; decision.pick {id, option, note}; " +
		"doc.create {title, markdown, parent}; doc.write {doc, markdown, mode}. Names work wherever ids do (SVA-12, @handle, status and label names). " +
		"A refusal says what was wrong and lists what would have been accepted. dry_run=true checks without writing.",
		Props: map[string]string{"!type": "change type, e.g. task.update", "!args": "the change's arguments, an object", "approval": "id of an approved decision, when the change needs approval", "dry_run": "true"},
		Run: func(s *Server, token string, a map[string]any) (string, bool) {
			req := map[string]any{"id": id.New(), "type": a["type"], "args": a["args"]}
			if v := str(a, "approval"); v != "" {
				req["approval"] = v
			}
			if b, _ := a["dry_run"].(bool); b {
				req["dry_run"] = true
			}
			if s, ok := a["args"].(string); ok { // some clients send the object as text
				var obj map[string]any
				if json.Unmarshal([]byte(s), &obj) == nil {
					req["args"] = obj
				}
			}
			body, _ := json.Marshal(req)
			out, ok := s.internal(token, "POST", "/changes", nil, body)
			if !ok {
				return out, false
			}
			var res struct {
				Results []engine.Result `json:"results"`
				DryRun  bool            `json:"dry_run"`
			}
			if json.Unmarshal([]byte(out), &res) != nil || len(res.Results) == 0 {
				return out, true
			}
			r := res.Results[0]
			line := "ok " + r.Type
			if res.DryRun {
				line = "would be accepted: " + r.Type
			}
			if r.Key != "" {
				line += " " + r.Key
			}
			if r.Ref != "" {
				line += " id=" + r.Ref
			}
			return fmt.Sprintf("%s seq=%d", line, r.Seq), true
		}},
	{Name: "upload", Desc: "Store a file and get its id and address. Attach it with change attachment.add {file, task|comment|decision|option}, or name it in comment.create {attachments:[{file}]}.",
		Props: map[string]string{"!name": "file name with its extension", "text": "the content, as text", "base64": "or the content, base64-encoded"},
		Run: func(s *Server, token string, a map[string]any) (string, bool) {
			data := []byte(str(a, "text"))
			if b := str(a, "base64"); b != "" {
				raw, err := base64.StdEncoding.DecodeString(b)
				if err != nil {
					return "base64 does not decode: " + err.Error(), false
				}
				data = raw
			}
			out, ok := s.internal(token, "POST", "/files", url.Values{"name": {str(a, "name")}}, data)
			if !ok {
				return out, false
			}
			var f struct{ ID, URL string }
			json.Unmarshal([]byte(out), &f)
			return fmt.Sprintf("file id=%s %s", f.ID, f.URL), true
		}},
}

// buffer collects a handler's answer for a caller inside the process.
type buffer struct {
	h      http.Header
	status int
	body   bytes.Buffer
}

func (b *buffer) Header() http.Header         { return b.h }
func (b *buffer) WriteHeader(code int)        { b.status = code }
func (b *buffer) Write(p []byte) (int, error) { return b.body.Write(p) }

// internal calls the API from inside the server, as the bearer of token.
// It returns the answer's text and whether the call succeeded; a refusal
// comes back as its message, with the allowed values when there are any.
func (s *Server) internal(token, method, path string, q url.Values, body []byte) (string, bool) {
	u := "/api/v1/w/-" + path
	if strings.HasPrefix(path, "/api/") {
		u = path
	}
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest(method, u, bytes.NewReader(body))
	if err != nil {
		return err.Error(), false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:0"
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if q.Get("name") != "" && method == "POST" && strings.HasPrefix(path, "/files") {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	rec := &buffer{h: http.Header{}, status: 200}
	s.mux.ServeHTTP(rec, req)
	out := rec.body.String()
	if rec.status < 300 {
		return out, true
	}
	var wrap struct {
		Error engine.Error `json:"error"`
	}
	if json.Unmarshal(rec.body.Bytes(), &wrap) == nil && wrap.Error.Code != "" {
		return wrap.Error.Error(), false
	}
	return out, false
}

func toolSchema(t mcpTool) map[string]any {
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
		if typ == "string" {
			// Numbers and true/false are welcome too; they are read as text.
			p = map[string]any{"type": []string{"string", "number", "boolean"}}
		}
		if desc != "" {
			p["description"] = desc
		}
		props[name] = p
	}
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func (s *Server) hMCP(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		// Tell an MCP client where to sign its user in.
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+s.cfg.BaseURL+`/.well-known/oauth-protected-resource"`)
		http.Error(w, "sign in, or send a token", http.StatusUnauthorized)
		return
	}
	if _, ok := s.internal(token, "GET", "/me", url.Values{"format": {"text"}}, nil); !ok {
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="`+s.cfg.BaseURL+`/.well-known/oauth-protected-resource"`)
		http.Error(w, "this token is not valid", http.StatusUnauthorized)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.JSONRPC != "2.0" {
		json.NewEncoder(w).Encode(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "send one JSON-RPC 2.0 request"}})
		return
	}
	if len(req.ID) == 0 { // a notification: nothing to answer
		w.WriteHeader(http.StatusAccepted)
		return
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		version := mcpVersions[0]
		if has(mcpVersions, p.ProtocolVersion) {
			version = p.ProtocolVersion
		}
		resp.Result = map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "quadit", "version": s.cfg.Version},
			"instructions": "Tasks, decisions and docs shared by people and agents. Start with whoami and my_work. Follow changes with events (wait=N holds the call) and ack. " +
				"Write with change; a refusal says how to fix the call."}
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		tools := make([]map[string]any, len(mcpTools))
		for i, t := range mcpTools {
			tools[i] = map[string]any{"name": t.Name, "description": t.Desc, "inputSchema": toolSchema(t)}
		}
		resp.Result = map[string]any{"tools": tools}
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		json.Unmarshal(req.Params, &p)
		var tool *mcpTool
		for i := range mcpTools {
			if mcpTools[i].Name == p.Name {
				tool = &mcpTools[i]
			}
		}
		if tool == nil {
			resp.Error = &rpcError{Code: -32602, Message: "unknown tool " + p.Name}
			break
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		text, ok := tool.Run(s, token, p.Arguments)
		resp.Result = map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": !ok}
	default:
		resp.Error = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
