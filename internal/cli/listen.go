// The listener's commands: listen, the companion that runs a command for
// each inbox item, and wait, which an agent in a chat runs to be handed the
// next one. Both deliver from the cursor "listen", and the server lets one
// session at a time hold its lease.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
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
//
// On the cursor "listen" it holds the listener's lease, and stops when
// another session holds it or takes it over.
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
	lease := ""
	for {
		// One item at a time, so the page's position is that item's and
		// acknowledging it passes over nothing that was not handled.
		q := url.Values{"cursor": {cursor}, "inbox": {"1"}, "wait": {"50"}, "limit": {"1"}, "types": {"notification.created"}, "compact": {"1"}}
		if lease != "" {
			q.Set("lease", lease)
		}
		raw, err := r.c.JSON(r.ctx, "/events", q)
		if err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			if lostTheLease(err) {
				return err
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
			Lease  string   `json:"lease"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		lease = page.Lease
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
		if _, err := r.setCursor(cursor, page.Seq, lease); err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			if lostTheLease(err) {
				return err
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

// lostTheLease reports whether the server refused a session the cursor
// "listen" because another session holds its lease.
func lostTheLease(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && (ae.Reason == "listening_elsewhere" || ae.Reason == "lease_stale")
}

// waitHold is the longest the server holds one wait; a longer wait is
// several, each renewing the lease.
const waitHold = 50 * time.Second

// listenItem is an inbox item as GET /listen answers it.
type listenItem struct {
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	By      string `json:"by"`
	Task    string `json:"task"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
	Page    string `json:"page"`
	Thread  string `json:"thread"`
}

// wait blocks until the caller's next inbox item, for= seconds at most (50
// when not given), and prints one record for an agent to act on: the item
// and the exact commands to read it, acknowledge it and go on, or IDLE and
// the command to go on. The first wait takes the listener's lease, and the
// commands it prints carry it; take=1 takes it from another session.
func (r *runner) wait(in input) error {
	total := waitHold
	if v := in.f["for"]; len(v) > 0 {
		n, err := strconv.Atoi(v[0])
		if err != nil || n < 1 {
			return errors.New("for= is a number of seconds, 1 or more")
		}
		total = time.Duration(n) * time.Second
	}
	goOn := "quadit wait"
	if len(in.f["for"]) > 0 {
		goOn += " for=" + in.f["for"][0]
	}
	take := slices.Contains([]string{"1", "true", "yes"}, strings.ToLower(firstValue(in.f["take"])))
	return r.waitFor(waitSpan{total: total, hold: waitHold}, firstValue(in.f["lease"]), take, goOn)
}

// waitSpan is how long a wait blocks in all, and the most the server is
// asked to hold one request of it.
type waitSpan struct{ total, hold time.Duration }

// waitFor is wait, once its arguments are read: it holds lease (or takes
// one, from another session with take) for span, and prints the record;
// goOn is the command that waits again, without its lease.
func (r *runner) waitFor(span waitSpan, lease string, take bool, goOn string) error {
	deadline := time.Now().Add(span.total)
	for {
		hold := min(span.hold, time.Until(deadline)).Round(time.Second)
		q := url.Values{"wait": {strconv.Itoa(max(int(hold.Seconds()), 1))}}
		if lease != "" {
			q.Set("lease", lease)
		}
		if take {
			q.Set("take", "1")
		}
		raw, err := r.c.JSON(r.ctx, "/listen", q)
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) && ae.Reason == "listening_elsewhere" {
				return fmt.Errorf("%w\n  only when the person says this session should listen instead: quadit wait take=1", err)
			}
			return err
		}
		var page struct {
			Lease string      `json:"lease"`
			Item  *listenItem `json:"item"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		lease, take = page.Lease, false
		next := fmt.Sprintf("%s lease=%s", goOn, lease)
		if item := page.Item; item != nil {
			fmt.Fprintln(r.out, item.line())
			fmt.Fprintf(r.out, "%s   # read it\n", item.reading())
			fmt.Fprintf(r.out, "quadit ack %d listen lease=%s   # once it is handled\n", item.Seq, lease)
			fmt.Fprintf(r.out, "%s   # then go on listening\n", next)
			return nil
		}
		if !time.Now().Before(deadline.Add(-time.Second / 2)) {
			fmt.Fprintln(r.out, "IDLE")
			fmt.Fprintf(r.out, "%s   # go on listening\n", next)
			return nil
		}
	}
}

// line is the item on one line: ITEM #SEQ KIND TASK-OR-PAGE from @WHO: "…".
func (item listenItem) line() string {
	where := item.Task
	if where == "" && item.Page != "" {
		where = "page " + item.Page
	}
	text := item.Snippet
	if text == "" {
		text = item.Title
	}
	if runes := []rune(strings.Join(strings.Fields(text), " ")); len(runes) > 200 {
		text = string(runes[:200])
	} else {
		text = string(runes)
	}
	return strings.Join(strings.Fields(fmt.Sprintf("ITEM #%d %s %s from %s:", item.Seq, item.Type, where, item.By)), " ") + " " + strconv.Quote(text)
}

// reading is the command that reads what the item is about.
func (item listenItem) reading() string {
	switch {
	case item.Task != "":
		return "quadit show " + item.Task
	case item.Page != "" && item.Thread != "":
		return "quadit comments " + item.Page
	case item.Page != "":
		return "quadit doc " + item.Page
	}
	return "quadit inbox"
}
