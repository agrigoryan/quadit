// An entry's outbox: every write `quadit run` makes to the server (a run's
// start, its steps and changes of state, its end, the fallback comment,
// the acknowledgment of its head, letting the project go) is first a file
// here, numbered in order, written whole before it is sent, and sent in
// order under a change id made once. So a crash or a server away loses
// nothing and applies nothing twice: what was not sent is sent at the next
// chance, with the same id and body.
//
// A run's end is a terminal record: how it ended, its final message, and
// what is still to be decided (whether to post the fallback comment, and
// whether the run changed anything on its task), which needs the server.
// It is resolved in place when it comes up, then its writes take its place.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

// outboxWrite is one file of the outbox: one write, or a terminal record.
type outboxWrite struct {
	Run      string          `json:"run"`
	Task     string          `json:"task,omitempty"` // the task's key
	Head     int64           `json:"head,omitempty"` // the feed position of the run's head
	Write    string          `json:"write"`          // its name (writeStart, …)
	Ordinal  int             `json:"ordinal"`        // which write of that name in the run
	ChangeID string          `json:"change_id,omitempty"`
	Change   *pendingChange  `json:"change,omitempty"`
	Ack      *pendingAck     `json:"ack,omitempty"`
	Release  *pendingRelease `json:"release,omitempty"`
	Terminal *terminalRecord `json:"terminal,omitempty"`
	// Error is, in failed/, why the server refused it for good.
	Error string `json:"error,omitempty"`
}

// The names of the writes; a change id is made from the run, the name and
// the ordinal.
const (
	writeStart          = "start"
	writeAccepted       = "accepted"
	writeProgramSession = "program-session"
	writeReason         = "reason"
	writeSteps          = "steps"
	writeFallback       = "fallback"
	writeEnd            = "end" // a terminal record, then the change that ends the run's row
	writeAck            = "ack"
	writeRelease        = "release"
)

// pendingChange is a change as it is sent.
type pendingChange struct {
	Type string         `json:"type"`
	Args map[string]any `json:"args"`
}

// pendingAck moves the listener's cursor past a head, with the lease.
type pendingAck struct {
	Cursor string `json:"cursor"`
	Seq    int64  `json:"seq"`
	Lease  string `json:"lease"`
}

// pendingRelease lets the project's runner go.
type pendingRelease struct {
	Project   string `json:"project"`
	MachineID string `json:"machine_id"`
}

// terminalRecord is how a run ended, written before any network call.
type terminalRecord struct {
	State    string `json:"state"`
	Reason   string `json:"reason"`
	ResetsAt int64  `json:"resets_at,omitempty"`
	Final    string `json:"final"`             // the program's final message
	Summary  string `json:"summary,omitempty"` // the runner's own, when it says why the run ended
	StartSeq int64  `json:"start_seq"`         // the seq session.start answered
	EndSeq   int64  `json:"end_seq"`           // where the feed stood once the program ended; 0: not read yet
	// Fallback is whether the final message is posted as a comment:
	// "pending" until the task's events say whether the agent wrote on it,
	// then "post" or "none".
	Fallback string `json:"fallback"`
	// Quiet is whether the run changed nothing on its task (G4): "" when
	// not counted, "pending", then "yes" or "no".
	Quiet string `json:"quiet,omitempty"`
	// SendEnd is whether the run's row is ended by a change: not for a run
	// whose start may never have reached the server.
	SendEnd bool   `json:"send_end"`
	Head    int64  `json:"head"`
	Ack     bool   `json:"ack"` // whether the head is acknowledged
	Cursor  string `json:"cursor,omitempty"`
	Lease   string `json:"lease,omitempty"`
	AgentID string `json:"agent_id"`
	Machine string `json:"machine"`
}

// The values of terminalRecord.Fallback and Quiet.
const (
	decidePending = "pending"
	fallbackPost  = "post"
	fallbackNone  = "none"
	quietYes      = "yes"
	quietNo       = "no"
)

// outboxServer is what the outbox needs of the server (entryAPI).
type outboxServer interface {
	change(ctx context.Context, changeID, typ string, args map[string]any) (Result, error)
	acknowledge(ctx context.Context, cursor string, seq int64, lease string) error
	release(ctx context.Context, project, machineID string) error
	seqNow(ctx context.Context) (int64, error)
	taskEvents(ctx context.Context, task string, after, through int64) ([]feedEvent, error)
}

// outbox is one entry's outbox folder.
type outbox struct {
	dir     string
	mu      sync.Mutex // the files: numbering, adding, listing
	sending sync.Mutex // one flush at a time
	// blocked hears of a write the server refused for good, and quiet of a
	// run found to have changed nothing on its task, or something.
	blocked func(w outboxWrite, err error)
	quiet   func(task, run string, quiet bool)
	// answered holds the answers to start writes, by file, for the run
	// that waits on one.
	answered map[string]Result
}

func openOutbox(dir string) (*outbox, error) {
	if err := os.MkdirAll(filepath.Join(dir, "failed"), 0o700); err != nil {
		return nil, err
	}
	return &outbox{dir: dir, blocked: func(outboxWrite, error) {}, quiet: func(string, string, bool) {}, answered: map[string]Result{}}, nil
}

// outboxName is a file's name: its number, and for a write a terminal
// record was resolved into, its place after it.
var outboxName = regexp.MustCompile(`^(\d{8})(?:-(\d+))?\.json$`)

// files are the outbox's files, in the order they are sent.
func (o *outbox) files() []string {
	entries, _ := os.ReadDir(o.dir) // an outbox that cannot be read has nothing to send now
	type named struct {
		name    string
		n, part int
	}
	var list []named
	for _, e := range entries {
		m := outboxName.FindStringSubmatch(e.Name())
		if m == nil || !e.Type().IsRegular() {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		part, _ := strconv.Atoi(m[2]) // none: the file itself, before its parts
		list = append(list, named{e.Name(), n, part})
	}
	slices.SortFunc(list, func(a, b named) int {
		if a.n != b.n {
			return a.n - b.n
		}
		return a.part - b.part
	})
	names := make([]string, len(list))
	for i, f := range list {
		names[i] = f.name
	}
	return names
}

// add stores a write as the outbox's last file, and gives its name.
func (o *outbox) add(w outboxWrite) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	next := 1
	if files := o.files(); len(files) > 0 {
		n, _ := strconv.Atoi(files[len(files)-1][:8])
		next = n + 1
	}
	name := fmt.Sprintf("%08d.json", next)
	return name, writeWhole(filepath.Join(o.dir, name), plainJSON(w))
}

// read is one file of the outbox.
func (o *outbox) read(name string) (outboxWrite, error) {
	var w outboxWrite
	raw, err := os.ReadFile(filepath.Join(o.dir, name))
	if err != nil {
		return w, err
	}
	return w, json.Unmarshal(raw, &w)
}

// writes are the outbox's writes, in order, with their files' names.
func (o *outbox) writes() (names []string, writes []outboxWrite) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, name := range o.files() {
		if w, err := o.read(name); err == nil {
			names, writes = append(names, name), append(writes, w)
		}
	}
	return names, writes
}

// empty reports whether nothing waits to be sent.
func (o *outbox) empty() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.files()) == 0
}

// endWaits reports whether the end of a run whose head is head waits to
// be sent (its terminal record, or a write it was resolved into): that
// head is never started again meanwhile.
func (o *outbox) endWaits(head int64) bool {
	_, writes := o.writes()
	return slices.ContainsFunc(writes, func(w outboxWrite) bool {
		return w.Head == head && (w.Terminal != nil || w.Write == writeEnd || w.Write == writeFallback || w.Write == writeAck)
	})
}

// hasEnd reports whether the outbox holds the end of run.
func (o *outbox) hasEnd(run string) bool {
	_, writes := o.writes()
	return slices.ContainsFunc(writes, func(w outboxWrite) bool {
		return w.Run == run && (w.Terminal != nil || w.Write == writeEnd)
	})
}

// hasStart reports whether run's start waits in the outbox.
func (o *outbox) hasStart(run string) bool {
	_, writes := o.writes()
	return slices.ContainsFunc(writes, func(w outboxWrite) bool { return w.Run == run && w.Write == writeStart })
}

// drop removes one file, and dropRun every file of a run.
func (o *outbox) drop(name string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	os.Remove(filepath.Join(o.dir, name))
}

func (o *outbox) dropRun(run string) {
	names, writes := o.writes()
	for i, w := range writes {
		if w.Run == run {
			o.drop(names[i])
		}
	}
}

// blockedWrite is a write the server refused for good, as status.json
// names it.
type blockedWrite struct {
	Run   string `json:"run"`
	Task  string `json:"task"`
	Write string `json:"write"`
	Error string `json:"error"`
}

// failed are the writes the server refused for good, kept in failed/.
func (o *outbox) failed() []blockedWrite {
	entries, _ := os.ReadDir(filepath.Join(o.dir, "failed")) // none to show when it cannot be read
	var out []blockedWrite
	for _, e := range entries {
		if w, err := o.read(filepath.Join("failed", e.Name())); err == nil {
			out = append(out, blockedWrite{Run: w.Run, Task: w.Task, Write: w.Write, Error: w.Error})
		}
	}
	return out
}

// startRefused is a run's start the server refused because the lease is
// no longer the runner's (lease_stale), another run of the agent on the
// task is open (run_open), or the run exists already (in_use: made under
// another change id). Its file stays for the run to decide.
type startRefused struct {
	file   string
	reason string
	err    error
}

func (e *startRefused) Error() string { return e.err.Error() }

// errOutboxWaits is a flush that stopped at a write it could not send
// now: the server or the network away, or the read a terminal record
// needs failed. It is tried again.
var errOutboxWaits = errors.New("the outbox waits for the server")

// flush sends the outbox in order, until it is empty, or, when until
// names a file, until that file was sent; it gives that file's answer. It
// stops with errOutboxWaits at a write that cannot be sent now; with a
// *startRefused at the start of until; and with the refusal at until
// refused for good. Any other write refused for good is moved to failed/
// and does not hold the writes after it, nor does an acknowledgment of a
// lease that is no longer the runner's, which is dropped: whoever holds
// the lease now owns the item. A start refused before until is dropped,
// with every later write of its run.
func (o *outbox) flush(ctx context.Context, srv outboxServer, until string) (Result, error) {
	o.sending.Lock()
	defer o.sending.Unlock()
	for {
		if res, ok := o.answered[until]; ok && until != "" {
			delete(o.answered, until)
			return res, nil
		}
		o.mu.Lock()
		files := o.files()
		o.mu.Unlock()
		if len(files) == 0 {
			return Result{}, nil
		}
		name := files[0]
		w, err := o.read(name)
		if err != nil {
			o.moveToFailed(name, w, err)
			continue
		}
		if w.Terminal != nil {
			if err := o.resolve(ctx, srv, name, w); err != nil {
				return Result{}, errors.Join(errOutboxWaits, err)
			}
			continue
		}
		res, err := o.send(ctx, srv, w)
		if err == nil {
			if w.Write == writeStart {
				o.answered[name] = res
			}
			o.drop(name)
			continue
		}
		if ctx.Err() != nil || temporary(err) {
			return Result{}, errors.Join(errOutboxWaits, err)
		}
		ae, _ := refusalOf(err)
		switch {
		case w.Write == writeAck && leaseLost(err):
			o.drop(name)
		case w.Write == writeStart && (ae.Reason == "lease_stale" || ae.Reason == "run_open" || ae.Reason == "in_use"):
			if name == until {
				return Result{}, &startRefused{file: name, reason: ae.Reason, err: err}
			}
			o.dropRun(w.Run)
		default:
			o.moveToFailed(name, w, err)
			o.blocked(w, err)
			if name == until {
				return Result{}, err
			}
		}
	}
}

// send sends one write.
func (o *outbox) send(ctx context.Context, srv outboxServer, w outboxWrite) (Result, error) {
	switch {
	case w.Change != nil:
		return srv.change(ctx, w.ChangeID, w.Change.Type, w.Change.Args)
	case w.Ack != nil:
		return Result{}, srv.acknowledge(ctx, w.Ack.Cursor, w.Ack.Seq, w.Ack.Lease)
	case w.Release != nil:
		return Result{}, srv.release(ctx, w.Release.Project, w.Release.MachineID)
	}
	return Result{}, nil // a write of no kind known has nothing to send
}

// moveToFailed keeps a write the server refused for good in failed/, with
// why.
func (o *outbox) moveToFailed(name string, w outboxWrite, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	w.Error = err.Error()
	failed := filepath.Join(o.dir, "failed", name)
	if writeWhole(failed, plainJSON(w)) == nil {
		os.Remove(filepath.Join(o.dir, name))
	}
}

// resolve decides what a terminal record left to decide, keeping each
// decision in the record as it is made, then puts the writes it makes in
// its place: the fallback comment, the change that ends the row, the
// acknowledgment.
func (o *outbox) resolve(ctx context.Context, srv outboxServer, name string, w outboxWrite) error {
	t := w.Terminal
	keep := func() error { return writeWhole(filepath.Join(o.dir, name), plainJSON(w)) }
	if t.Fallback == decidePending || t.Quiet == decidePending {
		if t.EndSeq == 0 {
			seq, err := srv.seqNow(ctx)
			if err != nil {
				return err
			}
			t.EndSeq = seq
			if err := keep(); err != nil {
				return err
			}
		}
		events, err := srv.taskEvents(ctx, w.Task, t.StartSeq, t.EndSeq)
		if err != nil {
			return err
		}
		wrote, changed := false, false
		for _, ev := range events {
			if ev.ActorID != t.AgentID || ev.Data.Rule != "" || ev.Data.Row.SessionID == w.Run {
				continue
			}
			switch ev.Type {
			case "comment.created", "decision.opened":
				wrote, changed = true, true
			case "task.updated", "link.created":
				changed = true
			}
		}
		if t.Fallback == decidePending {
			t.Fallback = fallbackPost
			if wrote {
				t.Fallback = fallbackNone
			}
		}
		if t.Quiet == decidePending {
			o.quiet(w.Task, w.Run, !changed)
			t.Quiet = quietNo
			if !changed {
				t.Quiet = quietYes
			}
		}
		if err := keep(); err != nil {
			return err
		}
	}
	var parts []outboxWrite
	part := func(write string, change pendingChange) {
		parts = append(parts, outboxWrite{Run: w.Run, Task: w.Task, Head: w.Head, Write: write, ChangeID: changeID(w.Run, write, 0), Change: &change})
	}
	body := cleanedFinal(t.Final, t.Machine)
	if t.Fallback == fallbackPost && body != "" {
		part(writeFallback, pendingChange{Type: "comment.create", Args: map[string]any{"task": w.Task, "body": body, "session": w.Run}})
	}
	if t.SendEnd {
		args := map[string]any{"id": w.Run, "state": t.State}
		if t.Reason != "" {
			args["reason"] = t.Reason
		}
		if t.ResetsAt > 0 {
			args["resets_at"] = t.ResetsAt
		}
		summary := t.Summary
		if summary == "" {
			summary = string([]rune(body)[:min(len([]rune(body)), 500)])
		}
		if summary != "" {
			args["summary"] = summary
		}
		part(writeEnd, pendingChange{Type: "session.update", Args: args})
	}
	if t.Ack {
		parts = append(parts, outboxWrite{Run: w.Run, Task: w.Task, Head: w.Head, Write: writeAck, Ack: &pendingAck{Cursor: t.Cursor, Seq: t.Head, Lease: t.Lease}})
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	for i, p := range parts {
		if err := writeWhole(filepath.Join(o.dir, fmt.Sprintf("%s-%d.json", name[:8], i+1)), plainJSON(p)); err != nil {
			return err
		}
	}
	return os.Remove(filepath.Join(o.dir, name))
}

// changeID is the id of a run's write: the same for the same run, name and
// ordinal, so a write sent again is applied once.
func changeID(run, write string, ordinal int) string {
	return madeChangeID("quadit run " + run + " " + write + " " + strconv.Itoa(ordinal))
}

// itemRunID is the run id, and the change id, of an item's not_started
// row: one row per item, however often the item comes.
func itemRunID(itemID string) string { return madeChangeID("quadit item " + itemID) }

// maxFallback is the longest fallback comment, in characters.
const maxFallback = 8000

var (
	// terminalEscape is a terminal's escape sequence: CSI, OSC, or one more character.
	terminalEscape = regexp.MustCompile("\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|.)")
	manyBlanks     = regexp.MustCompile(`\n[ \t]*\n(?:[ \t]*\n)+`)
)

// cleanedFinal is a program's final message as the fallback comment posts
// it: without terminal escape sequences and control characters other than
// line breaks and tabs, no more than two blank lines in a row, trimmed,
// and cut at maxFallback characters with a line saying where the rest is.
func cleanedFinal(final, machine string) string {
	s := terminalEscape.ReplaceAllString(strings.ReplaceAll(final, "\r\n", "\n"), "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(manyBlanks.ReplaceAllString(s, "\n\n\n"))
	if r := []rune(s); len(r) > maxFallback {
		s = strings.TrimSpace(string(r[:maxFallback])) + "…\n\n(Cut here: the whole message is in the run's log on " + machine + ".)"
	}
	return s
}
