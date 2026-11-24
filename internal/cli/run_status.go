// What `quadit run` tells the person and the desktop app: a line for each
// thing that happens (on standard output and in runner.log), and what each
// entry is doing now (status.json, which `quadit run list` reads), in the
// words both use.

package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// The states of an entry in status.json.
const (
	statusStarting = "starting" // its checks run
	statusReady    = "ready"
	statusWorking  = "working"
	statusPaused   = "paused" // Pause says why, Until till when for a usage limit
	statusAside    = "aside"  // a chat holds the project's listener
	statusRemoving = "removing"
	statusError    = "error" // Message says what
)

// entryStatus is what an entry is doing now.
type entryStatus struct {
	State   string
	Task    string    // working: the task's key
	Since   time.Time // working: when the run was received
	Pause   string
	Until   time.Time
	Message string
}

// statusFile is status.json.
type statusFile struct {
	Version int                    `json:"version"`
	PID     int                    `json:"pid"`
	At      string                 `json:"at"`
	Machine machine                `json:"machine"`
	Entries map[string]statusEntry `json:"entries"`
}

// statusEntry is one entry in status.json.
type statusEntry struct {
	State   string         `json:"state"`
	Task    string         `json:"task"`
	Since   string         `json:"since"`
	Pause   string         `json:"pause"`
	Until   string         `json:"until"`
	Message string         `json:"message"`
	Blocked []blockedWrite `json:"blocked"`
}

// statusBoard keeps status.json, written whole on every change.
type statusBoard struct {
	mu      sync.Mutex
	path    string
	machine machine
	clock   runClock
	entries map[string]statusEntry
}

// set says what an entry is doing, with the writes of its that the server
// refused for good.
func (b *statusBoard) set(id string, st entryStatus, blocked []blockedWrite) {
	if blocked == nil {
		blocked = []blockedWrite{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.entries[id] = statusEntry{State: st.State, Task: st.Task, Since: utcTime(st.Since), Pause: st.Pause, Until: utcTime(st.Until), Message: st.Message, Blocked: blocked}
	b.write()
}

// drop says nothing more of an entry that is no longer served.
func (b *statusBoard) drop(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.entries, id)
	b.write()
}

// write writes status.json; the caller holds b.mu. A status not written
// is written with the next change.
func (b *statusBoard) write() {
	_ = writeWhole(b.path, plainJSON(statusFile{Version: 1, PID: os.Getpid(), At: utcTime(b.clock.Now()), Machine: b.machine, Entries: b.entries}))
}

// readStatus reads status.json, empty when there is none.
func readStatus(path string) statusFile {
	var s statusFile
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &s) // a status not read shows no status
	}
	return s
}

// utcTime is a time in status.json's form, "" for none.
func utcTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// setStatus says what the entry is doing now.
func (e *liveEntry) setStatus(st entryStatus) {
	e.mu.Lock()
	e.shown = st
	e.mu.Unlock()
	e.srv.status.set(e.reg.ID, st, e.out.failed())
}

// refreshStatus writes the entry's status again, with its blocked writes
// as they are now.
func (e *liveEntry) refreshStatus() {
	e.mu.Lock()
	st := e.shown
	e.mu.Unlock()
	e.srv.status.set(e.reg.ID, st, e.out.failed())
}

// shownState is the state the entry shows now.
func (e *liveEntry) shownState() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.shown.State
}

// printer prints the runner's lines to standard output and to runner.log,
// there with the time in front; past logLimit the log starts a new file,
// keeping one old one.
type printer struct {
	mu    sync.Mutex
	out   io.Writer
	path  string
	clock runClock
}

// logLimit is the size past which runner.log starts anew.
const logLimit = 5 << 20

// say prints one line.
func (p *printer) say(line string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	fmt.Fprintln(p.out, line)
	if p.path == "" {
		return
	}
	if st, err := os.Stat(p.path); err == nil && st.Size() > logLimit {
		_ = os.Rename(p.path, p.path+".old") // not renamed: the log grows on
	}
	f, err := os.OpenFile(p.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "%s %s\n", p.clock.Now().UTC().Format(time.RFC3339), line) // a line not logged was printed
}

// sayEntry prints a line about the entry: "SVA @claude ~/devel/game: …".
func (e *liveEntry) sayEntry(format string, args ...any) {
	e.srv.print.say(fmt.Sprintf("%s %s %s: ", e.reg.Project, e.reg.Agent, e.label) + fmt.Sprintf(format, args...))
}

// sayRun prints a line about a run of a task: "SVA-12 @claude: …".
func (e *liveEntry) sayRun(task, format string, args ...any) {
	e.srv.print.say(fmt.Sprintf("%s %s: ", task, e.reg.Agent) + fmt.Sprintf(format, args...))
}

// pauseWords say why an entry is paused, as lines and lists print it.
func pauseWords(reason, program string, until time.Time) string {
	switch reason {
	case core.PauseUsageLimit:
		if until.IsZero() {
			return program + "'s usage limit"
		}
		return program + "'s usage limit, until " + until.Local().Format("15:04")
	case core.PauseNotSignedIn:
		return program + " is not signed in (" + map[string]string{"Claude Code": "claude auth login", "Codex": "codex login"}[program] + ")"
	case core.PauseProgramMissing:
		return program + " was not found, or is no longer the program registered"
	case core.PauseFolderMissing:
		return "the folder is gone, or no longer passes the folder rules"
	case core.PauseLoginMismatch:
		return program + "'s own settings make it work as another Quadit login"
	case core.PauseServerOld:
		return string(errServerOld)
	}
	return reason
}

// notStartedWords say why an item started no run.
func (e *liveEntry) notStartedWords(why string, head listenItem) string {
	agent := e.reg.Agent
	switch why {
	case core.RunNotResponsible:
		if handleForm.MatchString(head.By) {
			return head.By + " is not the person responsible for " + agent
		}
		return "the item's author is not the person responsible for " + agent
	case core.RunNoResponsible:
		return agent + " has no responsible person"
	case core.RunCapped:
		return "too many runs of " + agent + " started by agents in the last hour"
	case core.RunNoProgress:
		return "the last two runs on " + head.Task + " changed nothing on it"
	case core.RunOpenElsewhere:
		return "another run of " + agent + " on " + head.Task + " is still open"
	}
	return strings.ReplaceAll(why, "_", " ")
}

// listWords say what an entry does, as quadit run list prints it.
func listWords(st statusEntry, program string) string {
	switch st.State {
	case statusWorking:
		return "working on " + st.Task
	case statusPaused:
		until, _ := time.Parse(time.RFC3339, st.Until) // none: no time said
		return "paused: " + pauseWords(st.Pause, program, until)
	case statusAside:
		return "aside: a chat listens"
	case statusError:
		return "not served: " + st.Message
	case "":
		return "starting"
	}
	return st.State
}

// cleanRuns deletes the runs' logs and last messages older than 30 days.
func cleanRuns(dir string, now time.Time) {
	entries, _ := os.ReadDir(dir) // none to clean when it cannot be read
	for _, e := range entries {
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > 30*24*time.Hour {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
