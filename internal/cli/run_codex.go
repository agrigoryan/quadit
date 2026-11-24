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
// UNVERIFIED, and read so that being wrong fails safe (a line or field not
// known is passed over; an error not recognized is a plain failure, which
// is retried only before any work):
//   - the error words of a usage limit, of its reset time ("try again at
//     …", a local time with an optional "(Zone/Name)"), of a lost session
//     and of a sign-in (codexWords): the sign-in words are known to be
//     incomplete for failures met while running;
//   - `codex login status` exiting 0 when signed in, and exiting 1 both
//     when signed out and when the check itself failed, told apart only by
//     its words ("not logged in");
//   - the paths of file_change items: absolute or relative to the folder,
//     both read;
//   - where a session is kept: <CODEX_HOME>/sessions/*/*/*/rollout-*-<id>.jsonl;
//   - that shell_environment_policy.set.QUADIT_CONFIG in config.toml makes
//     the commands it runs work as another login (read in the three forms
//     TOML writes it).
// The fixtures in testdata/programs/codex-*.jsonl are written by hand in
// the documented form until the hand check (scripts/agent-run-check.sh)
// records real ones.

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
	completed bool     // turn.completed was seen
	errors    []string // the messages of turn.failed and error lines
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
		return nil
	}
	var events []programEvent
	switch l.Type {
	case "thread.started":
		if l.ThreadID != "" {
			events = append(events, programEvent{Kind: evSession, Session: l.ThreadID})
		}
	case "item.started", "item.completed":
		if !r.accepted {
			r.accepted = true
			events = append(events, programEvent{Kind: evAccepted})
		}
		if l.Item == nil {
			break
		}
		events = append(events, r.item(l.Type == "item.started", l.Item.Type, l)...)
	case "turn.completed":
		r.completed = true
	case "turn.failed":
		if l.Error != nil {
			r.errors = append(r.errors, l.Error.Message)
		}
	case "error":
		r.errors = append(r.errors, l.Message)
	}
	return events
}

// item is what an item says: a tool's activity with its step, or the
// agent's message.
func (r *codexReader) item(started bool, kind string, l codexLine) []programEvent {
	tool := func(s step) []programEvent {
		return []programEvent{{Kind: evTool}, {Kind: evStep, Step: s}}
	}
	switch {
	case started && kind == "command_execution":
		return tool(step{Tool: "shell"})
	case started && kind == "mcp_tool_call":
		return tool(step{Tool: stepText(l.Item.Server + "." + l.Item.Tool)})
	case started && kind == "web_search":
		return tool(step{Tool: "web search"})
	case !started && kind == "file_change":
		events := []programEvent{{Kind: evTool}}
		for _, change := range l.Item.Changes {
			s := step{Tool: "edit"}
			if rel, ok := relativeIn(r.spec.Folder, change.Path); ok {
				s.Text = stepText(change.Kind + " " + rel)
			}
			events = append(events, programEvent{Kind: evStep, Step: s})
		}
		return events
	case !started && kind == "agent_message":
		r.lastText = l.Item.Text
		return []programEvent{{Kind: evText, Text: l.Item.Text}}
	}
	return nil
}

func (r *codexReader) End(exit int, stderr []byte) outcome {
	if r.completed && exit == 0 {
		final := r.lastText
		if raw, err := os.ReadFile(r.spec.LastMessageFile); err == nil && len(bytes.TrimSpace(raw)) > 0 {
			final = string(raw)
		}
		return outcome{Kind: outcomeOK, Final: final}
	}
	return codexWords.classify(string(stderr)+"\n"+strings.Join(r.errors, "\n"), r.spec.Now())
}
