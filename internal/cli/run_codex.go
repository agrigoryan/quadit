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
// (code -32600)". A run with commands (codex-real-tools.jsonl) prints,
// before each command, an item.completed agent_message with the agent's
// own sentence of what it will do; then item.started and item.completed
// of a command_execution under one id, with the raw command line (a
// shell's -lc, heredocs and all) and its output; its last agent_message
// is the final answer, the one the -o file holds.
//
// UNVERIFIED, and read so that being wrong fails safe (a line or field not
// known is passed over; an error not recognized is a plain failure, which
// is retried only before any work):
//   - a real usage limit: its words and its reset time ("try again at …",
//     a local time with an optional "(Zone/Name)") in codexWords;
//   - a real sign-in failure while running: the sign-in words are known to
//     be incomplete;
//   - the tool events of a real run other than command_execution
//     (file_change, mcp_tool_call, web_search);
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
	"errors"
	"fmt"
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

// QuaditSettings reads config.toml's shell_environment_policy.set.
func (codex) QuaditSettings(home, _ string) ([]quaditSetting, error) {
	path := filepath.Join(codexHome(home), "config.toml")
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	defer f.Close()
	settings, err := quaditSettingsInTOML(f)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for i := range settings {
		settings[i].File = path
	}
	return settings, nil
}

// tomlQuaditVariable finds a QUADIT_CONFIG, QUADIT_URL, QUADIT_TOKEN or
// QUADIT_WORKSPACE key on a line, and tomlQuaditValue one with its value; tomlTable finds
// a table's header.
// The variable's name is matched without regard to case on Windows, which
// reads names so (envNameFlag).
var (
	tomlQuaditVariable = regexp.MustCompile(envNameFlag + `(?:^|[{,\s.])["']?(QUADIT_(?:CONFIG|URL|TOKEN|WORKSPACE))["']?\s*=`)
	tomlQuaditValue    = regexp.MustCompile(envNameFlag + `(?:^|[{,\s.])["']?(QUADIT_(?:CONFIG|URL|TOKEN|WORKSPACE))["']?\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	tomlTable          = regexp.MustCompile(`^\[\s*([A-Za-z0-9_."'-]+)\s*\]`)
)

// quaditSettingsInTOML are the QUADIT_ variables of
// shell_environment_policy.set in a Codex config, in any of the forms
// TOML writes them: keys of the table [shell_environment_policy.set];
// set.KEY or an inline set = { … } in [shell_environment_policy]; the
// whole dotted key at the top; the policy as one inline table. A key it
// finds there with a value it cannot read, or a file it cannot read to
// its end, is an error: what is set is not known.
func quaditSettingsInTOML(f *os.File) ([]quaditSetting, error) {
	var out []quaditSetting
	table := ""
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		line := strings.TrimSpace(scan.Text())
		if strings.HasPrefix(line, "#") {
			continue
		}
		if m := tomlTable.FindStringSubmatch(line); m != nil {
			table = strings.NewReplacer(`"`, "", "'", "").Replace(m[1])
			continue
		}
		if !tomlQuaditVariable.MatchString(line) {
			continue
		}
		key, _, _ := strings.Cut(line, "=")
		full := strings.Trim(strings.Join([]string{table, strings.NewReplacer(`"`, "", "'", "").Replace(strings.TrimSpace(key))}, "."), ".")
		// set.KEY, set = { … }, or the whole policy inline.
		if !strings.HasPrefix(full, "shell_environment_policy.set") && (full != "shell_environment_policy" || !strings.Contains(line, "set")) {
			continue
		}
		values := tomlQuaditValue.FindAllStringSubmatch(line, -1)
		if len(values) != len(tomlQuaditVariable.FindAllString(line, -1)) {
			return nil, errors.New("a QUADIT_ setting whose value could not be read")
		}
		for _, m := range values {
			out = append(out, quaditSetting{Name: envName(m[1]), Value: m[2] + m[3]})
		}
	}
	return out, scan.Err()
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
	words     agentWords
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

// item is what an item says: a tool's activity with its step, after the
// agent's message held before it (agentWords); or the agent's message.
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
		events := append(r.words.acted(), programEvent{Kind: evTool})
		if !first() {
			return events
		}
		return append(events, programEvent{Kind: evStep, Step: s})
	}
	switch kind {
	case "command_execution":
		return tool(step{Tool: "shell"})
	case "mcp_tool_call":
		return tool(step{Tool: stepText(l.Item.Server + "." + l.Item.Tool)})
	case "web_search":
		return tool(step{Tool: "web search"})
	case "file_change":
		events := append(r.words.acted(), programEvent{Kind: evTool})
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
		return r.words.said(l.Item.Text)
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
