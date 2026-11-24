package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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
	Steps    []string `json:"steps"` // tool, or tool:text
}

// readFixture reads every fixture of a program through its reader.
func readFixtures(t *testing.T, p program) {
	t.Helper()
	const folder = "/home/p/devel/game"
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	files, _ := filepath.Glob(filepath.Join("testdata", "programs", p.Name()+"-*.jsonl"))
	for _, want := range []string{"fresh", "resume", "lost", "limit", "signedout", "error"} {
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
			reader := p.Reader(runSpec{Folder: folder, Now: func() time.Time { return now }, LastMessageFile: filepath.Join(t.TempDir(), "none")})
			var session string
			var steps []string
			for _, line := range lines[1:] {
				for _, ev := range reader.Line([]byte(line)) {
					switch ev.Kind {
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

func TestTheLoginSettingIsReadInEachFormTOMLHas(t *testing.T) {
	for _, text := range []string{
		"[shell_environment_policy.set]\nQUADIT_CONFIG = \"/x/a.json\"\n",
		"[shell_environment_policy]\ninherit = \"all\"\nset = { QUADIT_CONFIG = \"/x/a.json\", OTHER = \"1\" }\n",
		"shell_environment_policy.set.QUADIT_CONFIG = '/x/a.json'\n",
		"shell_environment_policy = { set = { QUADIT_CONFIG = \"/x/a.json\" } }\n",
	} {
		home := t.TempDir()
		_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o700)
		_ = os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte(text), 0o600)
		if got, ok := (codex{}).LoginSetting(home); !ok || got != "/x/a.json" {
			t.Fatalf("%q read as %q %v", text, got, ok)
		}
	}
	home := t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o700)
	_ = os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("[shell_environment_policy]\nexclude = [\"QUADIT_CONFIG\"]\n# QUADIT_CONFIG = \"/x\"\n[other]\nQUADIT_CONFIG = \"/y\"\n"), 0o600)
	if got, ok := (codex{}).LoginSetting(home); ok {
		t.Fatalf("read %q where nothing sets it", got)
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
