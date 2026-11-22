// How listen runs its command for an item: with a time limit when it is
// given one, and with what happens reported, on a channel of its own, to
// whatever started it (the Quadit app).

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// wakeItem is one inbox item as listen hands it to its command: the line the
// feed writes (QUADIT_EVENT, and on stdin, as it always was), and the
// record wait prints for it (QUADIT_ITEM: the ITEM line, the command that
// reads it, the one that answers it once).
type wakeItem struct{ line, record string }

// runEnd is how one run of the command ended: its exit status, or that it
// was ended for running longer than its limit, or did not run at all.
type runEnd struct {
	code    int  // the exit status, -1 when it had none (not run, or ended by a signal)
	limited bool // ended for running longer than limit=
	notRun  bool // its secrets could not be had, or it could not start
	err     error
}

// endGrace is how long a run ended for its limit has to go before its
// processes are killed outright.
var endGrace = 5 * time.Second

// wake runs the command for one inbox item, with alongside running beside
// it until it ends, for at most limit when that is not 0. Its err is the
// secrets not being given (the command did not run), the command failing,
// or the limit.
func (r *runner) wake(command, secrets []string, it wakeItem, limit time.Duration, alongside func(context.Context)) runEnd {
	// Secrets are fetched for each run, so a changed or withdrawn one
	// takes effect at once.
	env, err := r.secretEnv(secrets)
	if err != nil {
		return runEnd{code: -1, notRun: true, err: fmt.Errorf("the secrets could not be had, so the command did not run: %w", err)}
	}
	cmd, out := r.secretCommand(command, env, "QUADIT_EVENT="+it.line, "QUADIT_ITEM="+it.record)
	cmd.Stdin = strings.NewReader(it.line + "\n")
	if limit > 0 {
		// In a process group of its own, so what it started ends with it; and its output stops being waited for
		// a little after, should something it started outlive it holding the output open.
		ownGroup(cmd)
		cmd.Cancel = func() error { return endGroup(cmd, true) }
		cmd.WaitDelay = endGrace
	}
	ctx, stop := context.WithCancel(r.ctx)
	beside := make(chan struct{})
	go func() {
		defer close(beside)
		alongside(ctx)
	}()
	end := runCommand(cmd, limit)
	stop()
	<-beside
	if err := out.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, "the command's output could not be printed:", err)
	}
	return end
}

// runCommand starts cmd and waits for it, ending its process group when it
// runs longer than limit (not 0): asked to stop, then, after endGrace, killed.
func runCommand(cmd *exec.Cmd, limit time.Duration) runEnd {
	if err := cmd.Start(); err != nil {
		return runEnd{code: -1, notRun: true, err: fmt.Errorf("the command failed: %w", err)}
	}
	var waitErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		waitErr = cmd.Wait()
	}()
	var over <-chan time.Time
	if limit > 0 {
		t := time.NewTimer(limit)
		defer t.Stop()
		over = t.C
	}
	select {
	case <-done:
		if waitErr != nil {
			return runEnd{code: cmd.ProcessState.ExitCode(), err: fmt.Errorf("the command failed: %w", waitErr)}
		}
		return runEnd{}
	case <-over:
		_ = endGroup(cmd, false) // it may have just ended by itself
		select {
		case <-done: // how it went does not matter: it ran over its limit
		case <-time.After(endGrace):
		}
		_ = endGroup(cmd, true) // what it started may still run, even when it went
		<-done
		return runEnd{code: -1, limited: true, err: fmt.Errorf("the command ran longer than its limit of %s and was ended", limit)}
	}
}

// listenEvents reports what listen does, one JSON object a line, to a file
// or named pipe its caller made (events=PATH). The command's own output
// never goes there: listen alone writes it, and the command does not
// inherit it. Nil reports nothing.
type listenEvents struct {
	mu sync.Mutex
	w  io.WriteCloser
}

// openEvents opens the events channel at path for writing; a named pipe is
// opened when its reader is there. Nothing for no path.
func openEvents(path string) (*listenEvents, error) {
	if path == "" {
		return nil, nil
	}
	if info, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("events=: %w (the caller makes the file or named pipe)", err)
	} else if info.IsDir() {
		return nil, errors.New("events= names a folder; it takes a file or a named pipe")
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return nil, fmt.Errorf("events=: %w", err)
	}
	return &listenEvents{w: f}, nil
}

// say writes one event: its name, the time, and fields.
func (e *listenEvents) say(event string, fields map[string]any) {
	if e == nil {
		return
	}
	line := map[string]any{"event": event, "at": time.Now().UTC().Format(time.RFC3339)}
	maps.Copy(line, fields)
	raw, err := json.Marshal(line)
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, err := e.w.Write(append(raw, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, "an event could not be reported:", err)
	}
}

func (e *listenEvents) close() {
	if e != nil {
		_ = e.w.Close()
	}
}
