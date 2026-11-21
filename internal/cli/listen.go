// The listener's commands: listen, the companion that runs a command for
// each inbox item, and wait, which an agent in a chat runs to be handed the
// next one. Both read through GET /listen, which lets one session at a time
// hold the agent's listener lease, and move the cursor only by
// acknowledging an item with it.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// listen is the companion: it holds a request open on the caller's inbox
// and runs a command for each item, so an agent with nothing running can
// still be woken. The item is passed in QUADIT_EVENT and on stdin, as the
// feed writes it.
//
// Delivery is at least once. The cursor is moved past an item only after
// its command ran and exited with 0; an item whose secrets could not be
// had or whose command failed is tried again, after a pause that grows,
// and the items after it wait for it. So a command may see an item again
// (after a crash, a failure after it did part of its work, or a command
// that ran past the lease) and must be safe to run twice; the command
// listen prints beside a failure moves the cursor past an item that should
// not be tried again.
//
// It holds the agent's listener lease, whatever its cursor, and stops when
// another session holds it or takes it over; take=1 takes it over. The
// lease's id is kept beside the login file, so a companion stopped or
// restarted goes on with the lease it held.
func (r *runner) listen(in input) error {
	command, secrets, cursor, take := listenArgs(in.rest)
	if len(command) == 0 {
		return errors.New("usage: quadit listen [cursor=NAME] [take=1] --exec COMMAND [ARG ...]")
	}
	fmt.Fprintf(r.out, "listening as cursor %q; running %q for each inbox item\n", cursor, strings.Join(command, " "))
	const (
		firstPause   = time.Second
		maxReadPause = 30 * time.Second // the server or the network is away
		maxItemPause = 5 * time.Minute  // an item's command keeps failing
	)
	readPause, itemPause := firstPause, firstPause
	lease := keptLease()
	for {
		page, err := r.nextItem(cursor, lease, take, waitHold)
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
		if page.Lease != lease {
			keepLease(page.Lease)
		}
		lease, take = page.Lease, false
		r.sayLeftAlone(page.Skipped)
		if page.Item == nil {
			continue
		}
		fmt.Fprintln(r.out, page.Line)
		if err := r.wake(command, secrets, page.Line); err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			fmt.Fprintf(r.out, "not handled, trying it again in %s: %v\n", itemPause, err)
			fmt.Fprintf(r.out, "  to give up on it: %s\n", giveUp(cursor, page.Seq, lease))
			if err := pause(r.ctx, itemPause); err != nil {
				return err
			}
			itemPause = min(itemPause*2, maxItemPause)
			continue
		}
		itemPause = firstPause
		if _, err := r.setCursor(cursor, page.Seq, lease); err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			if lostTheLease(err) {
				return err
			}
			fmt.Fprintln(r.out, "ack failed, the item will come again:", err)
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
// secrets it gets, the cursor that remembers how far the inbox was
// handled, and whether to take the lease over (take=1).
func listenArgs(args []string) (command, secrets []string, cursor string, take bool) {
	cursor = "listen"
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "take=1" || args[i] == "take=true":
			take = true
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

// giveUp is the command that moves the cursor past an item that should not
// be tried again, with the listener's lease.
func giveUp(cursor string, seq int64, lease string) string {
	return fmt.Sprintf("quadit ack %d %s lease=%s", seq, cursor, lease)
}

// lostTheLease reports whether the server refused this session the
// listener because another session holds its lease or took it over. A
// lease that only ran out is not lost: the next wait takes it again.
func lostTheLease(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && (ae.Reason == "listening_elsewhere" || ae.Reason == "lease_stale")
}

// waitHold is the longest the server holds one wait; a longer wait is
// several, each renewing the lease. A request may take holdSlack more than
// its hold before it is given up.
const (
	waitHold  = 50 * time.Second
	holdSlack = 10 * time.Second
)

// listened is one answer of GET /listen: the lease, and the item with its
// feed position and its line in the feed, when one came; and, the first
// time, how many older unread items were left alone.
type listened struct {
	Lease   string      `json:"lease"`
	Seq     int64       `json:"seq"`
	Item    *listenItem `json:"item"`
	Line    string      `json:"line"`
	Skipped int         `json:"skipped"`
}

// leftAlone says where the older unread items a first wait left alone are.
func leftAlone(n int) string {
	if n == 1 {
		return "# 1 older unread item was left alone: quadit inbox lists it"
	}
	return fmt.Sprintf("# %d older unread items were left alone: quadit inbox lists them", n)
}

// sayLeftAlone says, after a record, where the older unread items a first
// wait left alone are; nothing when there are none.
func (r *runner) sayLeftAlone(n int) {
	if n > 0 {
		fmt.Fprintln(r.out, leftAlone(n))
	}
}

// leasePath is where listen keeps its lease's id: beside the login file.
func leasePath() string { return configPath() + ".lease" }

// keptLease is the lease id listen kept, or "" for none (or one not of the
// form a lease id has).
func keptLease() string {
	raw, err := os.ReadFile(leasePath())
	if err != nil {
		return ""
	}
	if id := strings.TrimSpace(string(raw)); leaseForm.MatchString(id) {
		return id
	}
	return ""
}

// keepLease keeps a lease id for the next start of listen. Best effort: a
// listen that cannot keep it takes a new one when it starts again, after
// the old one ran out.
func keepLease(id string) {
	if err := os.WriteFile(leasePath(), []byte(id+"\n"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "the listener's lease could not be kept for the next start:", err)
	}
}

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

// nextItem asks for the next item on cursor, holding lease (or taking one,
// from another session with take) for up to hold. The request is given up
// a little after its hold, whatever the client's own time limit.
func (r *runner) nextItem(cursor, lease string, take bool, hold time.Duration) (listened, error) {
	q := url.Values{"wait": {strconv.Itoa(max(int(hold.Round(time.Second).Seconds()), 1))}}
	if cursor != "listen" {
		q.Set("cursor", cursor)
	}
	if lease != "" {
		q.Set("lease", lease)
	}
	if take {
		q.Set("take", "1")
	}
	ctx, cancel := context.WithTimeout(r.ctx, hold+holdSlack)
	defer cancel()
	var page listened
	raw, err := r.c.JSON(ctx, "/listen", q)
	if err != nil {
		return page, err
	}
	return page, json.Unmarshal(raw, &page)
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
//
// What it prints is run by an agent as written, so nothing the server sent
// goes into it unless it has the form quadit gives it: a lease id, a task
// key, a page id, a handle. The item's words are shown in quotes, without
// what could end them or start a line.
func (r *runner) waitFor(span waitSpan, lease string, take bool, goOn string) error {
	deadline := time.Now().Add(span.total)
	skipped := 0
	for {
		page, err := r.nextItem("listen", lease, take, min(span.hold, time.Until(deadline)))
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) && ae.Reason == "listening_elsewhere" {
				return fmt.Errorf("%w\n  only when the person says this session should listen instead: quadit wait take=1", err)
			}
			return err
		}
		if !leaseForm.MatchString(page.Lease) {
			return errors.New("the server sent a lease id quadit does not recognize, so nothing is printed to run")
		}
		lease, take = page.Lease, false
		next := fmt.Sprintf("%s lease=%s", goOn, lease)
		skipped += page.Skipped
		if item := page.Item; item != nil {
			reading, err := item.reading()
			if err != nil {
				return err
			}
			fmt.Fprintln(r.out, item.line())
			fmt.Fprintf(r.out, "%s   # read it\n", reading)
			fmt.Fprintf(r.out, "quadit ack %d listen lease=%s   # once it is handled\n", item.Seq, lease)
			fmt.Fprintf(r.out, "%s   # then go on listening\n", next)
			r.sayLeftAlone(skipped)
			return nil
		}
		if !time.Now().Before(deadline.Add(-time.Second / 2)) {
			fmt.Fprintln(r.out, "IDLE")
			fmt.Fprintf(r.out, "%s   # go on listening\n", next)
			r.sayLeftAlone(skipped)
			return nil
		}
	}
}

// The forms of what the server sends that wait puts into a command or the
// item's line: a lease id (the server's alphabet without look-alikes), a
// task key, a page id, a handle, a kind of item.
var (
	leaseForm  = regexp.MustCompile(`^[A-HJKMNP-Z2-9]{8}$`)
	taskForm   = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}-[0-9]{1,9}$`)
	pageForm   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	handleForm = regexp.MustCompile(`^@[a-z0-9_-]{2,32}$`)
	kindForm   = regexp.MustCompile(`^[a-z_]{1,32}$`)
)

// line is the item on one line: ITEM #SEQ KIND TASK-OR-PAGE from @WHO: "…".
// A part not of its form is left out; the words are at most 200
// characters, without control characters, and their double quotes made
// single.
func (item listenItem) line() string {
	parts := []string{"ITEM", "#" + strconv.FormatInt(item.Seq, 10)}
	if kindForm.MatchString(item.Type) {
		parts = append(parts, item.Type)
	}
	switch {
	case taskForm.MatchString(item.Task):
		parts = append(parts, item.Task)
	case pageForm.MatchString(item.Page):
		parts = append(parts, "page "+item.Page)
	}
	if handleForm.MatchString(item.By) {
		parts = append(parts, "from "+item.By)
	}
	text := item.Snippet
	if text == "" {
		text = item.Title
	}
	text = strings.Map(func(r rune) rune {
		switch {
		case r == '"':
			return '\''
		case unicode.IsControl(r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r):
			return ' '
		}
		return r
	}, text)
	runes := []rune(strings.Join(strings.Fields(text), " "))
	return strings.Join(parts, " ") + `: "` + string(runes[:min(len(runes), 200)]) + `"`
}

// reading is the command that reads what the item is about; it refuses an
// item whose task or page is not of the form quadit gives them.
func (item listenItem) reading() (string, error) {
	switch {
	case item.Task != "":
		if !taskForm.MatchString(item.Task) {
			return "", fmt.Errorf("the server sent a task key quadit does not recognize (%q), so nothing is printed to run", item.Task)
		}
		return "quadit show " + item.Task, nil
	case item.Page != "":
		if !pageForm.MatchString(item.Page) {
			return "", fmt.Errorf("the server sent a page id quadit does not recognize (%q), so nothing is printed to run", item.Page)
		}
		if item.Thread != "" {
			return "quadit comments " + item.Page, nil
		}
		return "quadit doc " + item.Page, nil
	}
	return "quadit inbox", nil
}
