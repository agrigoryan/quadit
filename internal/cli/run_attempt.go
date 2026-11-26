// One attempt of a run: the program started in the folder, in a process
// group of its own (a job object on Windows), with a clean environment and the prompt on its
// standard input; its standard output read as the protocol and both its
// outputs logged; watched for silence and for the entry's time cap; and
// stopped, with everything it started, by the ladder each end calls for.

package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// groupSignal is a signal a ladder sends to a process group.
type groupSignal int

const (
	sigInterrupt groupSignal = iota
	sigTerminate
	sigKill
)

// ladderStep is one signal of a ladder and how long it is given to work.
type ladderStep struct {
	sig    groupSignal
	within time.Duration
}

// programEnv is the environment of a program the runner starts: the
// runner's own, without the variables of another Claude Code session, of
// any Quadit login, or of Electron, then the run's own: the entry's login,
// the task and the run (when there is one), and no colors. Nothing else is
// removed: the programs' own sign-in and network settings can come through
// the environment, and a list of what is allowed would break them.
func programEnv(base []string, login, task, run string) []string {
	env := make([]string, 0, len(base)+4)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		if name == "CLAUDECODE" || strings.HasPrefix(name, "CLAUDE_CODE_") || strings.HasPrefix(name, "QUADIT_") || strings.HasPrefix(name, "ELECTRON_") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "QUADIT_CONFIG="+login, "NO_COLOR=1")
	if task != "" {
		env = append(env, "QUADIT_TASK="+task, "QUADIT_SESSION="+run)
	}
	return env
}

// maxLine is the longest output line read as the protocol; a longer one
// is passed over (it still counts as output).
const maxLine = 16 << 20

// keptStderr is how much of the end of the program's standard error is
// kept to read its error words in.
const keptStderr = 64 << 10

// attempt starts the program once and waits for its end. It gives the
// outcome its reader read, and what ended it when the program did not
// end by itself; endedNotStarted when it was not started at all (the run
// ended first, or the launch could not be recorded: then an error).
func (r *agentRun) attempt(ctx context.Context, spec runSpec, prompt string, n int) (outcome, attemptEnd, error) {
	e := r.e
	t := e.srv.host.times
	clock := e.srv.host.clock
	log := e.srv.runLog(r.id)
	defer log.close()
	log.line("attempt", fmt.Sprintf("%d: %s %s", n, e.reg.ProgramPath, strings.Join(e.prog.Command(spec), " ")))

	// The program is stopped by its group's ladder, never by a context.
	cmd, err := programCommand(context.WithoutCancel(ctx), e.reg.ProgramPath, e.prog.Command(spec))
	if err != nil {
		log.line("attempt", "not started: "+err.Error())
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself, nil
	}
	outRead, outWrite, err := os.Pipe()
	if err != nil {
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself, nil
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		outRead.Close()
		outWrite.Close()
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself, nil
	}
	cmd.Dir = e.reg.Folder
	cmd.Env = programEnv(os.Environ(), e.reg.Login, r.key, r.id)
	cmd.Stdin = strings.NewReader(prompt)
	cmd.Stdout, cmd.Stderr = outWrite, errWrite

	closeAll := func() {
		outRead.Close()
		outWrite.Close()
		errRead.Close()
		errWrite.Close()
	}
	// The launch is written down before it happens; a launch that cannot
	// be written down does not happen.
	r.mu.Lock()
	r.j.Phase, r.j.Attempt, r.j.PGID, r.j.ProcStart = phaseLaunching, n, 0, ""
	err = r.saveJournal()
	r.mu.Unlock()
	if err != nil {
		closeAll()
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedNotStarted, fmt.Errorf("the run's journal: %w", err)
	}
	// The last look before the start: nothing slow lies between it and the
	// start. The folder and the program are still the ones checked.
	if end := r.endNow(ctx); end != endedItself {
		closeAll()
		return outcome{Kind: outcomeFailed}, end, nil
	}
	if pause := e.stillAsChecked(); pause != "" {
		closeAll()
		return outcome{Kind: outcomeFailed, Detail: pause}, endedMoved, nil
	}
	group, err := startInGroup(cmd)
	outWrite.Close() // the program holds its own ends now
	errWrite.Close()
	if err != nil {
		outRead.Close()
		errRead.Close()
		log.line("attempt", "not started: "+err.Error())
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself, nil
	}
	// Known gap on macOS and Linux, left on purpose: a runner killed in the
	// few milliseconds between the start and the journal's next write
	// leaves a program whose group is not on disk; recovery then ends its
	// run as interrupted but cannot stop it. Closing it needs the child held
	// until its group is written, which takes a wrapper process. (On
	// Windows the program's job ends with the runner.)
	defer group.release()
	pgid := group.id()
	started, startErr := processStart(ctx, pgid)
	r.mu.Lock()
	r.j.Phase, r.j.PGID, r.j.ProcStart = phaseLaunched, pgid, started
	if r.accepted {
		r.j.Phase = phaseAccepted // an earlier attempt's program took the prompt
	}
	err = errors.Join(startErr, r.saveJournal())
	r.mu.Unlock()
	if err != nil {
		// What would let a later start recognize the program is not on
		// disk: it is stopped at once rather than left to run unseen.
		e.srv.ladder(group, t.infraLadder, nil, nil)
		_ = cmd.Wait() // its group is stopped; its status says nothing more
		outRead.Close()
		errRead.Close()
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedUnrecorded, fmt.Errorf("the program could not be recorded: %w", err)
	}
	awake := keepAwake(ctx, pgid)

	reader := e.prog.Reader(spec)
	var lastOutput atomic.Int64
	lastOutput.Store(int64(clock.Awake()))
	var stderr tail
	// The protocol's lines are read off the pipe by one goroutine and acted
	// on by another, in order: what a line leads to (the journal and the
	// state written through to the disk) never holds the reading back, so
	// everything the program wrote before it ended is read before the pipe
	// is let go, however slow the disk. A line lost there could be the one
	// that showed work began, and the attempt would be repeated.
	lines := newLineQueue()
	acted := make(chan struct{})
	go func() {
		defer close(acted)
		for {
			line, ok := lines.next()
			if !ok {
				return
			}
			if line.discarded {
				// A record that could not be read may have been a tool's:
				// the attempt is not safe to repeat.
				log.line("out", "(a line too long to read, passed over)")
				r.sawEvents([]programEvent{{Kind: evUnreadable}}, clock.Now())
				continue
			}
			log.line("out", string(line.text))
			r.sawEvents(reader.Line(line.text), clock.Now())
		}
	}()
	var readers sync.WaitGroup
	readers.Go(func() {
		defer lines.end()
		eachLine(outRead, func(line []byte, discarded bool) {
			lastOutput.Store(int64(clock.Awake()))
			lines.add(outputLine{text: line, discarded: discarded})
		})
	})
	readers.Go(func() {
		eachLine(errRead, func(line []byte, _ bool) {
			lastOutput.Store(int64(clock.Awake()))
			log.line("err", string(line))
			stderr.add(line)
		})
	})
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait() // its status is read from cmd.ProcessState below
		close(exited)
	}()

	how := endedItself
	tick := time.NewTicker(t.watchdogTick)
	defer tick.Stop()
	var capped <-chan time.Time
	if e.reg.MaxMinutes > 0 {
		left := time.Duration(e.reg.MaxMinutes)*time.Minute - clock.Now().Sub(r.received)
		timer := time.NewTimer(max(left, 0))
		defer timer.Stop()
		capped = timer.C
	}
	// What ended the program is decided when it exits: a stop asked by
	// then makes the run stopped; one asked later changes nothing. The
	// slower ladders give way to the runner's own stop (ctx).
watch:
	for {
		select {
		case <-exited:
			if r.stopped() {
				how = endedByStop
			}
			break watch
		case <-r.stopAsked:
			how = endedByStop
			e.srv.ladder(group, t.stopLadder, exited, ctx.Done())
		case <-r.leaseGone:
			how = endedLeaseLost
			e.srv.ladder(group, t.infraLadder, exited, nil)
		case <-ctx.Done():
			how = endedInfra
			e.srv.ladder(group, t.infraLadder, exited, nil)
		case <-capped:
			how = endedTimeLimit
			e.srv.ladder(group, t.stopLadder, exited, ctx.Done())
		case <-tick.C:
			if clock.Awake()-time.Duration(lastOutput.Load()) >= t.idle {
				how = endedIdle
				e.srv.ladder(group, t.stopLadder, exited, ctx.Done())
			}
		}
		if how != endedItself {
			<-exited
			break
		}
	}

	// Its output is drained, for a while at most, and no longer than the
	// runner's own stop allows: what it started may still hold the pipes.
	// Then what is left of its group is stopped.
	drained := make(chan struct{})
	go func() {
		readers.Wait()
		close(drained)
	}()
	drainFor := time.NewTimer(t.drain)
	defer drainFor.Stop()
	select {
	case <-drained:
	case <-drainFor.C:
	case <-ctx.Done():
	}
	if group.alive() {
		e.srv.ladder(group, t.infraLadder, nil, nil)
	}
	outRead.Close()
	errRead.Close()
	<-drained
	<-acted
	awake()

	exit := cmd.ProcessState.ExitCode()
	out := reader.End(exit, stderr.bytes())
	log.line("attempt", fmt.Sprintf("%d ended: exit %d, %s", n, exit, out.Detail))
	return out, how, nil
}

// eachLine calls each for every line read from rd, without its line
// break, until rd ends. A line longer than maxLine is given empty, and
// said discarded.
func eachLine(rd io.Reader, each func(line []byte, discarded bool)) {
	br := bufio.NewReaderSize(rd, 64<<10)
	var line []byte
	tooLong := false
	for {
		chunk, err := br.ReadSlice('\n')
		if !tooLong {
			line = append(line, chunk...)
			if len(line) > maxLine {
				tooLong, line = true, line[:0]
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if len(line) > 0 || tooLong || len(chunk) > 0 {
			each([]byte(strings.TrimRight(string(line), "\r\n")), tooLong)
		}
		line, tooLong = line[:0], false
		if err != nil {
			return
		}
	}
}

// outputLine is one line of the protocol's output as read: its text, or,
// discarded, a line too long to read.
type outputLine struct {
	text      []byte
	discarded bool
}

// lineQueue holds the lines read and not yet acted on, as many as come.
type lineQueue struct {
	mu    sync.Mutex
	more  *sync.Cond // on mu: a line was added, or the queue ended
	lines []outputLine
	ended bool
}

func newLineQueue() *lineQueue {
	q := &lineQueue{}
	q.more = sync.NewCond(&q.mu)
	return q
}

// add queues a line.
func (q *lineQueue) add(line outputLine) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.lines = append(q.lines, line)
	q.more.Signal()
}

// end says no line comes after those queued.
func (q *lineQueue) end() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.ended = true
	q.more.Signal()
}

// next waits for the next line; false once every line was taken and the
// queue ended.
func (q *lineQueue) next() (outputLine, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.lines) == 0 && !q.ended {
		q.more.Wait()
	}
	if len(q.lines) == 0 {
		return outputLine{}, false
	}
	line := q.lines[0]
	q.lines[0] = outputLine{} // let the queue's array go of it
	q.lines = q.lines[1:]
	return line, true
}

// tail keeps the end of what is added, up to keptStderr bytes.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) add(line []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(append(t.buf, line...), '\n')
	if len(t.buf) > keptStderr {
		t.buf = t.buf[len(t.buf)-keptStderr:]
	}
}

func (t *tail) bytes() []byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]byte(nil), t.buf...)
}

// runLog is a run's log, runs/<run id>.log: what its program printed, a
// line each, marked with the output it came on; kept 30 days.
type runLog struct {
	mu      sync.Mutex
	f       *os.File
	written int64
}

// maxRunLog is the most a run's log holds; past it, one line says so and
// the rest is not kept (it is still read).
const maxRunLog = 16 << 20

// runLog opens the log of a run, to add to it.
func (srv *serving) runLog(run string) *runLog {
	_ = os.MkdirAll(srv.files.runs(), 0o700) // no folder: the run has no log, and works the same
	f, err := os.OpenFile(filepath.Join(srv.files.runs(), run+".log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return &runLog{}
	}
	l := &runLog{f: f}
	if st, err := f.Stat(); err == nil {
		l.written = st.Size() // a run's log is one for all its attempts
	}
	return l
}

func (l *runLog) line(mark, text string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil || l.written > maxRunLog {
		return
	}
	line := mark + " " + text + "\n"
	if l.written += int64(len(line)); l.written > maxRunLog {
		line = "log (the rest of this run's output is not kept: the log is full)\n"
	}
	_, _ = io.WriteString(l.f, line) // a log line lost loses nothing else
}

func (l *runLog) close() {
	if l.f != nil {
		l.f.Close()
	}
}

// ladder stops a process group: each step's signal to the whole group,
// then the step's time for the group to be gone, before the next. With
// exited, the group's leader is reaped by whoever closes it; without,
// someone else already reaped it. When hurry closes, the ladder gives way
// to the infrastructure ladder at once: the runner itself is stopping.
func (srv *serving) ladder(group *processGroup, steps []ladderStep, exited, hurry <-chan struct{}) {
	for _, step := range steps {
		group.signal(step.sig)
		deadline := time.Now().Add(step.within)
		for {
			if !chanOpen(exited) && !group.alive() {
				return
			}
			if !time.Now().Before(deadline) {
				break
			}
			select {
			case <-hurry:
				srv.ladder(group, srv.host.times.infraLadder, exited, nil)
				return
			case <-time.After(srv.host.times.pollGroup):
			}
		}
	}
}

// chanOpen reports whether ch is a channel not closed yet (nil: none, so
// not open).
func chanOpen(ch <-chan struct{}) bool {
	if ch == nil {
		return false
	}
	select {
	case <-ch:
		return false
	default:
		return true
	}
}
