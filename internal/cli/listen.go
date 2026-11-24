// The listener's commands: listen, the companion that runs a command for
// each inbox item, and wait, which an agent in a chat runs to be handed the
// next one. Both listen to one project (project=KEY) or to everything, and
// read through GET /listen, which lets one session at a time hold the lease
// of the agent's listener of that scope, and move its cursor only by
// acknowledging an item with it.

package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
// It holds the lease of the agent's listener of everything, or of one
// project with project=KEY, and stops when another session holds it or
// takes it over, or when the server refuses it (a person's login, a token
// revoked, a server too old to listen by project); take=1 takes the lease
// over. It says what it is to whoever asks what listens ("a companion", or
// what by= says: the desktop app says "the Quadit app"). The lease's id is
// kept beside the login file, one for each scope, so a companion stopped or
// restarted goes on with the lease it held. With events=PATH it reports
// each run, an item given up, and being refused, for whatever started it
// (listen_runs.go).
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
		return errors.New("usage: quadit listen [project=KEY] [take=1] [by=WORDS] [limit=SECONDS] [tries=N] [events=PATH] --exec COMMAND [ARG ...]")
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
	take := opts.take
	fmt.Fprintf(r.out, "listening; running %q for each inbox item\n", strings.Join(opts.command, " "))
	const (
		firstPause   = time.Second
		maxReadPause = 30 * time.Second // the server or the network is away
		maxItemPause = 5 * time.Minute  // an item's command keeps failing
	)
	readPause, itemPause := firstPause, firstPause
	kept, err := openLeaseFile(r.c, opts.project)
	if err != nil {
		return err
	}
	defer kept.close()
	lease := kept.kept()
	if err := r.checkListensByProject(opts.project, lease); err != nil {
		return err
	}
	var failedSeq int64 // the item whose runs failed, failed times in a row
	failed := 0
	for {
		page, err := r.nextItem(r.ctx, listenAsk{project: opts.project, lease: lease, take: take, by: opts.by}, waitHold)
		if err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			if listenRefused(err, events) {
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
		if !leaseForm.MatchString(page.Lease) {
			return errStrangeLease
		}
		if _, err := page.scope(opts.project); err != nil {
			return err
		}
		if page.Lease != lease {
			kept.keep(page.Lease)
		}
		lease, take = page.Lease, false
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
					_, _ = r.nextItem(ctx, listenAsk{project: opts.project, lease: lease, by: opts.by}, time.Second) // a renewal that fails leaves the lease to its ninety seconds
				}
			}
		}
		events.say("run_started", map[string]any{"seq": page.Seq})
		end := r.wake(opts.command, opts.secrets, wakeItem{line: page.Line, record: page.Item.record()}, opts.limit, renew)
		if r.ctx.Err() != nil {
			return r.ctx.Err()
		}
		status := any(end.code)
		if end.limited {
			status = "limit"
		}
		events.say("run_ended", map[string]any{"seq": page.Seq, "status": status})
		if end.err != nil {
			failed++
			if opts.tries == 0 || failed < opts.tries {
				fmt.Fprintf(r.out, "not handled, trying it again in %s: %v\n", itemPause, end.err)
				fmt.Fprintf(r.out, "  to give up on it: %s\n", giveUp(page.Seq, lease))
				if err := pause(r.ctx, itemPause); err != nil {
					return err
				}
				itemPause = min(itemPause*2, maxItemPause)
				continue
			}
			// Given up: acknowledged, so the next item comes. It stays unread in the agent's inbox.
			fmt.Fprintf(r.out, "gave up on #%d after %d failed runs; it stays unread in quadit inbox\n", page.Seq, failed)
			events.say("gave_up", map[string]any{"seq": page.Seq})
		}
		itemPause = firstPause
		if _, err := r.setCursor("listen", page.Seq, lease); err != nil {
			if r.ctx.Err() != nil {
				return r.ctx.Err()
			}
			if listenRefused(err, events) {
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

// listenOptions are what listen was given: the command after --exec, the
// secrets it gets, the project it listens to (project=; none: everything),
// whether to take the lease over (take=1), and what it says it is (by=).
type listenOptions struct {
	command, secrets []string
	project          string
	take             bool
	by               string
	limit            time.Duration // the longest one run may take; 0: no limit
	tries            int           // failed runs of one item before it is given up; 0: never
	events           string        // where to report what happens (events=PATH)
	bad              string        // what is wrong with the arguments, when something is
}

// listenArgs reads them.
func listenArgs(args []string) listenOptions {
	opts := listenOptions{by: "a companion"}
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
		case strings.HasPrefix(args[i], "by="):
			opts.by = strings.TrimPrefix(args[i], "by=")
		case strings.HasPrefix(args[i], "project="):
			var err error
			if opts.project, err = projectArg(strings.TrimPrefix(args[i], "project=")); err != nil {
				opts.bad = err.Error()
			}
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
// be tried again, with the listener's lease: the lease says which
// listener's cursor it is.
func giveUp(seq int64, lease string) string {
	return fmt.Sprintf("quadit ack %d listen lease=%s", seq, lease)
}

// listenRefused reports whether the server refused listen in a way waiting
// will not change: another session holds the lease or took it over (said
// on the events channel as refused, with the reason), or a refusal of the
// request itself (a person's login, a token revoked). A server or a
// network away is tried again.
func listenRefused(err error, events *listenEvents) bool {
	var ae *APIError
	if !errors.As(err, &ae) {
		return false
	}
	if ae.Reason == "listening_elsewhere" || ae.Reason == "lease_stale" {
		events.say("refused", map[string]any{"why": ae.Reason})
		return true
	}
	return ae.Status >= 400 && ae.Status < 500 && ae.Status != http.StatusRequestTimeout && ae.Status != http.StatusTooManyRequests
}

// wholeIn reads a whole number from lo to hi.
func wholeIn(v string, lo, hi int) (int, bool) {
	n, err := strconv.Atoi(v)
	return n, err == nil && n >= lo && n <= hi
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

// listened is one answer of GET /listen: the lease, the key of the project
// it listens to (none: everything), and the item with its feed position
// and its line in the feed, when one came.
type listened struct {
	Lease   string      `json:"lease"`
	Project string      `json:"project"`
	Seq     int64       `json:"seq"`
	Item    *listenItem `json:"item"`
	Line    string      `json:"line"`
}

// errOlderServer stops a listener asked for one project by a server that
// does not say it listens to one: a server from before listening by
// project ignores project= and hands over every item.
var errOlderServer = errors.New("this Quadit server is older and cannot listen to one project: it would hand this session every item, of every project. Listen without project=, or update the server")

// scope is the key of the project the answer says it listens to, checked
// against what was asked: a project, or none (project is ""). A server that
// does not say, when a project was asked, is too old to listen by project.
func (page listened) scope(project string) (string, error) {
	switch {
	case project == "":
		return "", nil
	case page.Project == "":
		return "", errOlderServer
	case !keyForm.MatchString(page.Project):
		return "", fmt.Errorf("the server sent a project key quadit does not recognize (%q), so nothing is printed to run", page.Project)
	}
	return page.Project, nil
}

// checkListensByProject stops a listener of a project that starts with no
// lease when the server is too old to listen by project, before it asks
// for one: GET /listening takes no lease, and an older server's answer
// lists no listeners. One that goes on with a lease was answered already.
func (r *runner) checkListensByProject(project, lease string) error {
	if project == "" || lease != "" {
		return nil
	}
	raw, err := r.c.JSON(r.ctx, "/listening", url.Values{})
	if err != nil {
		return err
	}
	var answer struct {
		Listeners *[]listenerShown `json:"listeners"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return err
	}
	if answer.Listeners == nil {
		return errOlderServer
	}
	return nil
}

// projectArg checks a project= given: a project's key (in any case) or
// id, the forms the server takes; it goes into the commands printed.
func projectArg(v string) (string, error) {
	if up := strings.ToUpper(v); keyForm.MatchString(up) {
		return up, nil
	}
	if pageForm.MatchString(v) {
		return v, nil
	}
	return "", errors.New("project= is a project's key (SVA) or id: quadit me lists yours")
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

// listenAsk is one ask for the next item: of the listener of which
// project (none: everything), with which lease (or none), whether to take
// it from another session, and what the asker says it is ("a chat", "a
// companion").
type listenAsk struct {
	project string
	lease   string
	take    bool
	by      string
}

// nextItem asks for the next item, holding the lease (or taking one, from
// another session with take) for up to hold. The request is given up
// a little after its hold, whatever the client's own time limit.
func (r *runner) nextItem(ctx context.Context, ask listenAsk, hold time.Duration) (listened, error) {
	q := url.Values{"wait": {strconv.Itoa(max(int(hold.Round(time.Second).Seconds()), 1))}, "by": {ask.by}}
	if ask.lease != "" {
		q.Set("lease", ask.lease)
	}
	if ask.take {
		q.Set("take", "1")
	}
	if ask.project != "" {
		q.Set("project", ask.project)
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
// or IDLE and the command to go on. It listens to everything, or to one
// project with project=KEY. The first wait takes the lease of the
// listener of that scope, and the commands it prints carry it, and the
// project; take=1 takes it from another session. A long wait is many holds
// of the server's, each renewing the lease, so an agent that waits in the
// background for an hour costs nothing while nothing comes.
func (r *runner) wait(in input) error {
	ask := listenAsk{lease: firstValue(in.f["lease"]), by: "a chat"}
	ask.take = slices.Contains([]string{"1", "true", "yes"}, strings.ToLower(firstValue(in.f["take"])))
	if v := firstValue(in.f["project"]); v != "" {
		var err error
		if ask.project, err = projectArg(v); err != nil {
			return err
		}
	}
	total, forArg := waitHold, ""
	if v := in.f["for"]; len(v) > 0 {
		// The range is checked on the number, before it is made a duration that could overflow.
		n, err := strconv.Atoi(v[0])
		if err != nil || n < 1 || n > int(maxWait/time.Second) {
			return fmt.Errorf("for= is a number of seconds, from 1 to %d", int(maxWait/time.Second))
		}
		total, forArg = time.Duration(n)*time.Second, " for="+strconv.Itoa(n)
	}
	return r.waitFor(waitSpan{total: total, hold: waitHold}, ask, forArg)
}

// waitSpan is how long a wait blocks in all, and the most the server is
// asked to hold one request of it.
type waitSpan struct{ total, hold time.Duration }

// waitFor is wait, once its arguments are read: it asks as ask says for
// span, and prints the record; forArg is the for= that the command that
// waits again carries (" for=N"), or "".
//
// What it prints is run by an agent as written, so nothing the server sent
// goes into it unless it has the form quadit gives it: a lease id, a
// project or task key, a page id, a handle. The item's words are shown in
// quotes, without what could end them or start a line.
func (r *runner) waitFor(span waitSpan, ask listenAsk, forArg string) error {
	if err := r.checkListensByProject(ask.project, ask.lease); err != nil {
		return err
	}
	deadline := time.Now().Add(span.total)
	for {
		page, err := r.nextItem(r.ctx, ask, min(span.hold, time.Until(deadline)))
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) && ae.Reason == "listening_elsewhere" {
				return fmt.Errorf("%w\n  only when the person says this session should listen instead: %s", err, waitCommand(ask.project, " take=1"))
			}
			return err
		}
		if !leaseForm.MatchString(page.Lease) {
			return errStrangeLease
		}
		project, err := page.scope(ask.project)
		if err != nil {
			return err
		}
		ask.lease, ask.take = page.Lease, false
		next := fmt.Sprintf("%s lease=%s", waitCommand(project, forArg), ask.lease)
		if item := page.Item; item != nil {
			if _, err := item.reading(); err != nil {
				return err
			}
			fmt.Fprintln(r.out, item.record())
			fmt.Fprintf(r.out, "quadit ack %d listen lease=%s   # once it is handled\n", item.Seq, ask.lease)
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

// waitCommand is the command that waits again: of the project of key
// project (none: everything), with rest after it (" for=N", " take=1").
func waitCommand(project, rest string) string {
	if project == "" {
		return "quadit wait" + rest
	}
	return "quadit wait project=" + project + rest
}

// The forms of what the server sends that wait puts into a command or the
// item's line: a lease id (the server's alphabet without look-alikes), a
// project's key, a task key, a page id, a handle, a kind of item.
var (
	leaseForm  = regexp.MustCompile(`^[A-HJKMNP-Z2-9]{8}$`)
	keyForm    = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)
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

// listening says what listens as this login's member, what each listener
// said it is and when it was last heard, without taking a lease: so an
// agent in a chat can tell the person that a companion or the app already
// answers for it, and which projects listen by themselves. `listening
// forget project=KEY` forgets that project's listener instead.
func (r *runner) listening(in input) error {
	if len(in.pos) > 0 {
		if in.pos[0] != "forget" {
			return errors.New("usage: quadit listening [forget project=KEY]")
		}
		return r.forgetListener(firstValue(in.f["project"]))
	}
	raw, err := r.c.JSON(r.ctx, "/listening", url.Values{})
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
	fmt.Fprint(r.out, who.lines())
	return nil
}

// listener is what GET /listening answers: the listener of everything's
// lease, and every listener (none from a server from before projects).
type listener struct {
	Listening bool
	By        string
	LastHeard string `json:"last_heard"`
	Listeners []listenerShown
}

// listenerShown is one listener as GET /listening tells it: its project's
// key (none: everything), what holds it, when it was last heard, and
// whether its lease lives.
type listenerShown struct {
	Project   string
	By        string
	LastHeard string `json:"last_heard"`
	Live      bool
}

// lines say it, in the command's own words: with no project listening by
// itself, one sentence on everything, as before projects; else a line for
// each project and one for everything else, which leaves those projects
// out. What the server sent is printed only in the forms a key, a label
// and a time have.
func (who listener) lines() string {
	var out strings.Builder
	var own []string
	for _, l := range who.Listeners {
		if l.Project == "" || !keyForm.MatchString(l.Project) {
			continue
		}
		own = append(own, l.Project)
		if l.Live {
			fmt.Fprintf(&out, "%s: %s listens%s.\n", l.Project, label(l.By), heard(l.LastHeard))
		} else {
			fmt.Fprintf(&out, "%s: nothing listens now; its items wait for the next %s (or, to hand them to everything instead: quadit listening forget project=%s).\n",
				l.Project, waitCommand(l.Project, ""), l.Project)
		}
	}
	if len(own) == 0 {
		if !who.Listening {
			return "Nothing listens as you.\n"
		}
		return fmt.Sprintf("Something already listens as you: %s%s.\n", label(who.By), heard(who.LastHeard))
	}
	if who.Listening {
		fmt.Fprintf(&out, "Everything else: %s listens%s;", label(who.By), heard(who.LastHeard))
	} else {
		out.WriteString("Everything else: nothing listens now, and those items wait in the inbox;")
	}
	which := "which have listeners of their own"
	if len(own) == 1 {
		which = "which has a listener of its own"
	}
	fmt.Fprintf(&out, " it leaves out %s, %s.\n", strings.Join(own, ", "), which)
	return out.String()
}

// label is what a listener said it is, when it has the form of a label.
func label(by string) string {
	if core.ListenerLabel.MatchString(by) {
		return by
	}
	return "another session"
}

// heard says when a listener was last heard, when the time has its form.
func heard(at string) string {
	if !timeForm.MatchString(at) {
		return ""
	}
	return " (last heard " + at + " UTC)"
}

// forgetListener forgets the listener of a project, so that its items go
// to the listener of everything again.
func (r *runner) forgetListener(project string) error {
	project, err := projectArg(project)
	if err != nil {
		return err
	}
	raw, err := r.send("DELETE", "/listening/"+url.PathEscape(project), nil, nil, "")
	if err != nil {
		return err
	}
	var done struct{ Forgotten bool }
	if err := json.Unmarshal(raw, &done); err != nil {
		return err
	}
	if r.dry {
		fmt.Fprint(r.out, "would be accepted: ")
	}
	if !done.Forgotten {
		fmt.Fprintf(r.out, "%s has no listener of its own: its items go to whatever listens to everything.\n", project)
		return nil
	}
	fmt.Fprintf(r.out, "Forgot the listener of %s: from now on its items go to whatever listens to everything; what was waiting stays unread in the inbox.\n", project)
	return nil
}
