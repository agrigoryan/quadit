// The listen command: the companion that runs a command for each inbox
// item.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// listen is the companion: it holds a request open on the caller's inbox
// and runs a command for each item, so an agent with nothing running can
// still be woken. The item is passed in QUADIT_EVENT and on stdin.
//
// Delivery is at least once. The cursor is moved past an item only after
// its command ran and exited with 0; an item whose secrets could not be
// had or whose command failed is tried again, after a pause that grows,
// and the items after it wait for it. So a command may see an item again
// (after a crash, or a failure after it did part of its work) and must be
// safe to run twice; `quadit ack SEQ NAME` moves the cursor past an item
// that should not be tried again.
func (r *runner) listen(in input) error {
	command, secrets, cursor := listenArgs(in.rest)
	if len(command) == 0 {
		return errors.New("usage: quadit listen [cursor=NAME] --exec COMMAND [ARG ...]")
	}
	fmt.Fprintf(r.out, "listening as cursor %q; running %q for each inbox item\n", cursor, strings.Join(command, " "))
	const (
		firstPause   = time.Second
		maxReadPause = 30 * time.Second // the server or the network is away
		maxItemPause = 5 * time.Minute  // an item's command keeps failing
	)
	readPause, itemPause := firstPause, firstPause
	for {
		// One item at a time, so the page's position is that item's and
		// acknowledging it passes over nothing that was not handled.
		raw, err := r.c.JSON(r.ctx, "/events", url.Values{"cursor": {cursor}, "inbox": {"1"}, "wait": {"50"}, "limit": {"1"}, "types": {"notification.created"}, "compact": {"1"}})
		if err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			fmt.Fprintln(r.out, "retrying:", err)
			if err := pause(r.ctx, readPause); err != nil {
				return err
			}
			readPause = min(readPause*2, maxReadPause)
			continue
		}
		readPause = firstPause
		var page struct {
			Events []string `json:"events"`
			Seq    int64    `json:"seq"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		if len(page.Events) > 0 {
			line := page.Events[0]
			fmt.Fprintln(r.out, line)
			if err := r.wake(command, secrets, line); err != nil {
				if r.ctx.Err() != nil {
					return r.ctx.Err()
				}
				fmt.Fprintf(r.out, "not handled, trying it again in %s: %v\n", itemPause, err)
				if err := pause(r.ctx, itemPause); err != nil {
					return err
				}
				itemPause = min(itemPause*2, maxItemPause)
				continue
			}
			itemPause = firstPause
		}
		// A page with no item still moves the cursor, past events that
		// were not for this inbox, so the next read starts later.
		if _, err := r.setCursor(cursor, page.Seq); err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			fmt.Fprintln(r.out, "ack failed, the item may come again:", err)
		}
	}
}

// pause waits for d, or less if ctx ends first, which it returns.
func pause(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
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

// wake runs the command for one inbox item and says whether it handled it:
// an error is the secrets not being given (the command did not run) or the
// command failing.
func (r *runner) wake(command, secrets []string, line string) error {
	// Secrets are fetched for each run, so a changed or withdrawn one
	// takes effect at once.
	env, err := r.secretEnv(secrets)
	if err != nil {
		return fmt.Errorf("the secrets could not be had, so the command did not run: %w", err)
	}
	cmd, out := r.secretCommand(command, env, "QUADIT_EVENT="+line)
	cmd.Stdin = strings.NewReader(line + "\n")
	runErr := cmd.Run()
	if err := out.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, "the command's output could not be printed:", err)
	}
	if runErr != nil {
		return fmt.Errorf("the command failed: %w", runErr)
	}
	return nil
}
