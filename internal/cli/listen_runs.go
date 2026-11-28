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
	"strings"
	"time"
)

// wakeItem is one inbox item as listen hands it to its command: the line the
// feed writes (QUADIT_EVENT, and on stdin, as it always was), the record
// wait prints for it (QUADIT_ITEM: the ITEM line, the command that reads
// it, the one that answers it once), and the id of the workspace it is in.
type wakeItem struct{ line, record, workspace string }

// runEnd is how one run of the command ended: its exit status, or that it
// was ended for running longer than its limit.
type runEnd struct {
	code    int  // the exit status, -1 when it had none (not run, or ended by a signal)
	limited bool // ended for running longer than limit=
	err     error
}

// wake runs the command for one inbox item, with alongside running beside
// it until it ends, for at most limit when that is not 0. Its err is the
// secrets not being given (the command did not run), the command failing,
// or the limit.
func (r *runner) wake(command, secrets []string, it wakeItem, limit time.Duration, alongside func(context.Context)) runEnd {
	// Secrets are fetched for each run, so a changed or withdrawn one
	// takes effect at once.
	env, err := r.secretEnv(secrets)
	if err != nil {
		return runEnd{code: -1, err: fmt.Errorf("the secrets could not be had, so the command did not run: %w", err)}
	}
	runCtx, cancel := r.ctx, context.CancelFunc(func() {})
	if limit > 0 {
		runCtx, cancel = context.WithTimeout(r.ctx, limit)
	}
	defer cancel()
	cmd, out := r.secretCommand(runCtx, command, childEnv(os.Environ(), r.c, it.workspace), env, "QUADIT_EVENT="+it.line, "QUADIT_ITEM="+it.record)
	cmd.Stdin = strings.NewReader(it.line + "\n")
	if limit > 0 {
		// Its whole process group is killed at its limit, so what it started ends with it; its output is
		// waited for a second more, should something that left the group still hold it open.
		ownGroup(cmd)
		cmd.Cancel = func() error { return killGroup(cmd) }
		cmd.WaitDelay = time.Second
	}
	ctx, stop := context.WithCancel(r.ctx)
	beside := make(chan struct{})
	go func() {
		defer close(beside)
		alongside(ctx)
	}()
	runErr := cmd.Run()
	stop()
	<-beside
	if err := out.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, "the command's output could not be printed:", err)
	}
	switch {
	case runErr == nil:
		return runEnd{}
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return runEnd{code: -1, limited: true, err: fmt.Errorf("the command ran longer than its limit of %s and was ended", limit)}
	}
	return runEnd{code: cmd.ProcessState.ExitCode(), err: fmt.Errorf("the command failed: %w", runErr)}
}

// childEnv is the environment of the command listen runs for an item:
// listen's own, its Quadit login made the companion's, whatever the
// command inherited. A login from a file is passed by QUADIT_CONFIG, and
// QUADIT_URL and QUADIT_TOKEN are dropped; one from those two keeps them.
// QUADIT_WORKSPACE names the workspace, by its id (when known): a quadit
// command the item's command runs works where the companion listens, in
// whatever folder it runs.
func childEnv(base []string, c *Client, workspace string) []string {
	env := make([]string, 0, len(base)+2)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		switch envName(name) { // on Windows Quadit_Url is QUADIT_URL
		case "QUADIT_WORKSPACE":
			continue
		case "QUADIT_CONFIG", "QUADIT_URL", "QUADIT_TOKEN":
			if c.login != "" {
				continue
			}
		}
		env = append(env, kv)
	}
	if c.login != "" {
		env = append(env, "QUADIT_CONFIG="+c.login)
	}
	if workspace != "" {
		env = append(env, "QUADIT_WORKSPACE="+workspace)
	}
	return env
}

// listenEvents reports what listen does, one JSON object a line, to a file
// or named pipe its caller made (events=PATH). The command's own output
// never goes there: listen alone writes it, and the command does not
// inherit it. Nil reports nothing.
type listenEvents struct{ w io.WriteCloser }

// openEvents opens the events channel at path for writing; a named pipe is
// opened when its reader is there. Nothing for no path.
func openEvents(path string) (*listenEvents, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return nil, fmt.Errorf("events=: %w (the caller makes the file or named pipe)", err)
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
	if _, err := e.w.Write(append(raw, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, "an event could not be reported:", err)
	}
}

func (e *listenEvents) close() {
	if e != nil {
		_ = e.w.Close()
	}
}
