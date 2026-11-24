// Package fakeagent is a stand-in, for tests, for the agent programs `quadit
// run` starts: Claude Code and Codex. A test binary whose TestMain calls
// Main first becomes one when the environment says which (FAKEAGENT), so
// a test gives the runner its own binary as the program's path.
//
// It answers --version and the sign-in checks (`auth status`, `login
// status`) at once. Any other start reads its prompt from standard input,
// records what it was started with (FAKEAGENT_RECORD), and plays a script
// (FAKEAGENT_SCRIPTS): the Nth start plays the Nth script, the last one
// again past the end. Scripts print the programs' output formats, so the
// runner reads the fake as it reads the real programs.
//
// The environment it reads:
//
//	FAKEAGENT          claude or codex: which program to be
//	FAKEAGENT_SCRIPTS  a JSON file: a list of scripts, each a list of steps
//	FAKEAGENT_RECORD   a file each start appends one JSON line to (Record),
//	                   each grandchild it starts one more ({"child": pid}), and
//	                   each SIGINT it passes over one more ({"signal": …})
//	FAKEAGENT_SIGNIN   when set, the program is signed in only while this
//	                   file exists
//	FAKEAGENT_VERSION_GATE  when set, --version waits while this file exists
//	                   (writing FILE.waiting meanwhile)
package fakeagent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// NewThread is the thread id a fresh Codex session says it is ({thread}).
const NewThread = "5f0c6a2e-1b7d-4c3e-9a8f-2d4b6e8c0a11"

// Versions are what --version prints.
const (
	ClaudeVersion = "2.1.331 (Claude Code)"
	CodexVersion  = "codex-cli 0.170.0"
)

// Step is one step of a script; one field is set.
type Step struct {
	Out         string   `json:"out,omitempty"`          // a line to standard output; {session} and {thread} filled in
	Err         string   `json:"err,omitempty"`          // a line to standard error
	SleepMS     int      `json:"sleep_ms,omitempty"`     // wait this long
	UntilSignal []string `json:"until_signal,omitempty"` // block until SIGINT or SIGTERM, then print these lines
	Ignore      string   `json:"ignore,omitempty"`       // "SIGINT": ignore it from now on
	Child       bool     `json:"child,omitempty"`        // start `sleep 600` in the same process group, holding standard output
	Touch       string   `json:"touch,omitempty"`        // make or touch this file ({session} filled in)
	Last        string   `json:"last,omitempty"`         // write this as the last message (Codex -o)
	LinesFrom   string   `json:"lines_from,omitempty"`   // print every line of this file but its first, as out does
	Exit        *int     `json:"exit,omitempty"`         // exit now with this status
}

// Record is what one start was given.
type Record struct {
	Argv   []string          `json:"argv"`
	Dir    string            `json:"dir"`
	Stdin  string            `json:"stdin"`
	Env    map[string]string `json:"env"` // QUADIT_*, CLAUDECODE, CLAUDE_CODE_*, ELECTRON_*
	PID    int               `json:"pid"`
	Start  int               `json:"start"` // which start this was, from 0
	Child  int               `json:"child,omitempty"`
	Signal string            `json:"signal,omitempty"` // a signal it caught and passed over`
}

// Main acts as the program FAKEAGENT names, and exits; it returns false,
// doing nothing, when FAKEAGENT names none.
func Main() bool {
	which := os.Getenv("FAKEAGENT")
	if which != "claude" && which != "codex" {
		return false
	}
	os.Exit(run(which, os.Args[1:]))
	return true
}

func run(which string, args []string) int {
	switch {
	case len(args) == 1 && args[0] == "--version":
		if gate := os.Getenv("FAKEAGENT_VERSION_GATE"); gate != "" {
			// A test holds the version check here: while the gate is there,
			// it waits, and says so beside the gate.
			for {
				if _, err := os.Stat(gate); err != nil {
					break
				}
				_ = os.WriteFile(gate+".waiting", nil, 0o600) // the test's barrier
				time.Sleep(5 * time.Millisecond)
			}
		}
		fmt.Println(map[string]string{"claude": ClaudeVersion, "codex": CodexVersion}[which])
		return 0
	case len(args) == 2 && (args[0] == "auth" || args[0] == "login") && args[1] == "status":
		if path := os.Getenv("FAKEAGENT_SIGNIN"); path != "" {
			if _, err := os.Stat(path); err != nil {
				fmt.Println("Not logged in")
				return 1
			}
		}
		fmt.Println("Logged in")
		return 0
	}
	session, lastFile := sessionOf(which, args)
	prompt, _ := io.ReadAll(os.Stdin) // a prompt not read is recorded empty
	start := claimStart(os.Getenv("FAKEAGENT_SCRIPTS"))
	dir, _ := os.Getwd()
	record(Record{Argv: args, Dir: dir, Stdin: string(prompt), Env: seenEnv(), PID: os.Getpid(), Start: start})
	fill := strings.NewReplacer("{session}", session, "{thread}", NewThread)
	ignored := false
	for _, step := range script(start) {
		switch {
		case step.Out != "":
			fmt.Println(fill.Replace(step.Out))
		case step.Err != "":
			fmt.Fprintln(os.Stderr, fill.Replace(step.Err))
		case step.SleepMS > 0:
			time.Sleep(time.Duration(step.SleepMS) * time.Millisecond)
		case step.UntilSignal != nil:
			signals := []os.Signal{syscall.SIGTERM}
			if !ignored {
				signals = append(signals, os.Interrupt)
			}
			ch := make(chan os.Signal, 1)
			signal.Notify(ch, signals...)
			<-ch
			signal.Stop(ch)
			for _, line := range step.UntilSignal {
				fmt.Println(fill.Replace(line))
			}
		case step.Ignore == "SIGINT":
			// Caught and passed over, not ignored by the system, so each one
			// is recorded: a test's barrier.
			interrupts := make(chan os.Signal, 4)
			signal.Notify(interrupts, os.Interrupt)
			go func() {
				for range interrupts {
					record(Record{Signal: "interrupt", Start: start})
				}
			}()
			ignored = true
		case step.Child:
			child := exec.CommandContext(context.Background(), "sleep", "600") // the fake's own main: nothing above it to end it
			child.Stdout = os.Stdout
			if child.Start() == nil {
				record(Record{Child: child.Process.Pid, Start: start})
			}
		case step.Touch != "":
			path := fill.Replace(step.Touch)
			if f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
				_, _ = f.WriteString("{}\n") // the file's size changes with each touch
				f.Close()
			}
		case step.Last != "":
			if lastFile != "" {
				_ = os.WriteFile(lastFile, []byte(step.Last), 0o600) // no file: Codex wrote none
			}
		case step.LinesFrom != "":
			printLines(step.LinesFrom, fill)
		case step.Exit != nil:
			return *step.Exit
		}
	}
	return 0
}

// sessionOf is the session a start names (Claude Code's --session-id or
// --resume, Codex's resumed id) and Codex's last-message file.
func sessionOf(which string, args []string) (session, lastFile string) {
	for i := range args {
		switch {
		case (args[i] == "--session-id" || args[i] == "--resume") && i+1 < len(args):
			session = args[i+1]
		case args[i] == "-o" && i+1 < len(args):
			lastFile = args[i+1]
		}
	}
	if which == "codex" && len(args) > 2 && args[1] == "resume" && args[len(args)-1] == "-" {
		session = args[len(args)-2]
	}
	return session, lastFile
}

// claimStart is this start's number: the first n whose mark file it makes.
func claimStart(scripts string) int {
	if scripts == "" {
		return 0
	}
	for n := 0; ; n++ {
		f, err := os.OpenFile(scripts+".start-"+strconv.Itoa(n), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			f.Close()
			return n
		}
		if !os.IsExist(err) {
			return n
		}
	}
}

// script is the script of start n: the Nth, the last one past the end,
// none without scripts.
func script(n int) []Step {
	raw, err := os.ReadFile(os.Getenv("FAKEAGENT_SCRIPTS"))
	if err != nil {
		return nil
	}
	var scripts [][]Step
	if json.Unmarshal(raw, &scripts) != nil || len(scripts) == 0 {
		return nil
	}
	return scripts[min(n, len(scripts)-1)]
}

// seenEnv are the variables of the environment a test checks.
func seenEnv() map[string]string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		name, value, _ := strings.Cut(kv, "=")
		if name == "CLAUDECODE" || strings.HasPrefix(name, "CLAUDE_CODE_") || strings.HasPrefix(name, "QUADIT_") || strings.HasPrefix(name, "ELECTRON_") {
			env[name] = value
		}
	}
	return env
}

// record appends one line to FAKEAGENT_RECORD.
func record(r Record) {
	path := os.Getenv("FAKEAGENT_RECORD")
	if path == "" {
		return
	}
	raw, _ := json.Marshal(r) // a Record always encodes
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(raw, '\n')) // a record lost shows in the test that reads it
}

// printLines prints every line of a file but its first (a fixture's
// header), filled in.
func printLines(path string, fill *strings.Replacer) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for first := true; scan.Scan(); first = false {
		if !first {
			fmt.Println(fill.Replace(scan.Text()))
		}
	}
}

// Records reads what FAKEAGENT_RECORD holds at path.
func Records(path string) []Record {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []Record
	for line := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		var r Record
		if json.Unmarshal([]byte(line), &r) == nil {
			out = append(out, r)
		}
	}
	return out
}
