// What one entry of `quadit run` keeps on the computer between its runs
// (state.json: each task's program session, coverage and guard counts,
// and the entry's pause), and the one run in flight (journal.json), which
// is how a runner that stopped finds out what it left behind.

package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// entryState is state.json. Its first five fields bind it to its entry: a
// file that names anything else is set aside, and nothing is resumed from
// it.
type entryState struct {
	Server      string                `json:"server"`
	WorkspaceID string                `json:"workspace_id"`
	AgentID     string                `json:"agent_id"`
	Program     string                `json:"program"`
	Folder      string                `json:"folder"`
	Tasks       map[string]*taskState `json:"tasks"` // by the task's key
	// Automatic are the start times (ms) of the entry's automatic runs of
	// the last hour, whatever the task (G11).
	Automatic []int64     `json:"automatic,omitempty"`
	Pause     *pauseState `json:"pause,omitempty"`
}

// taskState is what an entry knows of one task across its runs.
type taskState struct {
	// Session is the program session the task's next run resumes; none:
	// the next starts fresh. Only the runner's own record is ever resumed.
	Session string `json:"session,omitempty"`
	// SessionFile is what the runner saw of the session's file after its
	// last run, so a write by something else since can be told.
	SessionFile *fileMark `json:"session_file,omitempty"`
	// Through is the last item a program of this task took (coverage).
	Through int64 `json:"through,omitempty"`
	// Continue is the head kept after a usage limit or a sign-in failure
	// that came after the work began: its next run continues, not replays.
	Continue *continueMark `json:"continue,omitempty"`
	// Automatic are the start times (ms) of the task's automatic runs of
	// the last hour (G3).
	Automatic []int64 `json:"automatic,omitempty"`
	// Quiet is whether each of the last two runs changed nothing on the
	// task (G4).
	Quiet []bool `json:"quiet,omitempty"`
	// Runs are the runs whose start was counted, and QuietRuns those whose
	// quiet was, so a replay counts each once.
	Runs      []string `json:"runs,omitempty"`
	QuietRuns []string `json:"quiet_runs,omitempty"`
}

// fileMark is what was seen of a file: its modification time (ms) and size.
type fileMark struct {
	MTime int64 `json:"mtime"`
	Size  int64 `json:"size"`
}

// continueMark is a kept head to continue: its feed position and its run.
type continueMark struct {
	Seq int64  `json:"seq"`
	Run string `json:"run"`
}

// pauseState is an entry's pause: why, until when for a usage limit (ms),
// and how long the next back-off of a usage limit with no reset said is.
type pauseState struct {
	Reason         string `json:"reason"`
	Until          int64  `json:"until,omitempty"`
	BackoffMinutes int    `json:"backoff_minutes,omitempty"`
}

// stateFile is an entry's state.json, read once and written whole after
// every change. It is shared by the entry's goroutines.
type stateFile struct {
	path string
	mu   sync.Mutex
	s    entryState
}

// keptRuns is how many run ids a task keeps to count each once.
const keptRuns = 50

// openState reads the entry's state, setting aside one bound to anything
// else (renamed .old) and beginning anew.
func openState(path string, bind entryState) (*stateFile, error) {
	f := &stateFile{path: path, s: bind}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		var s entryState
		if json.Unmarshal(raw, &s) == nil && s.Server == bind.Server && s.WorkspaceID == bind.WorkspaceID && s.AgentID == bind.AgentID &&
			s.Program == bind.Program && s.Folder == bind.Folder {
			f.s = s
		} else if err := os.Rename(path, path+".old"); err != nil {
			return nil, err
		}
	}
	if f.s.Tasks == nil {
		f.s.Tasks = map[string]*taskState{}
	}
	return f, nil
}

// read gives what read finds, under the lock.
func (f *stateFile) read(read func(s *entryState)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	read(&f.s)
}

// task is a copy of what the state holds of a task.
func (f *stateFile) task(key string) taskState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if t := f.s.Tasks[key]; t != nil {
		return *t
	}
	return taskState{}
}

// pause is a copy of the entry's pause, nil for none. (A pause lifted
// keeps only the back-off of a usage limit, which is not a pause.)
func (f *stateFile) pause() *pauseState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.s.Pause == nil || f.s.Pause.Reason == "" {
		return nil
	}
	p := *f.s.Pause
	return &p
}

// change changes the state and writes it whole.
func (f *stateFile) change(change func(s *entryState)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(&f.s)
	return writeWhole(f.path, plainJSON(f.s))
}

// changeTask changes one task's state and writes it whole.
func (f *stateFile) changeTask(key string, change func(t *taskState)) error {
	return f.change(func(s *entryState) {
		t := s.Tasks[key]
		if t == nil {
			t = &taskState{}
			s.Tasks[key] = t
		}
		change(t)
	})
}

// countStart counts an automatic run's start for G3 and G11, once per run.
func (f *stateFile) countStart(key, run string, at time.Time) error {
	return f.change(func(s *entryState) {
		t := s.Tasks[key]
		if t == nil {
			t = &taskState{}
			s.Tasks[key] = t
		}
		if slices.Contains(t.Runs, run) {
			return
		}
		t.Runs = lastOf(append(t.Runs, run), keptRuns)
		ms := at.UnixMilli()
		t.Automatic = append(withinHour(t.Automatic, at), ms)
		s.Automatic = append(withinHour(s.Automatic, at), ms)
	})
}

// countQuiet records, once per run, whether a run changed nothing on its
// task (G4).
func (f *stateFile) countQuiet(key, run string, quiet bool) error {
	return f.changeTask(key, func(t *taskState) {
		if slices.Contains(t.QuietRuns, run) {
			return
		}
		t.QuietRuns = lastOf(append(t.QuietRuns, run), keptRuns)
		t.Quiet = lastOf(append(t.Quiet, quiet), 2)
	})
}

// withinHour are the times (ms) of the hour before now.
func withinHour(times []int64, now time.Time) []int64 {
	from := now.Add(-time.Hour).UnixMilli()
	return slices.DeleteFunc(slices.Clone(times), func(ms int64) bool { return ms <= from })
}

// lastOf is the last n of list.
func lastOf[T any](list []T, n int) []T {
	if len(list) > n {
		return list[len(list)-n:]
	}
	return list
}

// journal is journal.json: the one run in flight.
type journal struct {
	Run      string      `json:"run"`
	Task     string      `json:"task"`
	Head     journalHead `json:"head"`
	Prompted []int64     `json:"prompted"`
	Lease    string      `json:"lease"`
	// Phase is how far the run got: received (the program has not been
	// started), launching (it is being started), launched, accepted (its
	// provider took the prompt).
	Phase        string         `json:"phase"`
	Attempt      int            `json:"attempt"`
	PGID         int            `json:"pgid,omitempty"`
	ProcStart    string         `json:"proc_start,omitempty"`
	Session      string         `json:"session,omitempty"`
	ToolActivity bool           `json:"tool_activity"`
	Automatic    bool           `json:"automatic"`
	StartSeq     int64          `json:"start_seq"`
	Ordinals     map[string]int `json:"ordinals,omitempty"` // the next ordinal of each write's name
}

// journalHead is the run's head item.
type journalHead struct {
	Seq  int64  `json:"seq"`
	Item string `json:"item"`
}

// The phases of a run in flight.
const (
	phaseReceived  = "received"
	phaseLaunching = "launching"
	phaseLaunched  = "launched"
	phaseAccepted  = "accepted"
)

func journalPath(entryDir string) string { return filepath.Join(entryDir, "journal.json") }

// readJournal is the run in flight, nil for none.
func readJournal(entryDir string) (*journal, error) {
	raw, err := os.ReadFile(journalPath(entryDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var j journal
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, err
	}
	return &j, nil
}

// writeJournal writes the run in flight whole.
func writeJournal(entryDir string, j journal) error {
	return writeWhole(journalPath(entryDir), plainJSON(j))
}

// clearJournal says no run is in flight.
func clearJournal(entryDir string) error {
	err := os.Remove(journalPath(entryDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
