// Claude Code as a program the runner starts.
//
// Checked against `claude --help` of 2.1.331: -p, --output-format
// stream-json, --verbose, --session-id (a valid UUID), --resume, -n/--name,
// --permission-mode bypassPermissions, --disallowedTools; `claude auth
// status` exists. The prompt goes on standard input (`claude -p` with no
// prompt argument reads it). --disallowedTools takes every word after it,
// so it is always the last argument.
//
// UNVERIFIED, and read so that being wrong fails safe (a line or field not
// known is passed over; an error not recognized is a plain failure, which
// is retried only before any work):
//   - the fields of the rate-limit event ({"type":"rate_limit_event",
//     "rate_limit_info":{"status":"rejected","resetsAt":SECONDS}}), taken
//     from the Agent SDK's message types;
//   - the kinds an assistant message's "error" field takes (rate_limit,
//     billing_error, authentication_failed, …), from the same types;
//   - the error words of a lost session, a usage limit and a sign-in
//     (claudeWords), and the reset time in them;
//   - `claude auth status` exiting 0 when signed in and 1 when not;
//   - where a session is kept: <config>/projects/<the folder, every
//     character not a letter or digit made "-">/<id>.jsonl;
//   - that settings' env.QUADIT_CONFIG reaches the program's Bash tool.
// The fixtures in testdata/programs/claude-*.jsonl are written by hand in
// the documented form until the hand check (scripts/agent-run-check.sh)
// records real ones.

package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type claudeCode struct{}

func (claudeCode) Name() string  { return "claude" }
func (claudeCode) Title() string { return "Claude Code" }

func (claudeCode) Command(spec runSpec) []string {
	args := []string{"-p", "--output-format", "stream-json", "--verbose"}
	if spec.Resume != "" {
		args = append(args, "--resume", spec.Resume)
	} else {
		args = append(args, "--session-id", spec.Session, "--name", spec.Title)
	}
	return append(args, "--permission-mode", "bypassPermissions", "--disallowedTools", "AskUserQuestion")
}

func (claudeCode) Reader(spec runSpec) streamReader { return &claudeReader{spec: spec} }

func (claudeCode) SignedIn() []string { return []string{"auth", "status"} }

func (claudeCode) ReadSignedIn(exit int, _ []byte) (bool, error) {
	switch exit {
	case 0:
		return true, nil
	case 1:
		return false, nil
	}
	return false, entryError("Claude Code could not check its sign-in")
}

// claudeHome is where Claude Code keeps its settings and sessions.
func claudeHome(home string) string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(home, ".claude")
}

// notLetterOrDigit is what Claude Code makes "-" in a folder's path to
// name the folder of its sessions there.
var notLetterOrDigit = regexp.MustCompile(`[^A-Za-z0-9]`)

func (claudeCode) SessionFile(home, session, folder string) (string, bool) {
	path := filepath.Join(claudeHome(home), "projects", notLetterOrDigit.ReplaceAllString(folder, "-"), session+".jsonl")
	if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() {
		return path, true
	}
	return "", false
}

func (claudeCode) ResumeLine(folderLabel, session string) string {
	return "cd " + folderForShell(folderLabel) + " && claude --resume " + session
}

func (claudeCode) LoginSetting(home string) (string, bool) {
	raw, err := os.ReadFile(filepath.Join(claudeHome(home), "settings.json"))
	if err != nil {
		return "", false
	}
	var settings struct {
		Env map[string]any `json:"env"`
	}
	if json.Unmarshal(raw, &settings) != nil {
		return "", false
	}
	v, ok := settings.Env["QUADIT_CONFIG"].(string)
	return v, ok && v != ""
}

// claudeWords are Claude Code's error words.
var claudeWords = errorWords{
	lostSession: regexp.MustCompile(`(?i)no conversation found with session id|--resume requires a valid session`),
	usageLimit:  regexp.MustCompile(`(?i)hit your (\w+ )?limit|usage limit reached|(5-hour|weekly) limit reached|out of extra usage`),
	resetAt:     regexp.MustCompile(`(?i)resets? (?:at )?(?P<time>[0-9:apm ]+)(?: \((?P<zone>[^)]+)\))?`),
	notSignedIn: regexp.MustCompile(`(?i)not logged in|please run /login|invalid api key|oauth token (has )?expired`),
}

// claudeReader reads Claude Code's stream-json output.
type claudeReader struct {
	spec     runSpec
	accepted bool
	// apiError is the kind the last assistant message with an error gave.
	apiError string
	// limited is a rejected rate-limit event, with its reset when given.
	limited  bool
	resetsAt time.Time
	result   *claudeResult
}

// claudeResult is the result line, the last of a turn.
type claudeResult struct {
	IsError bool              `json:"is_error"`
	Result  string            `json:"result"`
	Errors  []json.RawMessage `json:"errors"`
}

// claudeLine is one line of the output, with the fields the reader uses.
type claudeLine struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	SessionID string          `json:"session_id"`
	Error     json.RawMessage `json:"error"`
	Message   *struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	} `json:"message"`
	RateLimit *struct {
		Status   string  `json:"status"`
		ResetsAt float64 `json:"resetsAt"`
	} `json:"rate_limit_info"`
	PermissionDenials []struct {
		ToolName string `json:"tool_name"`
	} `json:"permission_denials"`
}

func (r *claudeReader) Line(line []byte) []programEvent {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return nil
	}
	switch l.Type {
	case "system":
		if l.Subtype == "init" && l.SessionID != "" {
			return []programEvent{{Kind: evSession, Session: l.SessionID}}
		}
	case "assistant":
		if len(l.Error) > 0 && string(l.Error) != "null" {
			r.apiError = errorKind(l.Error)
			return nil
		}
		if l.Message == nil {
			return nil
		}
		var events []programEvent
		if !r.accepted {
			r.accepted = true
			events = append(events, programEvent{Kind: evAccepted})
		}
		for _, block := range l.Message.Content {
			switch block.Type {
			case "text":
				events = append(events, programEvent{Kind: evText, Text: block.Text})
			case "tool_use":
				events = append(events, programEvent{Kind: evTool}, programEvent{Kind: evStep, Step: r.step(block.Name, block.Input)})
			}
		}
		return events
	case "rate_limit_event":
		if l.RateLimit != nil && l.RateLimit.Status == "rejected" {
			r.limited = true
			if l.RateLimit.ResetsAt > 0 {
				r.resetsAt = time.Unix(int64(l.RateLimit.ResetsAt), 0)
			}
		}
	case "result":
		var res claudeResult
		if json.Unmarshal(line, &res) == nil {
			r.result = &res
		}
		var events []programEvent
		for _, denial := range l.PermissionDenials {
			events = append(events, programEvent{Kind: evStep, Step: step{Tool: "Refused", Text: stepText(denial.ToolName)}})
		}
		return events
	}
	return nil
}

// step is a tool call as a step: Bash with the program's own description
// of the command, a file tool with its path in the folder, any other tool
// by its name.
func (r *claudeReader) step(tool string, input json.RawMessage) step {
	var in struct {
		Description  string `json:"description"`
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
	}
	_ = json.Unmarshal(input, &in) // an input of another form: the name alone
	s := step{Tool: stepText(tool)}
	switch tool {
	case "Bash":
		s.Text = stepText(in.Description)
	case "Edit", "Write", "Read", "MultiEdit", "NotebookEdit":
		path := in.FilePath
		if tool == "NotebookEdit" && path == "" {
			path = in.NotebookPath
		}
		if rel, ok := relativeIn(r.spec.Folder, path); ok {
			s.Text = stepText(rel)
		}
	}
	return s
}

// errorKind is the kind an "error" field names: the string itself, or an
// object's type.
func errorKind(raw json.RawMessage) string {
	var kind string
	if json.Unmarshal(raw, &kind) == nil {
		return kind
	}
	var obj struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Type != "" {
		return obj.Type
	}
	return "unknown"
}

func (r *claudeReader) End(exit int, stderr []byte) outcome {
	switch {
	case r.limited || r.apiError == "rate_limit" || r.apiError == "billing_error":
		return outcome{Kind: outcomeUsageLimit, ResetsAt: r.resetsAt, Detail: "the provider refused the turn: " + r.apiError}
	case r.apiError == "authentication_failed":
		return outcome{Kind: outcomeNotSignedIn, Detail: "the provider refused the sign-in"}
	case r.result != nil && !r.result.IsError && exit == 0:
		return outcome{Kind: outcomeOK, Final: r.result.Result}
	}
	text := []string{string(stderr)}
	if r.result != nil && r.result.IsError {
		text = append(text, r.result.Result)
		for _, e := range r.result.Errors {
			var s string
			if json.Unmarshal(e, &s) != nil {
				s = string(e)
			}
			text = append(text, s)
		}
	}
	return claudeWords.classify(strings.Join(text, "\n"), r.spec.Now())
}
