// One attempt of a run: the program started in the folder, in a process
// group of its own, with a clean environment and the prompt on its
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
	"os/exec"
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
// end by itself.
func (r *agentRun) attempt(ctx context.Context, spec runSpec, prompt string, n int) (outcome, attemptEnd) {
	e := r.e
	t := e.srv.host.times
	clock := e.srv.host.clock
	log := e.srv.runLog(r.id)
	defer log.close()
	log.line("attempt", fmt.Sprintf("%d: %s %s", n, e.reg.ProgramPath, strings.Join(e.prog.Command(spec), " ")))

	outRead, outWrite, err := os.Pipe()
	if err != nil {
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		outRead.Close()
		outWrite.Close()
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself
	}
	// The program is stopped by its group's ladder, never by a context.
	cmd := exec.CommandContext(context.WithoutCancel(ctx), e.reg.ProgramPath, e.prog.Command(spec)...)
	cmd.Dir = e.reg.Folder
	cmd.Env = programEnv(os.Environ(), e.reg.Login, r.key, r.id)
	cmd.Stdin = strings.NewReader(prompt)
	cmd.Stdout, cmd.Stderr = outWrite, errWrite

	r.mu.Lock()
	r.j.Phase, r.j.Attempt, r.j.PGID, r.j.ProcStart = phaseLaunching, n, 0, ""
	r.saveJournal()
	r.mu.Unlock()
	err = startInGroup(cmd)
	outWrite.Close() // the program holds its own ends now
	errWrite.Close()
	if err != nil {
		outRead.Close()
		errRead.Close()
		log.line("attempt", "not started: "+err.Error())
		return outcome{Kind: outcomeFailed, Detail: err.Error()}, endedItself
	}
	pgid := cmd.Process.Pid
	started, _ := processStart(ctx, pgid) // none: a later start cannot recognize it, so it is never stopped by mistake
	r.mu.Lock()
	r.j.Phase, r.j.PGID, r.j.ProcStart = phaseLaunched, pgid, started
	if r.accepted {
		r.j.Phase = phaseAccepted // an earlier attempt's program took the prompt
	}
	r.saveJournal()
	r.mu.Unlock()
	awake := keepAwake(ctx, pgid)

	reader := e.prog.Reader(spec)
	var lastOutput atomic.Int64
	lastOutput.Store(int64(clock.Awake()))
	var stderr tail
	var readers sync.WaitGroup
	readers.Go(func() {
		eachLine(outRead, func(line []byte) {
			lastOutput.Store(int64(clock.Awake()))
			log.line("out", string(line))
			r.sawEvents(reader.Line(line), clock.Now())
		})
	})
	readers.Go(func() {
		eachLine(errRead, func(line []byte) {
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
watch:
	for {
		select {
		case <-exited:
			break watch
		case <-r.stopAsked:
			how = endedByStop
			e.srv.ladder(pgid, t.stopLadder, exited)
		case <-r.leaseGone:
			how = endedLeaseLost
			e.srv.ladder(pgid, t.infraLadder, exited)
		case <-ctx.Done():
			how = endedInfra
			e.srv.ladder(pgid, t.infraLadder, exited)
		case <-capped:
			how = endedTimeLimit
			e.srv.ladder(pgid, t.stopLadder, exited)
		case <-tick.C:
			if clock.Awake()-time.Duration(lastOutput.Load()) >= t.idle {
				how = endedIdle
				e.srv.ladder(pgid, t.stopLadder, exited)
			}
		}
		if how != endedItself {
			<-exited
			break
		}
	}

	// Its output is drained, for a while at most: what it started may still
	// hold the pipes. Then what is left of its group is stopped.
	drained := make(chan struct{})
	go func() {
		readers.Wait()
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(t.drain):
	}
	if groupAlive(pgid) {
		e.srv.ladder(pgid, t.infraLadder, nil)
	}
	outRead.Close()
	errRead.Close()
	<-drained
	awake()

	exit := cmd.ProcessState.ExitCode()
	out := reader.End(exit, stderr.bytes())
	log.line("attempt", fmt.Sprintf("%d ended: exit %d, %s", n, exit, out.Detail))
	return out, how
}

// eachLine calls each for every line read from rd, without its line
// break, until rd ends. A line longer than maxLine is given empty.
func eachLine(rd io.Reader, each func([]byte)) {
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
			each([]byte(strings.TrimRight(string(line), "\r\n")))
		}
		line, tooLong = line[:0], false
		if err != nil {
			return
		}
	}
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
	mu sync.Mutex
	f  *os.File
}

// runLog opens the log of a run, to add to it.
func (srv *serving) runLog(run string) *runLog {
	_ = os.MkdirAll(srv.files.runs(), 0o700) // no folder: the run has no log, and works the same
	f, err := os.OpenFile(filepath.Join(srv.files.runs(), run+".log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return &runLog{}
	}
	return &runLog{f: f}
}

func (l *runLog) line(mark, text string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		_, _ = fmt.Fprintf(l.f, "%s %s\n", mark, text) // a log line lost loses nothing else
	}
}

func (l *runLog) close() {
	if l.f != nil {
		l.f.Close()
	}
}

// ladder stops a process group: each step's signal to the whole group,
// then the step's time for the group to be gone, before the next. With
// exited, the group's leader is reaped by whoever closes it; without,
// someone else already reaped it.
func (srv *serving) ladder(pgid int, steps []ladderStep, exited <-chan struct{}) {
	for _, step := range steps {
		signalGroup(pgid, step.sig)
		deadline := time.Now().Add(step.within)
		for {
			leaderGone := exited == nil
			if !leaderGone {
				select {
				case <-exited:
					leaderGone = true
				default:
				}
			}
			if leaderGone && !groupAlive(pgid) {
				return
			}
			if !time.Now().Before(deadline) {
				break
			}
			time.Sleep(srv.host.times.pollGroup)
		}
	}
}
