package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// fixtureHeader is the first line of a fixture of a program's output: how
// it was made, and what the reader must make of the lines after it.
type fixtureHeader struct {
	Fixture  string   `json:"fixture"` // synthetic, or recorded
	Exit     int      `json:"exit"`
	Stderr   string   `json:"stderr"`
	Expect   string   `json:"expect"`
	Final    string   `json:"final"`
	ResetsAt string   `json:"resets_at"`
	Session  string   `json:"session"`
	Steps    []string `json:"steps"` // tool, tool:text, or :text for the agent's words
	// Accepted is whether the provider took the turn (left out: not
	// checked); Last is what Codex wrote to its -o file.
	Accepted *bool  `json:"accepted"`
	Last     string `json:"last"`
}

// readFixture reads every fixture of a program through its reader.
func readFixtures(t *testing.T, p program) {
	t.Helper()
	const folder = "/home/p/devel/game"
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	files, _ := filepath.Glob(filepath.Join("testdata", "programs", p.Name()+"-*.jsonl"))
	for _, want := range []string{"fresh", "resume", "lost", "limit", "signedout", "error", "real-fresh", "real-resume", "real-lost", "real-tools"} {
		if !slices.Contains(files, filepath.Join("testdata", "programs", p.Name()+"-"+want+".jsonl")) {
			t.Fatalf("no fixture %s-%s", p.Name(), want)
		}
	}
	kinds := map[string]outcomeKind{"ok": outcomeOK, "usage_limit": outcomeUsageLimit, "not_signed_in": outcomeNotSignedIn, "lost_session": outcomeLostSession, "failed": outcomeFailed}
	for _, file := range files {
		t.Run(filepath.Base(file), func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(string(raw), "{folder}", folder)), "\n")
			var head fixtureHeader
			if err := json.Unmarshal([]byte(lines[0]), &head); err != nil || head.Fixture == "" {
				t.Fatalf("the first line is not a fixture's header: %s", lines[0])
			}
			last := filepath.Join(t.TempDir(), "last.txt")
			if head.Last != "" {
				_ = os.WriteFile(last, []byte(head.Last), 0o600) // as Codex 0.170.0 wrote it: no line break at the end
			}
			reader := p.Reader(runSpec{Folder: folder, Now: func() time.Time { return now }, LastMessageFile: last})
			var session string
			var steps []string
			accepted := false
			for _, line := range lines[1:] {
				if line == "" {
					continue
				}
				for _, ev := range reader.Line([]byte(line)) {
					switch ev.Kind {
					case evUnreadable:
						t.Fatalf("a line of the program's own output read as unreadable: %s", line)
					case evAccepted:
						accepted = true
					case evSession:
						session = ev.Session
					case evStep:
						s := ev.Step.Tool
						if ev.Step.Text != "" {
							s += ":" + ev.Step.Text
						}
						steps = append(steps, s)
					}
				}
			}
			out := reader.End(head.Exit, []byte(head.Stderr))
			if out.Kind != kinds[head.Expect] {
				t.Fatalf("read as %d (%s), want %s", out.Kind, out.Detail, head.Expect)
			}
			if out.Final != head.Final {
				t.Fatalf("final %q, want %q", out.Final, head.Final)
			}
			if head.ResetsAt != "" {
				want, _ := time.Parse(time.RFC3339, head.ResetsAt)
				if !out.ResetsAt.Equal(want) {
					t.Fatalf("resets at %s, want %s", out.ResetsAt.UTC(), want)
				}
			}
			if head.Session != "" && session != head.Session {
				t.Fatalf("session %q, want %q", session, head.Session)
			}
			if head.Steps != nil && !slices.Equal(steps, head.Steps) {
				t.Fatalf("steps %q, want %q", steps, head.Steps)
			}
			if head.Accepted != nil && accepted != *head.Accepted {
				t.Fatalf("accepted %v, want %v", accepted, *head.Accepted)
			}
		})
	}
}

func TestClaudeCodeOutputIsRead(t *testing.T) { readFixtures(t, claudeCode{}) }

func TestCodexOutputIsRead(t *testing.T) { readFixtures(t, codex{}) }

func TestUnknownOutputLinesArePassedOver(t *testing.T) {
	for _, p := range []program{claudeCode{}, codex{}} {
		t.Run(p.Name(), func(t *testing.T) {
			reader := p.Reader(runSpec{Folder: "/f", Now: time.Now})
			for _, line := range []string{"", "not json", "{", `{"type":"something_new","x":1}`, `{"type":"assistant","message":"a string"}`, `[1,2]`, `{"type":"item.started","item":null}`, strings.Repeat("x", 100000)} {
				// Passed over: nothing comes of it but, for a line that is not
				// the protocol's, that the attempt is not safe to repeat.
				if ev := reader.Line([]byte(line)); len(ev) > 1 || (len(ev) == 1 && ev[0].Kind != evAccepted && ev[0].Kind != evUnreadable) {
					t.Fatalf("the line %.40q gave %+v", line, ev)
				}
			}
			if out := reader.End(0, nil); out.Kind != outcomeFailed {
				t.Fatalf("an exit 0 without a finished turn read as %d", out.Kind)
			}
		})
	}
}

func TestTheCommandsAreArgumentLists(t *testing.T) {
	const session = "0199ffff-0000-7000-8000-00000000c1a1"
	for _, c := range []struct {
		p    program
		spec runSpec
		want string
	}{
		{claudeCode{}, runSpec{Session: session, Title: "SVA-12"}, "-p --output-format stream-json --verbose --session-id " + session + " --name SVA-12 --permission-mode bypassPermissions --disallowedTools AskUserQuestion"},
		{claudeCode{}, runSpec{Resume: session}, "-p --output-format stream-json --verbose --resume " + session + " --permission-mode bypassPermissions --disallowedTools AskUserQuestion"},
		{codex{}, runSpec{LastMessageFile: "/r/x-1.last.txt"}, "exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -o /r/x-1.last.txt -"},
		{codex{}, runSpec{Resume: session, LastMessageFile: "/r/x-2.last.txt"}, "exec resume --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -o /r/x-2.last.txt " + session + " -"},
	} {
		if got := strings.Join(c.p.Command(c.spec), " "); got != c.want {
			t.Fatalf("%s: %s\nwant %s", c.p.Name(), got, c.want)
		}
	}
}

func TestEverySettingThatCouldChangeTheLoginPauses(t *testing.T) {
	const login = "/logins/claude.json"
	type file struct{ path, text string }
	cases := []struct {
		name  string
		p     program
		files []file
		pause bool
	}{
		{"no settings at all", claudeCode{}, nil, false},
		{"Claude Code's settings without Quadit's", claudeCode{}, []file{{"home/.claude/settings.json", `{"env":{"FOO":"1"}}`}}, false},
		{"the entry's own login", claudeCode{}, []file{{"home/.claude/settings.json", `{"env":{"QUADIT_CONFIG":"` + login + `"}}`}}, false},
		{"another login in the user settings", claudeCode{}, []file{{"home/.claude/settings.json", `{"env":{"QUADIT_CONFIG":"/other.json"}}`}}, true},
		{"QUADIT_URL in the user settings", claudeCode{}, []file{{"home/.claude/settings.json", `{"env":{"QUADIT_URL":"http://x"}}`}}, true},
		{"QUADIT_WORKSPACE in the user settings", claudeCode{}, []file{{"home/.claude/settings.json", `{"env":{"QUADIT_WORKSPACE":"acme"}}`}}, true},
		{"QUADIT_TOKEN in the project settings", claudeCode{}, []file{{"folder/.claude/settings.json", `{"env":{"QUADIT_TOKEN":"t"}}`}}, true},
		{"another login in the project's local settings", claudeCode{}, []file{{"folder/.claude/settings.local.json", `{"env":{"QUADIT_CONFIG":"/other.json"}}`}}, true},
		{"QUADIT_URL in the project's local settings", claudeCode{}, []file{{"folder/.claude/settings.local.json", `{"env":{"QUADIT_URL":"http://x"}}`}}, true},
		{"project settings that do not parse", claudeCode{}, []file{{"folder/.claude/settings.json", `{"env":`}}, true},
		{"Codex without Quadit's", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy]\ninherit = \"all\"\n"}}, false},
		{"Codex with the entry's login", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy.set]\nQUADIT_CONFIG = \"" + login + "\"\n"}}, false},
		{"Codex with another login", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy.set]\nQUADIT_CONFIG = \"/other.json\"\n"}}, true},
		{"Codex with a quoted key", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy.set]\n'QUADIT_CONFIG' = '/other.json'\n"}}, true},
		{"Codex with QUADIT_URL inline", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy]\nset = { OTHER = \"1\", QUADIT_URL = \"http://x\" }\n"}}, true},
		{"Codex with QUADIT_WORKSPACE", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy.set]\nQUADIT_WORKSPACE = \"acme\"\n"}}, true},
		{"Codex with QUADIT_TOKEN dotted", codex{}, []file{{"home/.codex/config.toml", "shell_environment_policy.set.QUADIT_TOKEN = \"t\"\n"}}, true},
		{"Codex with a line too long to read", codex{}, []file{{"home/.codex/config.toml", "# " + strings.Repeat("x", 2<<20) + "\n"}}, true},
		{"Codex naming it elsewhere", codex{}, []file{{"home/.codex/config.toml", "[shell_environment_policy]\nexclude = [\"QUADIT_CONFIG\"]\n# QUADIT_URL = \"x\"\n[other]\nQUADIT_TOKEN = \"t\"\n"}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			home, folder := filepath.Join(dir, "home"), filepath.Join(dir, "folder")
			for _, f := range c.files {
				path := filepath.Join(dir, f.path)
				_ = os.MkdirAll(filepath.Dir(path), 0o700)
				_ = os.WriteFile(path, []byte(f.text), 0o600)
			}
			if got := settingsPause(c.p, home, folder, login); (got == core.PauseLoginMismatch) != c.pause {
				t.Fatalf("paused %q, want a pause: %v", got, c.pause)
			}
		})
	}
	t.Run("a settings file that cannot be read", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "home", ".claude", "settings.json")
		_ = os.MkdirAll(filepath.Dir(path), 0o700)
		_ = os.WriteFile(path, []byte(`{}`), 0o600)
		makeUnreadable(t, path)
		if got := settingsPause(claudeCode{}, filepath.Join(dir, "home"), filepath.Join(dir, "folder"), login); got != core.PauseLoginMismatch {
			t.Fatalf("an unreadable settings file read as %q", got)
		}
	})
}

// TestSettingsMayNameTheBaseLoginOfTheEntrysTool: an entry's login is
// one connection of a tool in several workspaces; the tool's settings name
// its base login, and the run's QUADIT_WORKSPACE chooses the entry's among
// its connections. Another tool's base is still another login.
func TestSettingsMayNameTheBaseLoginOfTheEntrysTool(t *testing.T) {
	dir := t.TempDir()
	logins := filepath.Join(dir, "quadit")
	base, login := filepath.Join(logins, "claude.json"), filepath.Join(logins, "claude-acme.json")
	_ = os.MkdirAll(logins, 0o700)
	idx := connectionIndex{Connections: []connection{
		{Tool: base, Login: base, WorkspaceID: personal.ID},
		{Tool: base, Login: login, WorkspaceID: acme.ID},
		{Tool: filepath.Join(logins, "codex.json"), Login: filepath.Join(logins, "codex.json"), WorkspaceID: acme.ID}}}
	if err := idx.write(logins); err != nil {
		t.Fatal(err)
	}
	home, folder := filepath.Join(dir, "home"), filepath.Join(dir, "folder")
	settings := filepath.Join(home, ".claude", "settings.json")
	_ = os.MkdirAll(filepath.Dir(settings), 0o700)
	for named, pause := range map[string]bool{base: false, login: false, filepath.Join(logins, "codex.json"): true} {
		writeJSON(t, settings, map[string]any{"env": map[string]string{"QUADIT_CONFIG": named}})
		if got := settingsPause(claudeCode{}, home, folder, login); (got == core.PauseLoginMismatch) != pause {
			t.Fatalf("settings naming %s paused %q, want a pause: %v", named, got, pause)
		}
	}
}

func TestAResetTimeIsTheNextSuchTime(t *testing.T) {
	now := time.Date(2026, 11, 24, 16, 30, 0, 0, time.UTC)
	for text, want := range map[string]string{
		"6pm":                "2026-11-24T18:00:00Z",
		"3:05 PM":            "2026-11-25T15:05:00Z",
		"18:15":              "2026-11-24T18:15:00Z",
		"Nov 25th, 9:00 a.m": "2026-11-25T09:00:00Z",
	} {
		got, ok := nextTimeOfDay(text, "", now)
		if w, _ := time.Parse(time.RFC3339, want); !ok || !got.Equal(w) {
			t.Fatalf("%q read as %s %v, want %s", text, got, ok, want)
		}
	}
	got, _ := nextTimeOfDay("6pm", "America/New_York", now)
	if got.UTC().Format(time.RFC3339) != "2026-11-24T23:00:00Z" {
		t.Fatalf("6pm in New York read as %s", got.UTC())
	}
	if _, ok := nextTimeOfDay("soon", "", now); ok {
		t.Fatal("no time read as one")
	}
}

func TestALineTooLongIsSaidDiscarded(t *testing.T) {
	long := strings.Repeat("x", maxLine+10)
	var got []bool
	eachLine(strings.NewReader("ok\n"+long+"\nafter\n"), func(_ []byte, discarded bool) { got = append(got, discarded) })
	if !slices.Equal(got, []bool{false, true, false}) {
		t.Fatalf("got %v", got)
	}
}

func TestToolEvidenceIsReadOnEitherEdge(t *testing.T) {
	kinds := func(r streamReader, lines ...string) []eventKind {
		var out []eventKind
		for _, l := range lines {
			for _, ev := range r.Line([]byte(l)) {
				out = append(out, ev.Kind)
			}
		}
		return out
	}
	spec := runSpec{Folder: "/f", Now: time.Now}
	if got := kinds((codex{}).Reader(spec), `{"type":"item.started","item":null}`); len(got) != 0 {
		t.Fatalf("an event with no item read as %v", got)
	}
	if got := kinds((codex{}).Reader(spec), `{"type":"item.completed","item":{"id":"i1","type":"command_execution","status":"completed"}}`); !slices.Contains(got, evTool) {
		t.Fatalf("a command seen only completed read as %v", got)
	}
	both := kinds((codex{}).Reader(spec), `{"type":"item.started","item":{"id":"i1","type":"command_execution"}}`, `{"type":"item.completed","item":{"id":"i1","type":"command_execution"}}`)
	if n := len(slices.DeleteFunc(both, func(k eventKind) bool { return k != evStep })); n != 1 {
		t.Fatalf("one command made %d steps", n)
	}
	if got := kinds((claudeCode{}).Reader(spec), `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}`); !slices.Contains(got, evTool) {
		t.Fatalf("a tool's result read as %v", got)
	}
}

func TestOnlyARejectedRateLimitIsAUsageLimit(t *testing.T) {
	// As Claude Code 2.1.331 prints it on every run, with rejected statuses
	// nested where they do not mean the turn was refused.
	warning := `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1795575600,"overageStatus":"rejected",` +
		`"unifiedWindows":{"seven_day":{"status":"rejected","resetsAt":1795575600}}}}`
	r := (claudeCode{}).Reader(runSpec{Now: time.Now})
	for _, line := range []string{warning, `{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}`, `{"type":"result","subtype":"success","is_error":false,"result":"ok"}`} {
		r.Line([]byte(line))
	}
	if out := r.End(0, nil); out.Kind != outcomeOK {
		t.Fatalf("a warning read as %d", out.Kind)
	}
	r = (claudeCode{}).Reader(runSpec{Now: time.Now})
	r.Line([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795575600}}`))
	if out := r.End(1, nil); out.Kind != outcomeUsageLimit || out.ResetsAt.Unix() != 1795575600 {
		t.Fatalf("a rejected turn read as %d, resets %s", out.Kind, out.ResetsAt)
	}
}

func TestTheAgentsWordsOnTheWayAreStepsAndItsLastAreNot(t *testing.T) {
	steps := func(r streamReader, lines ...string) []step {
		var out []step
		for _, l := range lines {
			for _, ev := range r.Line([]byte(l)) {
				if ev.Kind == evStep {
					out = append(out, ev.Step)
				}
			}
		}
		return out
	}
	message := func(text string) string {
		raw, _ := json.Marshal(map[string]any{"type": "item.completed", "item": map[string]any{"id": "m", "type": "agent_message", "text": text}})
		return string(raw)
	}
	spec := runSpec{Folder: "/f", Now: time.Now}
	long := "First line\n\twith a tab\x07 and " + strings.Repeat("é", 400)
	got := steps((codex{}).Reader(spec), message(long), message("Then this."), message("Done."), `{"type":"turn.completed"}`)
	if len(got) != 2 || got[0].Tool != "" || got[1].Text != "Then this." {
		t.Fatalf("the steps are %+v", got)
	}
	if first := []rune(got[0].Text); len(first) != maxStepText || !strings.HasPrefix(got[0].Text, "First line with a tab and é") || first[len(first)-1] != '…' {
		t.Fatalf("a long message on several lines became %q", got[0].Text)
	}
	if got := steps((codex{}).Reader(spec), message("Done.")); len(got) != 0 {
		t.Fatalf("the final answer alone made the steps %+v", got)
	}
	text := `{"type":"assistant","message":{"content":[{"type":"text","text":"Running the tests."}]}}`
	bash := `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"go test ./...","description":"Run the tests"}}]}}`
	final := `{"type":"assistant","message":{"content":[{"type":"text","text":"All pass."}]}}`
	if got := steps((claudeCode{}).Reader(spec), text, bash, final, `{"type":"result","subtype":"success","is_error":false,"result":"All pass."}`); len(got) != 2 ||
		got[0] != (step{Text: "Running the tests."}) || got[1] != (step{Tool: "Bash", Text: "Run the tests"}) {
		t.Fatalf("the steps are %+v", got)
	}
}
