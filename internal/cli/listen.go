// The listener's commands: listen, the companion that runs a command for
// each inbox item, and wait, which an agent in a chat runs to be handed the
// next one. Both read through GET /listen, which lets one session at a time
// hold the agent's listener lease, and move the cursor only by
// acknowledging an item with it.

package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/agrigoryan/quadit/internal/core"
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
// another session holds it or takes it over; take=1 takes it over. It says
// what it is to whoever asks what listens ("a companion", or what by=
// says: the desktop app says "the Quadit app"). The lease's id is kept
// beside the login file, so a companion stopped or restarted goes on with
// the lease it held.
func (r *runner) listen(in input) error {
	return r.listenWith(listenArgs(in.rest), leaseRenewal)
}

// leaseRenewal is how often listen renews its lease while an item's
// command runs: inside the lease's ninety seconds, so a command that runs
// ten minutes keeps it, and no other session is handed the item meanwhile.
const leaseRenewal = time.Minute

// listenWith is listen, once its arguments are read, renewing the lease
// every renewEvery while a command runs.
func (r *runner) listenWith(opts listenOptions, renewEvery time.Duration) error {
	if len(opts.command) == 0 {
		return errors.New("usage: quadit listen [cursor=NAME] [take=1] [by=WORDS] [limit=SECONDS] [tries=N] [events=PATH] --exec COMMAND [ARG ...]")
	}
	if opts.bad != "" {
		return errors.New(opts.bad)
	}
	if !core.ListenerLabel.MatchString(opts.by) {
		return errors.New("by= says what listens in a few plain words (\"the Quadit app\"): at most 40 letters, digits, spaces, - and '")
	}
	events, err := openEvents(opts.events)
	if err != nil {
		return err
	}
	defer events.close()
	why := "error"
	defer func() { events.say("stopped", map[string]any{"why": why}) }()
	cursor, take := opts.cursor, opts.take
	fmt.Fprintf(r.out, "listening as cursor %q; running %q for each inbox item\n", cursor, strings.Join(opts.command, " "))
	const (
		firstPause   = time.Second
		maxReadPause = 30 * time.Second // the server or the network is away
		maxItemPause = 5 * time.Minute  // an item's command keeps failing
	)
	readPause, itemPause := firstPause, firstPause
	kept, err := openLeaseFile()
	if err != nil {
		return err
	}
	defer kept.close()
	lease := kept.kept()
	var failedSeq int64 // the item whose runs failed, failed times in a row
	failed, started := 0, false
	for {
		page, err := r.nextItem(r.ctx, listenAsk{cursor: cursor, lease: lease, take: take, by: opts.by}, waitHold)
		if err != nil {
			if r.ctx.Err() != nil {
				why = "interrupted"
				return r.ctx.Err()
			}
			if lostTheLease(err) {
				why = "refused"
				return r.lostLease(err, events)
			}
			fmt.Fprintln(r.out, "retrying:", err)
			if err := pause(r.ctx, readPause); err != nil {
				why = "interrupted"
				return err
			}
			readPause = min(readPause*2, maxReadPause)
			continue
		}
		readPause = firstPause
		if !leaseForm.MatchString(page.Lease) {
			return errStrangeLease
		}
		if page.Lease != lease {
			kept.keep(page.Lease)
		}
		lease, take = page.Lease, false
		if !started {
			started = true
			events.say("started", map[string]any{"as": r.handleForEvents(events), "by": opts.by, "cursor": cursor})
		}
		if page.Item == nil {
			continue
		}
		fmt.Fprintln(r.out, page.Line)
		if page.Seq != failedSeq {
			failedSeq, failed = page.Seq, 0
		}
		renew := func(ctx context.Context) {
			ticker := time.NewTicker(renewEvery)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					// A short hold with the lease renews it; what it answers (the same item, not acknowledged yet) is not wanted.
					_, _ = r.nextItem(ctx, listenAsk{cursor: cursor, lease: lease, by: opts.by}, time.Second) // a renewal that fails leaves the lease to its ninety seconds
				}
			}
		}
		events.say("run_started", map[string]any{"seq": page.Seq, "try": failed + 1})
		began := time.Now()
		end := r.wake(opts.command, opts.secrets, wakeItem{line: page.Line, record: page.Item.record()}, opts.limit, renew)
		ended := map[string]any{"seq": page.Seq, "seconds": int(time.Since(began).Seconds()), "status": end.code}
		switch {
		case end.limited:
			ended["status"] = "limit"
		case end.notRun:
			ended["status"] = "not_run"
		}
		if r.ctx.Err() != nil {
			why = "interrupted"
			return r.ctx.Err()
		}
		events.say("run_ended", ended)
		if end.err != nil {
			failed++
			if opts.tries == 0 || failed < opts.tries {
				fmt.Fprintf(r.out, "not handled, trying it again in %s: %v\n", itemPause, end.err)
				fmt.Fprintf(r.out, "  to give up on it: %s\n", giveUp(cursor, page.Seq, lease))
				if err := pause(r.ctx, itemPause); err != nil {
					why = "interrupted"
					return err
				}
				itemPause = min(itemPause*2, maxItemPause)
				continue
			}
			// Given up: acknowledged, so the next item comes. It stays unread in the agent's inbox.
			fmt.Fprintf(r.out, "gave up on #%d after %d failed runs; it stays unread in quadit inbox\n", page.Seq, failed)
			events.say("gave_up", map[string]any{"seq": page.Seq, "why": fmt.Sprintf("%d failed runs", failed)})
		}
		itemPause = firstPause
		if _, err := r.setCursor(cursor, page.Seq, lease); err != nil {
			if r.ctx.Err() != nil {
				why = "interrupted"
				return r.ctx.Err()
			}
			if lostTheLease(err) {
				why = "refused"
				return r.lostLease(err, events)
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

// listenOptions are what listen was given: the command after --exec, the
// secrets it gets, the cursor that remembers how far the inbox was
// handled, whether to take the lease over (take=1), and what it says it
// is (by=).
type listenOptions struct {
	command, secrets []string
	cursor           string
	take             bool
	by               string
	limit            time.Duration // the longest one run may take; 0: no limit
	tries            int           // failed runs of one item before it is given up; 0: never
	events           string        // where to report what happens (events=PATH)
	bad              string        // what is wrong with the arguments, when something is
}

// listenArgs reads them.
func listenArgs(args []string) listenOptions {
	opts := listenOptions{cursor: "listen", by: "a companion"}
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "take=1" || args[i] == "take=true":
			opts.take = true
		case args[i] == "--secret" && i+1 < len(args):
			opts.secrets = append(opts.secrets, args[i+1])
			i++
		case args[i] == "--exec" && i+1 < len(args):
			opts.command = args[i+1:]
			i = len(args)
		case strings.HasPrefix(args[i], "cursor="):
			opts.cursor = strings.TrimPrefix(args[i], "cursor=")
		case strings.HasPrefix(args[i], "by="):
			opts.by = strings.TrimPrefix(args[i], "by=")
		case strings.HasPrefix(args[i], "limit="):
			n, ok := wholeIn(strings.TrimPrefix(args[i], "limit="), 1, 86400)
			if !ok {
				opts.bad = "limit= is a number of seconds, from 1 to 86400"
			}
			opts.limit = time.Duration(n) * time.Second
		case strings.HasPrefix(args[i], "tries="):
			n, ok := wholeIn(strings.TrimPrefix(args[i], "tries="), 1, 100)
			if !ok {
				opts.bad = "tries= is a number of runs, from 1 to 100"
			}
			opts.tries = n
		case strings.HasPrefix(args[i], "events="):
			opts.events = strings.TrimPrefix(args[i], "events=")
		}
	}
	return opts
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

// lostLease says, in the command's own words, why listen stops: another
// session listens (and what, as quadit listening reads it), or took the
// lease over; and reports it as refused.
func (r *runner) lostLease(err error, events *listenEvents) error {
	var ae *APIError
	if errors.As(err, &ae) && ae.Reason == "lease_stale" {
		events.say("refused", map[string]any{"why": "taken_over"})
		return errors.New("another session took the lease over; this listen stops")
	}
	who := r.listener()
	refused := map[string]any{"why": "listening_elsewhere"}
	if core.ListenerLabel.MatchString(who.By) {
		refused["by"] = who.By
	}
	if timeForm.MatchString(who.LastHeard) {
		refused["last_heard"] = who.LastHeard
	}
	events.say("refused", refused)
	return errors.New(r.whoListens())
}

// wholeIn reads a whole number from lo to hi.
func wholeIn(v string, lo, hi int) (int, bool) {
	n, err := strconv.Atoi(v)
	return n, err == nil && n >= lo && n <= hi
}

// handleForEvents is the agent's handle, in its form, for the started
// event; nothing without events, or when it cannot be had.
func (r *runner) handleForEvents(events *listenEvents) string {
	if events == nil {
		return ""
	}
	raw, err := r.c.JSON(r.ctx, "/me", url.Values{})
	var me struct{ Handle string }
	if err != nil || json.Unmarshal(raw, &me) != nil || !handleForm.MatchString(me.Handle) {
		return ""
	}
	return me.Handle
}

// waitHold is the longest the server holds one wait; a longer wait is
// several, each renewing the lease, up to maxWait in all (a wait in the
// background). A request may take holdSlack more than its hold before it
// is given up.
const (
	waitHold  = 50 * time.Second
	maxWait   = time.Hour
	holdSlack = 10 * time.Second
)

// listened is one answer of GET /listen: the lease, and the item with its
// feed position and its line in the feed, when one came.
type listened struct {
	Lease string      `json:"lease"`
	Seq   int64       `json:"seq"`
	Item  *listenItem `json:"item"`
	Line  string      `json:"line"`
}

// errStrangeLease refuses to use a lease id the server sent that is not of
// the form quadit gives one: it would go into a file and into commands.
var errStrangeLease = errors.New("the server sent a lease id quadit does not recognize, so nothing is printed to run")

// listenItem is an inbox item as GET /listen answers it.
type listenItem struct {
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Type    string `json:"type"`
	By      string `json:"by"`
	ByAgent bool   `json:"by_agent"`
	Task    string `json:"task"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
	Page    string `json:"page"`
	Thread  string `json:"thread"`
}

// listenAsk is one ask for the next item: on which cursor, with which
// lease (or none), whether to take it from another session, and what the
// asker says it is ("a chat", "a companion").
type listenAsk struct {
	cursor, lease string
	take          bool
	by            string
}

// nextItem asks for the next item, holding the lease (or taking one, from
// another session with take) for up to hold. The request is given up
// a little after its hold, whatever the client's own time limit.
func (r *runner) nextItem(ctx context.Context, ask listenAsk, hold time.Duration) (listened, error) {
	q := url.Values{"wait": {strconv.Itoa(max(int(hold.Round(time.Second).Seconds()), 1))}, "by": {ask.by}}
	if ask.cursor != "listen" {
		q.Set("cursor", ask.cursor)
	}
	if ask.lease != "" {
		q.Set("lease", ask.lease)
	}
	if ask.take {
		q.Set("take", "1")
	}
	ctx, cancel := context.WithTimeout(ctx, hold+holdSlack)
	defer cancel()
	var page listened
	raw, err := r.c.JSON(ctx, "/listen", q)
	if err != nil {
		return page, err
	}
	return page, json.Unmarshal(raw, &page)
}

// wait blocks until the caller's next inbox item, for= seconds at most (50
// when not given, up to maxWait), and prints one record for an agent to act
// on: the item and the exact commands to read it, acknowledge it and go on,
// or IDLE and the command to go on. The first wait takes the listener's
// lease, and the commands it prints carry it; take=1 takes it from another
// session. A long wait is many holds of the server's, each renewing the
// lease, so an agent that waits in the background for an hour costs
// nothing while nothing comes.
func (r *runner) wait(in input) error {
	total := waitHold
	goOn := "quadit wait"
	if v := in.f["for"]; len(v) > 0 {
		// The range is checked on the number, before it is made a duration that could overflow.
		n, err := strconv.Atoi(v[0])
		if err != nil || n < 1 || n > int(maxWait/time.Second) {
			return fmt.Errorf("for= is a number of seconds, from 1 to %d", int(maxWait/time.Second))
		}
		total = time.Duration(n) * time.Second
		goOn += " for=" + strconv.Itoa(n)
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
	for {
		page, err := r.nextItem(r.ctx, listenAsk{cursor: "listen", lease: lease, take: take, by: "a chat"}, min(span.hold, time.Until(deadline)))
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) && ae.Reason == "listening_elsewhere" {
				// Said in the command's own words, from what quadit listening reads, not in the server's.
				return fmt.Errorf("%s\n  only when the person says this session should listen instead: quadit wait take=1", r.whoListens())
			}
			return err
		}
		if !leaseForm.MatchString(page.Lease) {
			return errStrangeLease
		}
		lease, take = page.Lease, false
		next := fmt.Sprintf("%s lease=%s", goOn, lease)
		if item := page.Item; item != nil {
			if _, err := item.reading(); err != nil {
				return err
			}
			fmt.Fprintln(r.out, item.record())
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

// The forms of what the server sends that wait puts into a command or the
// item's line: a lease id (the server's alphabet without look-alikes), a
// task key, a page id, a handle, a kind of item.
var (
	leaseForm  = regexp.MustCompile(`^[A-HJKMNP-Z2-9]{8}$`)
	timeForm   = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$`)
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
		from := "from " + item.By
		if item.ByAgent {
			from += " (agent)"
		}
		parts = append(parts, from)
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

// record is what wait prints of the item for an agent to act on, without
// the commands to acknowledge it and wait again (a companion does those):
// its line, the command that reads it, and the one that answers it once.
// Nothing for no item.
func (item *listenItem) record() string {
	if item == nil {
		return ""
	}
	lines := []string{item.line()}
	if reading, err := item.reading(); err == nil {
		lines = append(lines, reading+"   # read it")
	}
	if answering := item.answering(); answering != "" {
		lines = append(lines, answering+"   # answer with this line, your words in the quotes")
	}
	return strings.Join(lines, "\n")
}

// answering is the command that answers the item where it was asked: in
// the comment thread it came from, or on its task. It carries a change id
// made from the item's own id, the same each time, so an answer sent twice
// (two sessions handed the same item, or one sent again after a crash) is
// made once. Nothing for an item there is no such place for, or whose ids
// are not of their form.
func (item listenItem) answering() string {
	if !pageForm.MatchString(item.ID) {
		return ""
	}
	sum := sha256.Sum256([]byte("quadit answer " + item.ID))
	h := hex.EncodeToString(sum[:16])
	// A UUID's form: version 8 (made by its maker's own rule), the usual variant.
	answerID := h[0:8] + "-" + h[8:12] + "-8" + h[13:16] + "-" + string("89ab"[sum[8]&3]) + h[17:20] + "-" + h[20:32]
	switch {
	case pageForm.MatchString(item.Thread):
		return fmt.Sprintf(`quadit reply %s "…" --id=%s`, item.Thread, answerID)
	case taskForm.MatchString(item.Task):
		return fmt.Sprintf(`quadit comment %s "…" --id=%s`, item.Task, answerID)
	}
	return ""
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

// listening says whether something listens as this login's member, what
// it said it is and since when, without taking the lease: so an agent in a
// chat can tell the person that a companion or the app already answers for
// it. With lease= it says whether that lease is the one that lives.
func (r *runner) listening(in input) error {
	q := url.Values{}
	if lease := firstValue(in.f["lease"]); leaseForm.MatchString(lease) {
		q.Set("lease", lease)
	}
	raw, err := r.c.JSON(r.ctx, "/listening", q)
	if err != nil {
		return err
	}
	if r.json {
		fmt.Fprintln(r.out, strings.TrimSpace(string(raw)))
		return nil
	}
	var who listener
	if err := json.Unmarshal(raw, &who); err != nil {
		return err
	}
	fmt.Fprint(r.out, who.sentences())
	return nil
}

// listener is what GET /listening answers.
type listener struct {
	Listening, Yours, Webhook bool
	By, Since                 string
	LastHeard                 string `json:"last_heard"`
}

// sentences say it, in the command's own words: what the holder said it
// is, and when, only in the forms a label and a time have.
func (who listener) sentences() string {
	by := "another session"
	if core.ListenerLabel.MatchString(who.By) {
		by = who.By
	}
	at := func(t string) string {
		if timeForm.MatchString(t) {
			return t + " UTC"
		}
		return "a time not given"
	}
	var out string
	switch {
	case who.Listening && who.Yours:
		out = fmt.Sprintf("This session listens, since %s.\n", at(who.Since))
	case who.Listening && who.Since == "":
		out = fmt.Sprintf("Something already listens as you: %s.\n", by)
	case who.Listening:
		out = fmt.Sprintf("Something already listens as you: %s, since %s (last heard %s).\n", by, at(who.Since), at(who.LastHeard))
	default:
		out = "Nothing listens as you.\n"
	}
	if who.Webhook {
		out += "A webhook delivers your inbox too.\n"
	}
	return out
}

// whoListens says what already listens as the caller, in one line, for a
// wait refused because of it.
func (r *runner) whoListens() string {
	who := r.listener()
	if !who.Listening {
		return "Another session already listens as you."
	}
	return strings.TrimSpace(who.sentences())
}

// listener is what GET /listening says; nothing listening when it cannot
// be had.
func (r *runner) listener() listener {
	var who listener
	if raw, err := r.c.JSON(r.ctx, "/listening", url.Values{}); err == nil {
		_ = json.Unmarshal(raw, &who)
	}
	return who
}
