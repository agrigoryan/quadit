// Codex as a program the runner starts.
//
// Checked against `codex exec --help` and `codex exec resume --help` of
// 0.170.0: --json, --dangerously-bypass-approvals-and-sandbox,
// --skip-git-repo-check, -o/--output-last-message, a prompt of "-" read
// from standard input; `exec resume [SESSION_ID] [PROMPT]` takes a UUID
// first and has no -C, so the folder is the working directory; `codex
// login status` exists. Codex exec refuses the program's own interactive
// question requests: nothing to pass.
//
// Verified against real output of Codex 0.170.0 (2026-11-24, kept
// sanitized in testdata/programs/codex-real-*.jsonl): a fresh run and a
// resume of it print thread.started (thread_id, a version-7 UUID),
// turn.started, item.completed (agent_message) and turn.completed (with
// usage), exit 0, and the -o file holds the last message with no line
// break; a resume of a thread that does not exist prints nothing on
// standard output, exit 1, and ends its standard error with "Error:
// thread/resume: thread/resume failed: no rollout found for thread id …
// (code -32600)".
//
// UNVERIFIED, and read so that being wrong fails safe (a line or field not
// known is passed over; an error not recognized is a plain failure, which
// is retried only before any work):
//   - a real usage limit: its words and its reset time ("try again at …",
//     a local time with an optional "(Zone/Name)") in codexWords;
//   - a real sign-in failure while running: the sign-in words are known to
//     be incomplete;
//   - the tool events of a real run (command_execution, file_change,
//     mcp_tool_call, web_search);
//   - `codex login status` exiting 0 when signed in, and exiting 1 both
//     when signed out and when the check itself failed, told apart only by
//     its words ("not logged in");
//   - the paths of file_change items: absolute or relative to the folder,
//     both read;
//   - where a session is kept: <CODEX_HOME>/sessions/*/*/*/rollout-*-<id>.jsonl;
//   - that shell_environment_policy.set.QUADIT_CONFIG in config.toml makes
//     the commands it runs work as another login (read in the three forms
//     TOML writes it).
// testdata/programs/codex-{fresh,resume,lost,limit,signedout,error}.jsonl
// are written by hand in the documented form.

package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type codex struct{}

func (codex) Name() string  { return "codex" }
func (codex) Title() string { return "Codex" }

func (codex) Command(spec runSpec) []string {
	flags := []string{"--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-o", spec.LastMessageFile}
	if spec.Resume != "" {
		return append(append([]string{"exec", "resume"}, flags...), spec.Resume, "-")
	}
	return append(append([]string{"exec"}, flags...), "-")
}

func (codex) Reader(spec runSpec) streamReader { return &codexReader{spec: spec} }

func (codex) SignedIn() []string { return []string{"login", "status"} }

// codexSignedOut is what `codex login status` says when nobody is signed in.
var codexSignedOut = regexp.MustCompile(`(?i)not logged in`)

func (codex) ReadSignedIn(exit int, output []byte) (bool, error) {
	switch {
	case exit == 0:
		return true, nil
	case codexSignedOut.Match(output):
		return false, nil
	}
	return false, entryError("Codex could not check its sign-in")
}

// codexHome is where Codex keeps its settings and sessions.
func codexHome(home string) string {
	if dir := os.Getenv("CODEX_HOME"); dir != "" {
		return dir
	}
	return filepath.Join(home, ".codex")
}

func (codex) SessionFile(home, session, _ string) (string, bool) {
	matches, err := filepath.Glob(filepath.Join(codexHome(home), "sessions", "*", "*", "*", "rollout-*-"+session+".jsonl"))
	if err != nil || len(matches) == 0 {
		return "", false
	}
	return matches[0], true
}

func (codex) ResumeLine(folderLabel, session string) string {
	return "cd " + folderForShell(folderLabel) + " && codex resume " + session
}

func (codex) LoginSetting(home string) (string, bool) {
	f, err := os.Open(filepath.Join(codexHome(home), "config.toml"))
	if err != nil {
		return "", false
	}
	defer f.Close()
	return quaditConfigInTOML(f)
}

// tomlQuaditConfig finds QUADIT_CONFIG = "…" on a line, and tomlTable a
// table's header.
var (
	tomlQuaditConfig = regexp.MustCompile(`(?:^|[{,\s.])"?QUADIT_CONFIG"?\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	tomlTable        = regexp.MustCompile(`^\[\s*([A-Za-z0-9_."-]+)\s*\]`)
)

// quaditConfigInTOML is shell_environment_policy.set.QUADIT_CONFIG in a
// Codex config, written in any of the forms TOML has for it: the key in
// the table [shell_environment_policy.set], set.QUADIT_CONFIG or an inline
// set = { QUADIT_CONFIG = … } in [shell_environment_policy], the whole
// dotted key at the top, or the policy as one inline table.
func quaditConfigInTOML(f *os.File) (string, bool) {
	table := ""
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := strings.TrimSpace(scan.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		if m := tomlTable.FindStringSubmatch(line); m != nil {
			table = strings.ReplaceAll(m[1], `"`, "")
			continue
		}
		m := tomlQuaditConfig.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		key, _, _ := strings.Cut(line, "=")
		full := strings.Trim(strings.Join([]string{table, strings.ReplaceAll(strings.TrimSpace(key), `"`, "")}, "."), ".")
		// set.QUADIT_CONFIG, set = { … }, or the whole policy inline.
		if strings.HasPrefix(full, "shell_environment_policy.set") || (full == "shell_environment_policy" && strings.Contains(line, "set")) {
			return m[1] + m[2], true
		}
	}
	return "", false
}

// codexWords are Codex's error words.
var codexWords = errorWords{
	usageLimit:  regexp.MustCompile(`(?i)you('|’)ve hit your usage limit|usage limit`),
	resetAt:     regexp.MustCompile(`(?i)try again at (?P<time>[^.!\n(]+)(?:\((?P<zone>[^)]+)\))?`),
	lostSession: regexp.MustCompile(`(?i)no rollout found for thread id|thread .* not found|no saved session`),
	notSignedIn: regexp.MustCompile(`(?i)not logged in|please log in|401 unauthorized`),
}

// codexReader reads `codex exec --json` output.
type codexReader struct {
	spec      runSpec
	accepted  bool
	completed bool            // turn.completed was seen
	errors    tail            // the messages of turn.failed and error lines, their last keptStderr bytes
	tools     map[string]bool // the tool items seen, by id: each makes its step once, on either edge
	lastText  string
}

// codexLine is one line of the output, with the fields the reader uses.
type codexLine struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id"`
	Message  string `json:"message"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item *struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Text    string `json:"text"`
		Server  string `json:"server"`
		Tool    string `json:"tool"`
		Changes []struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		} `json:"changes"`
	} `json:"item"`
}

func (r *codexReader) Line(line []byte) []programEvent {
	var l codexLine
	if json.Unmarshal(line, &l) != nil {
		return unreadable(line)
	}
	var events []programEvent
	switch l.Type {
	case "thread.started":
		if l.ThreadID != "" {
			events = append(events, programEvent{Kind: evSession, Session: l.ThreadID})
		}
	case "item.started", "item.completed":
		if l.Item == nil {
			break // no item: nothing was taken
		}
		if !r.accepted {
			r.accepted = true
			events = append(events, programEvent{Kind: evAccepted})
		}
		events = append(events, r.item(l.Type == "item.started", l.Item.Type, l)...)
	case "turn.completed":
		r.completed = true
	case "turn.failed":
		if l.Error != nil {
			r.errors.add([]byte(l.Error.Message))
		}
	case "error":
		r.errors.add([]byte(l.Message))
	}
	return events
}

// item is what an item says: a tool's activity with its step, or the
// agent's message.
func (r *codexReader) item(started bool, kind string, l codexLine) []programEvent {
	// A tool's activity counts on whichever edge of its item is seen
	// first; its step is made once.
	first := func() bool {
		if r.tools == nil {
			r.tools = map[string]bool{}
		}
		seen := r.tools[l.Item.ID]
		r.tools[l.Item.ID] = true
		return !seen || l.Item.ID == ""
	}
	tool := func(s step) []programEvent {
		if !first() {
			return []programEvent{{Kind: evTool}}
		}
		return []programEvent{{Kind: evTool}, {Kind: evStep, Step: s}}
	}
	switch kind {
	case "command_execution":
		return tool(step{Tool: "shell"})
	case "mcp_tool_call":
		return tool(step{Tool: stepText(l.Item.Server + "." + l.Item.Tool)})
	case "web_search":
		return tool(step{Tool: "web search"})
	case "file_change":
		events := []programEvent{{Kind: evTool}}
		if !first() {
			return events
		}
		for _, change := range l.Item.Changes {
			s := step{Tool: "edit"}
			if rel, ok := relativeIn(r.spec.Folder, change.Path); ok {
				s.Text = stepText(change.Kind + " " + rel)
			}
			events = append(events, programEvent{Kind: evStep, Step: s})
		}
		return events
	case "agent_message":
		if started {
			return nil
		}
		r.lastText = l.Item.Text
		return []programEvent{{Kind: evText, Text: l.Item.Text}}
	}
	return nil
}

func (r *codexReader) End(exit int, stderr []byte) outcome {
	if r.completed && exit == 0 {
		final := r.lastText
		if raw := readAtMost(r.spec.LastMessageFile, maxFinal); len(bytes.TrimSpace(raw)) > 0 {
			final = string(raw)
		}
		return outcome{Kind: outcomeOK, Final: final}
	}
	return codexWords.classify(string(stderr)+"\n"+string(r.errors.bytes()), r.spec.Now())
}
