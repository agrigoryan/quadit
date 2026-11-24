// The agent programs `quadit run` starts, behind one interface: how to
// start one for an attempt, how to read what it prints, where it keeps its
// sessions and its settings. One file per program (run_claude.go,
// run_codex.go).

package cli

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/agrigoryan/quadit/internal/core"
)

// program is one agent program the runner starts: how to start it for a
// run, how to read what it prints, and where it keeps its sessions. A new
// program is one more value of this interface, one constant in core
// (core.Programs) and its words in the web app.
type program interface {
	// Name is its core.Programs name; Title what a person reads ("Claude Code").
	Name() string
	Title() string
	// Command is the argument list after the program's path for one attempt:
	// a fresh session (spec.Session for one the runner chose, "" for one the
	// program chooses) or a resumed one (spec.Resume, a canonical UUID). The
	// prompt is never an argument: it goes on standard input. Always an
	// argument list, never a shell's line.
	Command(spec runSpec) []string
	// Reader reads one attempt's standard output, a line at a time.
	Reader(spec runSpec) streamReader
	// SignedIn is the argument list of its passive sign-in check, and
	// ReadSignedIn what its exit status and output say: signed in, not, or
	// an error when the check itself could not tell.
	SignedIn() []string
	ReadSignedIn(exit int, output []byte) (bool, error)
	// SessionFile is the file the program keeps that session in, if found.
	SessionFile(home, session, folder string) (string, bool)
	// ResumeLine is the command a person runs in a terminal to go on with
	// it (for the log; the web builds its own).
	ResumeLine(folderLabel, session string) string
	// QuaditSettings are the QUADIT_CONFIG, QUADIT_URL and QUADIT_TOKEN its
	// own settings set for the commands it runs, in every file that can
	// (the user's, and the folder's), whichever wins: such a setting would
	// make a run work as another login. An error names a settings file that
	// exists but could not be read: what it sets is not known.
	QuaditSettings(home, folder string) ([]quaditSetting, error)
}

// quaditSetting is one QUADIT_ variable a program's settings set.
type quaditSetting struct{ File, Name, Value string }

// quaditVariables are the variables that choose the login the quadit
// command works as.
var quaditVariables = []string{"QUADIT_CONFIG", "QUADIT_URL", "QUADIT_TOKEN"}

// programs are the programs a runner starts, by their core.Programs name.
var programs = map[string]program{
	core.ProgramClaude: claudeCode{},
	core.ProgramCodex:  codex{},
}

// runSpec is what one attempt is started with.
type runSpec struct {
	Session         string // Claude Code: the UUID to start with
	Resume          string // the session to resume ("" for a fresh one)
	Title           string // the session's display name: the task's key only ("SVA-12")
	LastMessageFile string // where the program writes its last message, when it can (Codex -o)
	Folder          string // the folder it works in, which the paths of its steps are made relative to
	// Now is the clock a reset time said as a time of day is read against.
	Now func() time.Time
}

// streamReader turns the program's standard output into events. Lines it
// does not know are passed over, never fatal; every line on either output
// counts as output for the idle watchdog (the caller's).
type streamReader interface {
	Line(line []byte) []programEvent
	// End is called once the program has exited and its output is drained,
	// with its exit status (-1: ended by a signal) and its standard error,
	// and gives the outcome.
	End(exit int, stderr []byte) outcome
}

// programEvent is one thing the program's output said.
type programEvent struct {
	Kind    eventKind
	Session string // evSession
	Step    step   // evStep
	Text    string // evText: an assistant message (only ever used as the final message)
}

type eventKind int

const (
	evSession    eventKind = iota // the program said its session id
	evAccepted                    // the provider took the turn
	evTool                        // tool activity began (the work may have had effects); comes with evStep
	evStep                        // a step for the record
	evText                        // an assistant message
	evUnreadable                  // a line on the protocol's output that could not be read: it may have been a tool's
)

// step is one step of a run as the server keeps it: a tool's name and,
// when the program gives one, a short description or a path relative to
// the folder; never a command line or a tool's input.
type step struct {
	Tool string `json:"tool"`
	Text string `json:"text,omitempty"`
	At   int64  `json:"at"`
}

// outcome is how an attempt ended, decided once the program exited: from
// structured error fields first, then from the program's own error output
// (its standard error, and the error text of its structured error events),
// never from the model's text.
type outcome struct {
	Kind     outcomeKind
	ResetsAt time.Time // usageLimit, when said
	Final    string    // the final message: Claude Code's successful result text, Codex's last message of this attempt
	Detail   string    // for the log
}

type outcomeKind int

const (
	outcomeFailed outcomeKind = iota
	outcomeOK
	outcomeUsageLimit
	outcomeNotSignedIn
	outcomeLostSession
)

// unreadable is what a line of the protocol's output that could not be
// read says: nothing for a blank line, else that it may have been a
// tool's (the attempt is not repeated).
func unreadable(line []byte) []programEvent {
	if len(bytes.TrimSpace(line)) == 0 {
		return nil
	}
	return []programEvent{{Kind: evUnreadable}}
}

// maxFinal is the most of a program's last message read: the fallback
// comment keeps less.
const maxFinal = 64 << 10

// readAtMost is the start of a file, at most n bytes; nothing when it
// cannot be read.
func readAtMost(path string, n int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	raw, _ := io.ReadAll(io.LimitReader(f, n)) // what was read is what there is
	return raw
}

// maxStepText is the most of a step's text kept; the server cuts longer.
const maxStepText = 200

// stepText is a tool's name or text as a step carries it: on one line,
// no control characters, at most maxStepText characters.
func stepText(s string) string {
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if r := []rune(s); len(r) > maxStepText {
		s = string(r[:maxStepText-1]) + "…"
	}
	return s
}

// relativeIn is path relative to folder, when it is inside it; a path
// outside the folder (or one that climbs out of it) is not given.
func relativeIn(folder, path string) (string, bool) {
	if path == "" {
		return "", false
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(folder, path)
	}
	rel, err := filepath.Rel(folder, filepath.Clean(path))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", false
	}
	return rel, true
}

// errorWords are the program's own error words the runner reads after an
// attempt, when no structured field said what happened.
type errorWords struct {
	lostSession, usageLimit, notSignedIn *regexp.Regexp
	// resetAt finds the time a usage limit resets in its words: its
	// submatch "time" is a time of day, "zone" an optional zone name.
	resetAt *regexp.Regexp
}

// classify reads text (the program's standard error and the text of its
// error events, never the model's) for what ended an attempt that did not
// end well.
func (w errorWords) classify(text string, now time.Time) outcome {
	detail := strings.TrimSpace(text)
	if len(detail) > 500 {
		detail = detail[len(detail)-500:]
	}
	switch {
	case w.lostSession.MatchString(text):
		return outcome{Kind: outcomeLostSession, Detail: detail}
	case w.usageLimit.MatchString(text):
		out := outcome{Kind: outcomeUsageLimit, Detail: detail}
		if m := w.resetAt.FindStringSubmatch(text); m != nil {
			out.ResetsAt, _ = nextTimeOfDay(m[w.resetAt.SubexpIndex("time")], m[w.resetAt.SubexpIndex("zone")], now) // a time not read: the back-off decides
		}
		return out
	case w.notSignedIn.MatchString(text):
		return outcome{Kind: outcomeNotSignedIn, Detail: detail}
	}
	return outcome{Kind: outcomeFailed, Detail: detail}
}

// timeOfDay is a time of day as programs say it: 6pm, 6:30 pm, 18:00, 6:30 PM.
var timeOfDay = regexp.MustCompile(`(?i)(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b|(\d{1,2}):(\d{2})`)

// nextTimeOfDay is the next moment after now at the time of day the last
// such time in text says, in the zone named (an IANA name), else in now's.
func nextTimeOfDay(text, zone string, now time.Time) (time.Time, bool) {
	loc := now.Location()
	if zone != "" {
		if l, err := time.LoadLocation(strings.TrimSpace(zone)); err == nil {
			loc = l
		}
	}
	all := timeOfDay.FindAllStringSubmatch(text, -1)
	if len(all) == 0 {
		return time.Time{}, false
	}
	m := all[len(all)-1]
	var hour, minute int
	if m[1] != "" {
		hour, _ = strconv.Atoi(m[1])
		minute, _ = strconv.Atoi(m[2]) // empty: on the hour
		if hour < 1 || hour > 12 {
			return time.Time{}, false
		}
		hour %= 12
		if strings.EqualFold(m[3], "p") {
			hour += 12
		}
	} else {
		hour, _ = strconv.Atoi(m[4])
		minute, _ = strconv.Atoi(m[5])
	}
	if hour > 23 || minute > 59 {
		return time.Time{}, false
	}
	at := now.In(loc)
	next := time.Date(at.Year(), at.Month(), at.Day(), hour, minute, 0, 0, loc)
	if !next.After(at) {
		next = next.AddDate(0, 0, 1)
	}
	return next, true
}

// versionForm finds a program's version in what --version prints
// ("2.1.331 (Claude Code)", "codex-cli 0.170.0").
var versionForm = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.+-]*)?`)

// programVersion is the version in what --version printed, in the form a
// server takes, or "" for none.
func programVersion(out []byte) string {
	v := versionForm.FindString(string(out))
	if len(v) > 32 {
		v = v[:32]
	}
	return v
}

// shellQuoted is s quoted for a POSIX shell, for a line a person copies.
func shellQuoted(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// folderForShell is a folder label (~/devel/game) as a shell line takes
// it, ~ left out of the quotes so the shell expands it.
func folderForShell(label string) string {
	if rest, ok := strings.CutPrefix(label, "~/"); ok {
		return "~/" + shellQuoted(rest)
	}
	return shellQuoted(label)
}
