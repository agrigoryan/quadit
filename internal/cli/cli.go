package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/importer"
)

const help = `quadit: tasks, decisions and docs for people and agents

orient    me                         who am I: role, scope, budget, cursors
          work                       what waits on me, what is assigned, unread inbox
          layout PROJECT             statuses, labels, members, epics
          dashboard | agents         where everything stands; what each agent is doing
find      tasks [filter=value ...]   assignee=me status=todo label=art open=1 q=text sort=priority
                                     count=1 for a number, view=SLUG for a saved view
          show KEY [since=SEQ]       one task with decisions and comments
          context KEY                everything needed to work on a task
          search TEXT | decisions [state=open] | inbox [all=1]
follow    events [after=SEQ] [wait=50] [cursor=NAME] [mine=1] [others=1] [task=KEY]
          ack SEQ [NAME]             mark the feed handled up to SEQ
          listen --exec CMD          wait for inbox items and run CMD for each
act       new PROJECT TITLE [field=value ...]      description=- reads it from stdin
          update KEY field=value ... status=done assignee=@ann priority=high add_labels=a,b
          status KEY NAME | assign KEY @WHO | take KEY | release KEY
          comment KEY TEXT [waiting_on=@WHO] [decision=ID | option=ID]
          result KEY TEXT [checked=...] [measured=...] [not_verified=...] [file=PATH ...]
          ask KEY QUESTION option=A option=B [recommended=2] [why=...] [ask=@WHO]
          approval KEY QUESTION [action=task.delete [args=JSON]] [ask=@WHO]
          pick DECISION OPTION|approved|declined|none [note=...]
          unclear DECISION NOTE
          attach KEY PATH ... [option=ID] | upload PATH | read [all | ID ...]
          do TYPE JSON               send any change; "changes" lists them all
secrets   secrets                    the keys I may use (names only; values are never shown)
          request NAME URL [method=POST] [header=K:V ...] [body=TEXT|-]
                                     an HTTP request with {{secret}} filled in by the server
more      quadit help secrets        using keys without holding them
          quadit help docs           pages, databases, memory
          quadit help code           git links, pictures of pages
          quadit help import         bring work in from other tools
          quadit help server         serve, admin, backup, restore

Every command takes --json for full data and --dry-run to check a write.
A write takes --id=UUID (send it again with the same id and it happens once)
and --for=@WHO (it runs with that member's access).
Connect with QUADIT_URL and QUADIT_TOKEN, or: quadit login URL TOKEN
`

var helpTopics = map[string]string{
	"secrets": `secrets: keys and passwords an agent can use but not read
  An admin sets one:   quadit do secret.set '{"name":"DEPLOY_KEY","value":"…","hosts":["api.example.com"],"agents":["@coder"]}'
  secrets                      the secrets I may use, with the hosts each may go to
  request NAME URL [method=POST] [header="Authorization:Bearer {{secret}}"] [body=TEXT|-]
                               the server makes the request and writes the value where
                               {{secret}} stands ({{basic:USER}} = base64 of USER:secret).
                               It goes only to the secret's hosts, redirects are not followed,
                               and the value is blanked out of the answer.
  run --secret NAME [--secret NAME ...] -- COMMAND [ARG ...]
                               for tools on this machine: runs COMMAND with each secret in its
                               environment under its name, and blanks the values out of what it
                               prints. Needs a token made for a companion (an admin makes it:
                               POST tokens {"user":"@agent","secrets":true}) and a secret marked
                               env. The same --secret works with: listen --secret NAME --exec CMD
`,
	"docs": `pages, databases and memory
  docs                         the page tree with ids
  doc ID                       one page as Markdown
  write ID|new TITLE [parent=ID] [mode=append] < markdown     write a page from stdin
  rows DATABASE [filter=Prop:is:Value] [sort=-Prop] [view=NAME]
  row DATABASE TITLE [Prop=value ...]                         add a row to a database
  memory                       my notes from earlier sessions (agents)
  remember TITLE [mode=append] < markdown                     save a note to my memory
`,
	"code": `code and pictures
  link [KEY]                   link the current git branch and its commits to a task;
                               the key is read from the branch name when left out
  link KEY URL                 link a URL to a task
  render KEY|doc=ID [width=390] [height=N | full=1] [theme=dark] [out=FILE]
                               a picture of how it looks to a person; full=1 takes the whole page
`,
	"import": `bring work in (safe to run twice: nothing is added a second time)
  import linear FILE.csv project=KEY       import trello BOARD.json project=KEY
  import asana FILE.csv project=KEY        import github OWNER/REPO project=KEY [token=…]
  import notion EXPORT.zip                 import obsidian FOLDER     import markdown FOLDER
  import orbit https://orbit.example workspace=ID token=ORBIT_TOKEN [session=ORBIT_SESSION]
                                           with a signed-in session, attached files come too
`,
	"server": `on the server's machine
  quadit serve [--listen :4780] [--data DIR] [--db PATH|postgres://…] [--url https://…]
  quadit admin                 setup, reset-password, token, make-admin
  quadit backup [--out FILE] | quadit backup verify FILE
  quadit restore FILE [--workspace SLUG --task KEY | --doc ID]
`,
}

var priorities = map[string]int{"none": 0, "urgent": 1, "high": 2, "medium": 3, "low": 4}
var listKeys = map[string]bool{"labels": true, "add_labels": true, "remove_labels": true, "event_types": true}
var intKeys = map[string]bool{"priority": true, "estimate": true, "base_seq": true, "minutes": true, "recommended": true}
var boolKeys = map[string]bool{"archived": true, "resolved": true, "active": true, "shared": true}

// kv splits "field=value" arguments from positional ones.
func kv(args []string) (pos []string, fields map[string][]string) {
	fields = map[string][]string{}
	for _, a := range args {
		if i := strings.Index(a, "="); i > 0 && !strings.ContainsAny(a[:i], " \t\n/:") {
			fields[a[:i]] = append(fields[a[:i]], a[i+1:])
			continue
		}
		pos = append(pos, a)
	}
	return
}

// value turns a command-line value into what the API takes.
func value(key, v string) any {
	switch {
	case v == "null":
		return nil
	case key == "priority":
		if n, ok := priorities[strings.ToLower(v)]; ok {
			return n
		}
	case listKeys[key]:
		if v == "" {
			return []string{}
		}
		return strings.Split(v, ",")
	case boolKeys[key]:
		switch strings.ToLower(v) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
		return v // neither: the server says what the field takes
	}
	if intKeys[key] {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return v
}

func argsFrom(fields map[string][]string, skip ...string) map[string]any {
	out := map[string]any{}
	for k, vs := range fields {
		skipIt := false
		for _, s := range skip {
			skipIt = skipIt || s == k
		}
		if skipIt {
			continue
		}
		v := vs[len(vs)-1]
		if v == "-" && (k == "description" || k == "body") {
			raw, _ := io.ReadAll(os.Stdin)
			v = string(raw)
		}
		out[k] = value(k, v)
	}
	return out
}

func query(fields map[string][]string) url.Values {
	q := url.Values{}
	for k, vs := range fields {
		q.Set(k, strings.Join(vs, ","))
	}
	return q
}

// Run runs a client command and returns the process exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	var asJSON, dry bool
	var changeID, actFor string
	var rest []string
	for i, a := range args {
		// After "--" (run --secret X -- command) everything is the command's.
		if a == "--" {
			rest = append(rest, args[i:]...)
			break
		}
		switch {
		case a == "--json":
			asJSON = true
		case a == "--dry-run":
			dry = true
		case strings.HasPrefix(a, "--id="):
			changeID = strings.TrimPrefix(a, "--id=")
		case strings.HasPrefix(a, "--for="):
			actFor = strings.TrimPrefix(a, "--for=")
		default:
			rest = append(rest, a)
		}
	}
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "-h" || rest[0] == "--help" {
		if len(rest) > 1 {
			if topic, ok := helpTopics[rest[1]]; ok {
				fmt.Fprint(stdout, topic)
				return 0
			}
		}
		fmt.Fprint(stdout, help)
		return 0
	}
	cmd, rest := rest[0], rest[1:]
	if cmd == "login" {
		return login(rest, stdout, stderr)
	}
	c, err := NewClient()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	c.ChangeID, c.For = changeID, actFor
	r := &runner{c: c, out: stdout, json: asJSON, dry: dry}
	if err := r.run(cmd, rest); err != nil {
		fmt.Fprintln(stderr, err)
		var ae *APIError
		if errors.As(err, &ae) && ae.Status == 429 {
			return 75 // try again later
		}
		return 1
	}
	return 0
}

func login(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 {
		fmt.Fprintln(stderr, "usage: quadit login URL TOKEN")
		return 2
	}
	c := &Client{URL: strings.TrimRight(args[0], "/"), Token: args[1], HTTP: &httpClient}
	me, err := c.Text("/me", nil)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path := configPath()
	os.MkdirAll(filepath.Dir(path), 0o700)
	raw, _ := json.MarshalIndent(savedConfig{URL: c.URL, Token: c.Token}, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "saved to %s\n%s", path, me)
	return 0
}

type runner struct {
	c    *Client
	out  io.Writer
	json bool
	dry  bool
}

// get prints a read in text form, or as JSON when asked.
func (r *runner) get(path string, q url.Values) error {
	if r.json {
		raw, err := r.c.JSON(path, q)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		if json.Indent(&buf, raw, "", "  ") == nil {
			raw = buf.Bytes()
		}
		fmt.Fprintln(r.out, strings.TrimSpace(string(raw)))
		return nil
	}
	text, err := r.c.Text(path, q)
	fmt.Fprint(r.out, text)
	return err
}

// change applies a change and prints one line about it.
func (r *runner) change(typ string, args map[string]any, approval string) (*Result, error) {
	res, err := r.c.Change(typ, args, approval, r.dry)
	if err != nil {
		return nil, err
	}
	if r.json {
		raw, _ := json.Marshal(res)
		fmt.Fprintln(r.out, string(raw))
		return res, nil
	}
	line := "ok " + typ
	if r.dry {
		line = "would be accepted: " + typ
	}
	if res.Key != "" {
		line += " " + res.Key
	}
	if res.Ref != "" && res.Ref != res.Key {
		line += " id=" + res.Ref
	}
	fmt.Fprintf(r.out, "%s seq=%d\n", line, res.Seq)
	return res, nil
}

func need(pos []string, n int, usage string) error {
	if len(pos) < n {
		return errors.New("usage: quadit " + usage)
	}
	return nil
}

func (r *runner) run(cmd string, rest []string) error {
	pos, f := kv(rest)
	approval := ""
	if a := f["approval"]; len(a) > 0 {
		approval = a[0]
		delete(f, "approval")
	}
	switch cmd {
	case "me", "whoami":
		return r.get("/me", nil)
	case "work":
		return r.get("/my-work", nil)
	case "inbox":
		return r.get("/inbox", query(f))
	case "layout":
		if err := need(pos, 1, "layout PROJECT"); err != nil {
			return err
		}
		return r.get("/projects/"+url.PathEscape(pos[0])+"/layout", nil)
	case "changes":
		return r.get("/api/v1/changes", nil)
	case "dashboard":
		return r.get("/dashboard", query(f))
	case "agents":
		return r.get("/agents", nil)
	case "tasks", "ls":
		return r.get("/tasks", query(f))
	case "show":
		if err := need(pos, 1, "show KEY"); err != nil {
			return err
		}
		return r.get("/tasks/"+url.PathEscape(pos[0]), query(f))
	case "context":
		if err := need(pos, 1, "context KEY"); err != nil {
			return err
		}
		return r.get("/tasks/"+url.PathEscape(pos[0])+"/context", query(f))
	case "search":
		if err := need(pos, 1, "search TEXT"); err != nil {
			return err
		}
		q := query(f)
		q.Set("q", strings.Join(pos, " "))
		return r.get("/search", q)
	case "decisions":
		return r.get("/decisions", query(f))
	case "docs":
		return r.get("/docs", query(f))
	case "doc":
		if err := need(pos, 1, "doc ID"); err != nil {
			return err
		}
		return r.get("/docs/"+url.PathEscape(pos[0]), query(f))
	case "rows":
		if err := need(pos, 1, "rows DATABASE"); err != nil {
			return err
		}
		return r.get("/docs/"+url.PathEscape(pos[0])+"/rows", query(f))
	case "memory":
		return r.get("/memory", query(f))
	case "write":
		if err := need(pos, 1, "write ID|new [TITLE] < markdown"); err != nil {
			return err
		}
		raw, _ := io.ReadAll(os.Stdin)
		if pos[0] == "new" {
			a := argsFrom(f)
			a["title"], a["markdown"] = strings.Join(pos[1:], " "), string(raw)
			_, err := r.change("doc.create", a, approval)
			return err
		}
		a := argsFrom(f)
		a["doc"], a["markdown"] = pos[0], string(raw)
		_, err := r.change("doc.write", a, approval)
		return err
	case "remember":
		if err := need(pos, 1, "remember TITLE < markdown"); err != nil {
			return err
		}
		raw, _ := io.ReadAll(os.Stdin)
		body := map[string]any{"title": strings.Join(pos, " "), "markdown": string(raw)}
		if m := f["mode"]; len(m) > 0 {
			body["mode"] = m[0]
		}
		js, _ := json.Marshal(body)
		out, err := r.c.do("POST", "/memory", nil, bytes.NewReader(js), "application/json", "")
		if err == nil {
			fmt.Fprintln(r.out, "ok remembered", strings.TrimSpace(string(out)))
		}
		return err
	case "row":
		if err := need(pos, 2, "row DATABASE TITLE [Prop=value ...]"); err != nil {
			return err
		}
		props := map[string]any{}
		for k, vs := range f {
			v := vs[len(vs)-1]
			switch {
			case v == "true" || v == "false":
				props[k] = v == "true"
			default:
				if n, err := strconv.ParseFloat(v, 64); err == nil {
					props[k] = n
				} else {
					props[k] = v
				}
			}
		}
		_, err := r.change("doc.create", map[string]any{"parent": pos[0], "title": strings.Join(pos[1:], " "), "props": props}, approval)
		return err
	case "events":
		return r.get("/events", query(f))
	case "ack":
		if err := need(pos, 1, "ack SEQ [NAME]"); err != nil {
			return err
		}
		seq, err := strconv.ParseInt(pos[0], 10, 64)
		if err != nil {
			return errors.New("SEQ is a number")
		}
		name := "main"
		if len(pos) > 1 {
			name = pos[1]
		}
		raw, _ := json.Marshal(map[string]int64{"seq": seq})
		out, err := r.c.do("PUT", "/cursors/"+url.PathEscape(name), nil, bytes.NewReader(raw), "application/json", "")
		if err == nil {
			fmt.Fprintln(r.out, strings.TrimSpace(string(out)))
		}
		return err
	case "listen":
		return r.listen(rest)
	case "secrets":
		return r.get("/secrets", nil)
	case "request":
		if err := need(pos, 2, "request NAME URL [method=POST] [header=K:V ...] [body=TEXT|-]"); err != nil {
			return err
		}
		req := map[string]any{"url": pos[1], "method": first(f["method"])}
		headers := map[string]string{}
		for _, h := range f["header"] {
			k, v, ok := strings.Cut(h, ":")
			if !ok {
				return fmt.Errorf("header=%q: write header=Name:value", h)
			}
			headers[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
		req["headers"] = headers
		if b := first(f["body"]); b == "-" {
			raw, err := io.ReadAll(os.Stdin)
			if err != nil {
				return err
			}
			req["body"] = string(raw)
		} else {
			req["body"] = b
		}
		raw, _ := json.Marshal(req)
		accept := "text/plain"
		if r.json {
			accept = "application/json"
		}
		out, err := r.c.do("POST", "/secrets/"+url.PathEscape(pos[0])+"/request", url.Values{"format": {map[bool]string{true: "json", false: "text"}[r.json]}}, bytes.NewReader(raw), "application/json", accept)
		if err != nil {
			return err
		}
		fmt.Fprint(r.out, string(out))
		return nil
	case "run":
		return r.runWithSecrets(rest)

	case "new", "create":
		if err := need(pos, 2, "new PROJECT TITLE [field=value ...]"); err != nil {
			return err
		}
		a := argsFrom(f)
		a["project"], a["title"] = pos[0], strings.Join(pos[1:], " ")
		_, err := r.change("task.create", a, approval)
		return err
	case "update":
		if err := need(pos, 1, "update KEY field=value ..."); err != nil {
			return err
		}
		a := argsFrom(f)
		a["id"] = pos[0]
		_, err := r.change("task.update", a, approval)
		return err
	case "status":
		if err := need(pos, 2, "status KEY NAME"); err != nil {
			return err
		}
		_, err := r.change("task.update", map[string]any{"id": pos[0], "status": strings.Join(pos[1:], " ")}, approval)
		return err
	case "assign":
		if err := need(pos, 2, "assign KEY @WHO"); err != nil {
			return err
		}
		_, err := r.change("task.update", map[string]any{"id": pos[0], "assignee": value("", pos[1])}, approval)
		return err
	case "take", "release", "delete", "restore":
		if err := need(pos, 1, cmd+" KEY"); err != nil {
			return err
		}
		a := argsFrom(f)
		a["id"] = pos[0]
		_, err := r.change("task."+cmd, a, approval)
		return err
	case "comment", "result":
		if err := need(pos, 2, cmd+" KEY TEXT"); err != nil {
			return err
		}
		a := argsFrom(f, "checked", "measured", "not_verified", "file")
		a["task"], a["body"] = pos[0], strings.Join(pos[1:], " ")
		if a["body"] == "-" {
			raw, _ := io.ReadAll(os.Stdin)
			a["body"] = string(raw)
		}
		ev := map[string]string{}
		for _, k := range []string{"checked", "measured", "not_verified"} {
			if v := f[k]; len(v) > 0 {
				ev[k] = v[0]
			}
		}
		if cmd == "result" {
			a["kind"] = "result"
		}
		if len(ev) > 0 {
			a["evidence"] = ev
		}
		if atts, err := r.uploads(f["file"]); err != nil {
			return err
		} else if len(atts) > 0 {
			a["attachments"] = atts
		}
		_, err := r.change("comment.create", a, approval)
		return err
	case "ask", "approval":
		if err := need(pos, 2, cmd+" KEY QUESTION ..."); err != nil {
			return err
		}
		a := argsFrom(f, "option", "why")
		a["task"], a["question"] = pos[0], strings.Join(pos[1:], " ")
		if cmd == "approval" {
			a["kind"] = "approval"
			// args='{"id":"SVA-12"}': what exactly is to be approved.
			if raw := first(f["args"]); raw != "" {
				var args map[string]any
				if err := json.Unmarshal([]byte(raw), &args); err != nil {
					return fmt.Errorf("args must be a JSON object, the arguments the change will be sent with: %w", err)
				}
				a["args"] = args
			} else if _, ok := a["action"]; ok {
				a["args"] = map[string]any{"id": pos[0]} // the usual case: the action is on this task
			}
		}
		var opts []map[string]any
		for _, o := range f["option"] {
			label, desc, _ := strings.Cut(o, "::")
			opt := map[string]any{"label": label}
			if desc != "" {
				opt["description"] = desc
			}
			opts = append(opts, opt)
		}
		if len(opts) > 0 {
			a["options"] = opts
		}
		if w := f["why"]; len(w) > 0 {
			a["recommendation"] = w[0]
		}
		_, err := r.change("decision.open", a, approval)
		return err
	case "pick":
		if err := need(pos, 2, "pick DECISION OPTION|approved|declined|none [note=...]"); err != nil {
			return err
		}
		a := argsFrom(f)
		a["id"] = pos[0]
		switch choice := strings.Join(pos[1:], " "); choice {
		case "approved", "declined", "none":
			a["outcome"] = choice
		default:
			if n, err := strconv.Atoi(choice); err == nil {
				a["option"] = n
			} else {
				a["option"] = choice
			}
		}
		_, err := r.change("decision.pick", a, approval)
		return err
	case "unclear":
		if err := need(pos, 2, "unclear DECISION NOTE"); err != nil {
			return err
		}
		_, err := r.change("decision.unclear", map[string]any{"id": pos[0], "note": strings.Join(pos[1:], " ")}, approval)
		return err
	case "attach":
		if err := need(pos, 2, "attach KEY PATH ..."); err != nil {
			return err
		}
		for _, p := range pos[1:] {
			fid, furl, err := r.c.Upload(p)
			if err != nil {
				return err
			}
			a := argsFrom(f)
			a["file"] = fid
			if _, on := a["option"]; !on {
				if _, on := a["decision"]; !on {
					a["task"] = pos[0]
				}
			}
			if _, err := r.change("attachment.add", a, approval); err != nil {
				return err
			}
			fmt.Fprintln(r.out, furl)
		}
		return nil
	case "import":
		if err := need(pos, 2, "import KIND SOURCE [project=KEY]"); err != nil {
			return err
		}
		opts := map[string]string{}
		for k, v := range f {
			opts[k] = v[len(v)-1]
		}
		plan, err := importer.Read(pos[0], pos[1], opts)
		defer plan.Close()
		if err != nil {
			return err
		}
		if r.json && r.dry {
			raw, _ := json.Marshal(map[string]any{"dry_run": true, "read": map[string]int{"tasks": len(plan.Tasks), "pages": len(plan.Docs), "databases": len(plan.Tables)}})
			fmt.Fprintln(r.out, string(raw))
			return nil
		}
		if !r.json {
			fmt.Fprintf(r.out, "read %d tasks, %d pages, %d databases from %s\n", len(plan.Tasks), len(plan.Docs), len(plan.Tables), pos[0])
		}
		if r.dry {
			return nil
		}
		sum, err := importer.Apply(clientSink{r, new(bool)}, plan, opts["project"])
		if r.json {
			raw, _ := json.Marshal(map[string]any{"made": map[string]int{"tasks": sum.Tasks, "comments": sum.Comments, "pages": sum.Docs, "rows": sum.Rows, "files": sum.Files},
				"already_there": sum.Already, "unmatched_people": sum.Unmatched})
			fmt.Fprintln(r.out, string(raw))
			return err
		}
		fmt.Fprintln(r.out, sum)
		return err
	case "link":
		return r.link(pos, approval)
	case "render":
		q := query(f)
		out := "render.png"
		if o := f["out"]; len(o) > 0 {
			out = o[0]
			q.Del("out")
		}
		if len(pos) > 0 {
			q.Set("task", pos[0])
		}
		png, err := r.c.do("GET", "/render", q, nil, "", "image/png")
		if err != nil {
			return err
		}
		if err := os.WriteFile(out, png, 0o644); err != nil {
			return err
		}
		fmt.Fprintln(r.out, out)
		if r.c.Note != "" {
			fmt.Fprintln(os.Stderr, "note: "+r.c.Note)
		}
		return nil
	case "upload":
		if err := need(pos, 1, "upload PATH"); err != nil {
			return err
		}
		for _, p := range pos {
			fid, furl, err := r.c.Upload(p)
			if err != nil {
				return err
			}
			if r.json {
				raw, _ := json.Marshal(map[string]string{"id": fid, "url": furl})
				fmt.Fprintln(r.out, string(raw))
				continue
			}
			fmt.Fprintf(r.out, "%s id=%s\n", furl, fid)
		}
		return nil
	case "read":
		a := map[string]any{}
		if len(pos) == 0 || pos[0] == "all" {
			a["all"] = true
		} else {
			a["ids"] = pos
		}
		if v := f["up_to"]; len(v) > 0 {
			a["up_to"] = value("base_seq", v[0])
		}
		_, err := r.change("notification.read", a, "")
		return err
	case "do":
		if err := need(pos, 1, "do TYPE [JSON]"); err != nil {
			return err
		}
		a := map[string]any{}
		if len(pos) > 1 {
			if err := json.Unmarshal([]byte(strings.Join(pos[1:], " ")), &a); err != nil {
				return fmt.Errorf("the arguments must be a JSON object, like '{\"id\":\"SVA-12\",\"title\":\"New title\"}'; what was given is not one")
			}
		}
		for k, v := range argsFrom(f) {
			a[k] = v
		}
		_, err := r.change(pos[0], a, approval)
		return err
	}
	return fmt.Errorf("unknown command %q; run: quadit help", cmd)
}

func (r *runner) uploads(paths []string) ([]map[string]any, error) {
	var out []map[string]any
	for _, p := range paths {
		fid, _, err := r.c.Upload(p)
		if err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"file": fid})
	}
	return out, nil
}

// listen is the companion: it holds a request open on the caller's inbox
// and runs a command for each item, so an agent with nothing running can
// still be woken. The item is passed in QUADIT_EVENT and on stdin.
func (r *runner) listen(args []string) error {
	var command, secrets []string
	cursor := "listen"
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--secret" && i+1 < len(args):
			secrets = append(secrets, args[i+1])
			i++
		case args[i] == "--exec" && i+1 < len(args):
			command = args[i+1:]
			i = len(args)
		case strings.HasPrefix(args[i], "cursor="):
			cursor = strings.TrimPrefix(args[i], "cursor=")
		}
	}
	if len(command) == 0 {
		return errors.New("usage: quadit listen [cursor=NAME] --exec COMMAND [ARG ...]")
	}
	fmt.Fprintf(r.out, "listening as cursor %q; running %q for each inbox item\n", cursor, strings.Join(command, " "))
	backoff := time.Second
	for {
		raw, err := r.c.JSON("/events", url.Values{"cursor": {cursor}, "inbox": {"1"}, "wait": {"50"}, "types": {"notification.created"}, "compact": {"1"}})
		if err != nil {
			fmt.Fprintln(r.out, "retrying:", err)
			time.Sleep(backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		var page struct {
			Events []string `json:"events"`
			Seq    int64    `json:"seq"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		for _, line := range page.Events {
			fmt.Fprintln(r.out, line)
			// Secrets are fetched for each run, so a changed or withdrawn one
			// takes effect at once.
			env, err := r.secretEnv(secrets)
			if err != nil {
				fmt.Fprintln(r.out, "secrets:", err)
				time.Sleep(backoff)
				continue
			}
			out := newMasker(r.out, env)
			cmd := exec.Command(command[0], command[1:]...)
			cmd.Env = append(os.Environ(), "QUADIT_EVENT="+line)
			for k, v := range env {
				cmd.Env = append(cmd.Env, k+"="+v)
			}
			cmd.Stdin = strings.NewReader(line + "\n")
			cmd.Stdout, cmd.Stderr = out, out
			if err := cmd.Run(); err != nil {
				fmt.Fprintln(r.out, "command failed:", err)
			}
			out.Flush()
		}
		// Mark handled only after the command ran, so a crash repeats the
		// item instead of losing it.
		ack, _ := json.Marshal(map[string]int64{"seq": page.Seq})
		if _, err := r.c.do("PUT", "/cursors/"+url.PathEscape(cursor), nil, bytes.NewReader(ack), "application/json", ""); err != nil {
			fmt.Fprintln(r.out, "ack failed:", err)
		}
	}
}

var branchKey = regexp.MustCompile(`(?i)\b([a-z][a-z0-9]{1,9}-\d+)\b`)

func gitOut(args ...string) (string, error) {
	out, err := exec.Command("git", args...).Output()
	return strings.TrimSpace(string(out)), err
}

// link ties the git branch in the current directory to a task: its name,
// its commits ahead of the main branch, and whether it is merged. It needs
// no hosting service, only a local repository.
func (r *runner) link(pos []string, approval string) error {
	if len(pos) == 2 && strings.Contains(pos[1], "://") {
		_, err := r.change("link.set", map[string]any{"task": pos[0], "kind": "url", "url": pos[1]}, approval)
		return err
	}
	branch, err := gitOut("rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return errors.New("this is not a git repository; run it inside one, or give a URL: quadit link KEY URL")
	}
	key := ""
	if len(pos) > 0 {
		key = pos[0]
	} else if m := branchKey.FindString(branch); m != "" {
		key = strings.ToUpper(m)
	} else {
		return fmt.Errorf("the branch %q does not name a task; give the key: quadit link KEY", branch)
	}
	repo, _ := gitOut("remote", "get-url", "origin")
	repo = strings.TrimSuffix(repo, ".git")
	if i := strings.LastIndexAny(repo, ":"); i >= 0 && !strings.Contains(repo, "://") {
		repo = repo[i+1:] // git@host:owner/name
	} else if u, perr := url.Parse(repo); perr == nil && u.Host != "" {
		repo = strings.Trim(u.Path, "/")
	}
	if repo == "" {
		top, _ := gitOut("rev-parse", "--show-toplevel")
		repo = filepath.Base(top)
	}
	base := ""
	for _, cand := range []string{"origin/HEAD", "origin/main", "origin/master", "main", "master"} {
		if _, err := gitOut("rev-parse", "--verify", "--quiet", cand); err == nil {
			base = cand
			break
		}
	}
	type commit struct {
		SHA     string `json:"sha"`
		Subject string `json:"subject"`
	}
	var commits []commit
	state := "open"
	if base != "" {
		log, _ := gitOut("log", "--format=%h%x09%s", "-n", "50", base+"..HEAD")
		for _, line := range strings.Split(log, "\n") {
			if sha, subject, ok := strings.Cut(line, "\t"); ok {
				commits = append(commits, commit{sha, subject})
			}
		}
		if len(commits) == 0 && branch != strings.TrimPrefix(base, "origin/") {
			if _, err := gitOut("merge-base", "--is-ancestor", "HEAD", base); err == nil {
				state = "merged"
			}
		}
	}
	// The link is called by its branch; what was committed is in its commits.
	args := map[string]any{"task": key, "kind": "branch", "repo": repo, "ref": branch, "state": state, "title": branch}
	if state != "merged" {
		// Once merged nothing is ahead any more: the commits listed while
		// the branch was open stay on the link as they were.
		args["data"] = map[string]any{"commits": commits, "ahead": len(commits), "base": base}
	}
	_, err = r.change("link.set", args, approval)
	return err
}

// clientSink lets an import write through the API as the caller.
type clientSink struct {
	r   *runner
	dup *bool
}

func (s clientSink) Change(changeID, typ string, args any) error {
	raw, _ := json.Marshal(map[string]any{"id": changeID, "type": typ, "args": args})
	out, err := s.r.c.do("POST", "/changes", nil, bytes.NewReader(raw), "application/json", "application/json")
	var res struct {
		Results []struct {
			Duplicate bool `json:"duplicate"`
		} `json:"results"`
	}
	*s.dup = err == nil && json.Unmarshal(out, &res) == nil && len(res.Results) > 0 && res.Results[0].Duplicate
	return err
}

// WasDuplicate reports whether the last change had been made before.
func (s clientSink) WasDuplicate() bool { return *s.dup }

func (s clientSink) Get(path string, q url.Values) ([]byte, error) { return s.r.c.JSON(path, q) }

func (s clientSink) Upload(path string) (string, error) {
	_, u, err := s.r.c.Upload(path)
	return u, err
}

// UploadAs sends a file under the import's own id for it, unless an
// earlier run of the same import has.
func (s clientSink) UploadAs(fileID, path string) (string, bool, error) {
	var had struct{ URL, State string }
	if raw, err := s.r.c.JSON("/files/"+fileID, nil); err == nil && json.Unmarshal(raw, &had) == nil && had.State == "ready" {
		return had.URL, false, nil
	}
	_, u, err := s.r.c.UploadAs(fileID, path)
	return u, true, err
}

func (s clientSink) Logf(format string, a ...any) {
	if s.r.json {
		fmt.Fprintf(os.Stderr, format+"\n", a...) // --json keeps standard output to the one JSON answer
		return
	}
	fmt.Fprintf(s.r.out, format+"\n", a...)
}

// secretEnv asks the server for the secrets a companion may put in a
// command's environment.
func (r *runner) secretEnv(names []string) (map[string]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	raw, _ := json.Marshal(map[string]any{"names": names})
	out, err := r.c.do("POST", "/secrets/env", nil, bytes.NewReader(raw), "application/json", "application/json")
	if err != nil {
		return nil, err
	}
	var res struct {
		Env map[string]string `json:"env"`
	}
	return res.Env, json.Unmarshal(out, &res)
}

// runWithSecrets runs a command with secrets in its environment and blanks
// their values out of what it prints.
func (r *runner) runWithSecrets(args []string) error {
	var names, command []string
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--secret" && i+1 < len(args):
			names = append(names, args[i+1])
			i++
		case args[i] == "--":
			command = args[i+1:]
			i = len(args)
		default:
			command = args[i:]
			i = len(args)
		}
	}
	if len(command) == 0 || len(names) == 0 {
		return errors.New("usage: quadit run --secret NAME [--secret NAME ...] -- COMMAND [ARG ...]")
	}
	env, err := r.secretEnv(names)
	if err != nil {
		return err
	}
	out := newMasker(r.out, env)
	defer out.Flush()
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, out, out
	return cmd.Run()
}

// masker passes text through with secret values blanked out. It holds back
// an unfinished line, so a value split across two writes is still caught.
type masker struct {
	mu     sync.Mutex
	w      io.Writer
	values []string
	held   []byte
}

func newMasker(w io.Writer, env map[string]string) *masker {
	m := &masker{w: w}
	for _, v := range env {
		if len(v) >= 4 {
			m.values = append(m.values, v)
		}
	}
	return m
}

func (m *masker) Write(p []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.held = append(m.held, p...)
	i := bytes.LastIndexByte(m.held, '\n')
	if i < 0 && len(m.held) < 64<<10 {
		return len(p), nil
	}
	if i < 0 {
		i = len(m.held) - 1
	}
	out := m.held[:i+1]
	m.held = append([]byte(nil), m.held[i+1:]...)
	_, err := m.w.Write(m.mask(out))
	return len(p), err
}

func (m *masker) mask(b []byte) []byte {
	for _, v := range m.values {
		b = bytes.ReplaceAll(b, []byte(v), []byte("•••"))
	}
	return b
}

// Flush writes out what is held back.
func (m *masker) Flush() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.held) > 0 {
		m.w.Write(m.mask(m.held))
		m.held = nil
	}
}

// first is the first value given for a field, or nothing.
func first(vals []string) string {
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}
