package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// listen is the companion: it holds a request open on the caller's inbox
// and runs a command for each item, so an agent with nothing running can
// still be woken. The item is passed in QUADIT_EVENT and on stdin.
func (r *runner) listen(in input) error {
	command, secrets, cursor := listenArgs(in.rest)
	if len(command) == 0 {
		return errors.New("usage: quadit listen [cursor=NAME] --exec COMMAND [ARG ...]")
	}
	fmt.Fprintf(r.out, "listening as cursor %q; running %q for each inbox item\n", cursor, strings.Join(command, " "))
	backoff := time.Second
	for {
		raw, err := r.c.JSON("/events", url.Values{"cursor": {cursor}, "inbox": {"1"}, "wait": {"50"}, "types": {"notification.created"}, "compact": {"1"}})
		if err != nil {
			fmt.Fprintln(r.out, "retrying:", err)
			time.Sleep(backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		var page struct {
			Events []string `json:"events"`
			Seq    int64    `json:"seq"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		for _, line := range page.Events {
			fmt.Fprintln(r.out, line)
			if err := r.wake(command, secrets, line); err != nil {
				fmt.Fprintln(r.out, "secrets:", err)
				time.Sleep(backoff)
			}
		}
		// Mark handled only after the command ran, so a crash repeats the
		// item instead of losing it.
		if _, err := r.setCursor(cursor, page.Seq); err != nil {
			fmt.Fprintln(r.out, "ack failed:", err)
		}
	}
}

// listenArgs reads what listen was given: the command after --exec, the
// secrets it gets, and the cursor that remembers how far the inbox was
// handled.
func listenArgs(args []string) (command, secrets []string, cursor string) {
	cursor = "listen"
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--secret" && i+1 < len(args):
			secrets = append(secrets, args[i+1])
			i++
		case args[i] == "--exec" && i+1 < len(args):
			command = args[i+1:]
			i = len(args)
		case strings.HasPrefix(args[i], "cursor="):
			cursor = strings.TrimPrefix(args[i], "cursor=")
		}
	}
	return
}

// wake runs the command for one inbox item. A command that fails is said
// and passed over; the error returned is the secrets not being given, in
// which case the command was not run.
func (r *runner) wake(command, secrets []string, line string) error {
	// Secrets are fetched for each run, so a changed or withdrawn one
	// takes effect at once.
	env, err := r.secretEnv(secrets)
	if err != nil {
		return err
	}
	cmd, out := r.secretCommand(command, env, "QUADIT_EVENT="+line)
	cmd.Stdin = strings.NewReader(line + "\n")
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(r.out, "command failed:", err)
	}
	out.Flush()
	return nil
}
