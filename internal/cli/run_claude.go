// Claude Code as a program the runner starts.
//
// Checked against `claude --help` of 2.1.331: -p, --output-format
// stream-json, --verbose, --session-id (a valid UUID), --resume, -n/--name,
// --permission-mode bypassPermissions, --disallowedTools; `claude auth
// status` exists. The prompt goes on standard input (`claude -p` with no
// prompt argument reads it). --disallowedTools takes every word after it,
// so it is always the last argument.
//
// Verified against real output of Claude Code 2.1.331 (2026-11-24, kept
// sanitized in testdata/programs/claude-real-*.jsonl): a fresh run with
// --session-id and a resume of it print system/session_title_changed,
// system/init (the session id chosen), assistant, rate_limit_event and a
// result (success, is_error false, the final text), exit 0; every run
// carries a rate_limit_event, here with status "allowed_warning", resetsAt
// in seconds, and "rejected" in other fields (overageStatus, the nested
// windows), so only rate_limit_info.status "rejected" is a usage limit; a
// resume of a session that does not exist prints one result
// (error_during_execution, is_error true, num_turns 0, errors ["No
// conversation found with session ID: …"]) and the same words on standard
// error, exit 1. A run with tools (claude-real-tools.jsonl) prints each
// block of a message as an assistant line of its own under the message's
// id: a thinking block (empty, signed), a text with the agent's own
// sentence of what it will do, then a tool_use (Bash with input.command
// and input.description; Write with an absolute input.file_path); the
// tool's result as a user line with a tool_result; system/thinking_tokens
// lines between; and last a message of text alone, the result's text.
//
// UNVERIFIED, and read so that being wrong fails safe (a line or field not
// known is passed over; an error not recognized is a plain failure, which
// is retried only before any work):
//   - a real usage limit: a rejected rate_limit_event, and the kinds an
//     assistant message's "error" field takes (rate_limit, billing_error,
//     authentication_failed, …), from the Agent SDK's message types;
//   - a real sign-in failure, and the usage-limit and sign-in words of
//     claudeWords with the reset time in them;
//   - the tool_use of tools other than Bash and Write (Edit, Read,
//     MultiEdit, NotebookEdit and the rest), and permission denials;
//   - `claude auth status` exiting 0 when signed in and 1 when not;
//   - where a session is kept: <config>/projects/<claudeProjectName of
//     the folder>/<id>.jsonl, read in the Agent SDK's code, not in Claude
//     Code's own (a compiled program), nor seen on Windows;
//   - that a settings env.QUADIT_* reaches the program's Bash tool (the
//     runner pauses on any, whichever wins).
// testdata/programs/claude-{fresh,resume,lost,limit,signedout,error}.jsonl
// are written by hand in the documented form.

package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
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

// claudeProjectName is the name Claude Code gives the folder it keeps a
// project's sessions in, from the project folder's path: every UTF-16 unit
// that is not an ASCII letter or digit made "-" (C:\Users\ann\game is
// C--Users-ann-game), and a name longer than 200 cut there, followed by
// "-" and a hash of the whole path in base 36 (a Java string hash, made
// positive). As the Agent SDK's published code does it (0.3.332).
func claudeProjectName(folder string) string {
	units := utf16.Encode([]rune(folder))
	name := make([]byte, len(units))
	var hash int32
	for i, u := range units {
		name[i] = '-'
		if u < 0x80 && (unicode.IsLetter(rune(u)) || unicode.IsDigit(rune(u))) {
			name[i] = byte(u)
		}
		hash = hash*31 + int32(u)
	}
	const most = 200
	if len(name) <= most {
		return string(name)
	}
	positive := int64(hash)
	if positive < 0 {
		positive = -positive
	}
	return string(name[:most]) + "-" + strconv.FormatInt(positive, 36)
}

func (claudeCode) SessionFile(home, session, folder string) (string, bool) {
	path := filepath.Join(claudeHome(home), "projects", claudeProjectName(folder), session+".jsonl")
	if st, err := os.Stat(path); err == nil && st.Mode().IsRegular() {
		return path, true
	}
	return "", false
}

// QuaditSettings reads the env of the user's settings and of both of the
// folder's own (.claude/settings.json and .claude/settings.local.json).
func (claudeCode) QuaditSettings(home, folder string) ([]quaditSetting, error) {
	var out []quaditSetting
	for _, path := range []string{filepath.Join(claudeHome(home), "settings.json"), filepath.Join(folder, ".claude", "settings.json"),
		filepath.Join(folder, ".claude", "settings.local.json")} {
		raw, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		var settings struct {
			Env map[string]json.RawMessage `json:"env"`
		}
		if err := json.Unmarshal(raw, &settings); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		for _, name := range quaditVariables {
			if v, ok := settings.Env[name]; ok {
				var s string
				if json.Unmarshal(v, &s) != nil {
					s = string(v) // not a string: set all the same
				}
				out = append(out, quaditSetting{File: path, Name: name, Value: s})
			}
		}
	}
	return out, nil
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
	words    agentWords
}

// claudeResult is the result line, the last of a turn.
type claudeResult struct {
	IsError bool              `json:"is_error"`
	Result  string            `json:"result"`
	Errors  []json.RawMessage `json:"errors"`
}

// claudeBlock is one block of a message's content.
type claudeBlock struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// claudeLine is one line of the output, with the fields the reader uses.
type claudeLine struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	SessionID string          `json:"session_id"`
	Error     json.RawMessage `json:"error"`
	Message   *struct {
		Content []claudeBlock `json:"content"`
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
		return unreadable(line)
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
				events = append(events, r.words.said(block.Text)...)
			case "tool_use":
				events = append(events, r.words.acted()...)
				events = append(events, programEvent{Kind: evTool}, programEvent{Kind: evStep, Step: r.step(block.Name, block.Input)})
			}
		}
		return events
	case "user":
		// A tool's result: the tool ran, whether or not its call was read.
		if l.Message != nil && slices.ContainsFunc(l.Message.Content, func(b claudeBlock) bool { return b.Type == "tool_result" }) {
			return []programEvent{{Kind: evTool}}
		}
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
		final := r.result.Result
		if len(final) > maxFinal {
			final = final[:maxFinal]
		}
		return outcome{Kind: outcomeOK, Final: final}
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
