//go:build windows

// What `quadit run` needs of the system, on Windows: file locks that the
// system lets go when the process ends (LockFileEx); a job object for each
// program, so a program and everything it started are counted and ended
// together, and end with the runner however it ends; and what asks a
// runner to stop (Ctrl-C, or the guard's stop event: guard_windows.go).

package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileIdentity is what names a file whatever its spelling: its volume's
// serial number and its file index, following links, as os.SameFile
// compares files on Windows. Two paths to one folder have one identity,
// however their case, separators or short names are written.
func fileIdentity(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	// No access asked: the file's information needs none, and nothing
	// else opening it is kept out.
	h, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer closeHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return "", &os.PathError{Op: "identify", Path: path, Err: err}
	}
	return fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}

// lockWith locks one byte of f far past anything written in it: a lock on
// Windows keeps every other handle from reading the bytes it covers, and
// runner.lock's holder writes its process id there for others to read.
func lockWith(f *os.File, flags uint32) error {
	at := windows.Overlapped{OffsetHigh: 0x7fffffff}
	return windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &at)
}

// tryLock takes f's lock for this process, or answers errLocked at once
// when another holder has it. A lock belongs to the handle that took it,
// so two opens of one file are two holders, even in one process, and the
// folder lock keeps two entries of one runner apart. The system lets it go
// when f is closed or the process ends, however it ends.
func tryLock(f *os.File) error {
	err := lockWith(f, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return errLocked
	}
	return err
}

// waitLock takes f's lock, waiting for whoever has it.
func waitLock(f *os.File) error { return lockWith(f, windows.LOCKFILE_EXCLUSIVE_LOCK) }

// programCommand is the command that starts the program at path with
// args, each given as it is: an .exe (or .com), or a .cmd or .bat, which
// is what npm installs a program as (claude.cmd, codex.cmd).
//
// A .cmd or .bat runs in cmd.exe, which reads its command line by rules of
// its own: %NAME% is expanded even inside double quotes, and outside them
// & | < > ^ ( ) are its own. Go quotes an argument only when it holds a
// space, and by the rules programs read their arguments by, not cmd.exe's
// (os/exec's documentation says so), so text in an argument could run as
// a command. The rule here: such a file is started through cmd.exe with a
// command line built for it, every argument in double quotes, where cmd.exe
// takes & | < > ^ ( ) as they are, delayed expansion off (!NAME! stays as
// it is) and the registry's AutoRun commands left out; and a path or an
// argument that holds what cmd.exe reads even inside quotes (a double
// quote, a % or a control character) is refused, never escaped. The
// runner's own arguments are fixed flags, UUIDs, a task's key and a file
// path of its own, so only such a character in the person's folder names
// can refuse a start. The guard applies the same rule to what it starts.
func programCommand(ctx context.Context, path string, args []string) (*exec.Cmd, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a program", path)
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".exe", ".com":
		return exec.CommandContext(ctx, path, args...), nil
	case ".cmd", ".bat":
	default:
		return nil, fmt.Errorf("%s is not a program Windows starts: give its .exe or its .cmd", path)
	}
	line := []string{`/d /v:off /s /c "` + batchQuoted(path)}
	for i, a := range append([]string{path}, args...) {
		if strings.ContainsFunc(a, func(r rune) bool { return r == '"' || r == '%' || unicode.IsControl(r) }) {
			return nil, fmt.Errorf("%s cannot be started with %q: a .cmd file's line may not hold a double quote, a %% or a control character", path, a)
		}
		if i > 0 {
			line = append(line, batchQuoted(a))
		}
	}
	shell := filepath.Join(systemRoot(), "System32", "cmd.exe")
	cmd := exec.CommandContext(ctx, shell)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: batchQuoted(shell) + " " + strings.Join(line, " ") + `"`}
	return cmd, nil
}

// batchQuoted is an argument with no double quote in it, in double quotes,
// read back as it is both by cmd.exe and by the program the .cmd starts:
// backslashes before the closing quote are doubled, so it is not read as
// a quote of the argument's own.
func batchQuoted(a string) string {
	trailing := len(a) - len(strings.TrimRight(a, `\`))
	return `"` + a + strings.Repeat(`\`, trailing) + `"`
}

// systemRoot is the folder Windows is installed in.
func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

// processGroup is a program the runner started, with everything it
// started since: the job object it was started in. The job ends what it
// holds when its last handle closes, so when the runner ends, however it
// ends, its programs end with it: nothing is left for a later runner to
// find (leftGroup is kept for the one process a journal names all the
// same). A group found by leftGroup has no job: its process alone.
type processGroup struct {
	pid     int
	process windows.Handle
	job     windows.Handle
}

// startInGroup starts cmd in a job object of its own. It is started
// suspended and let run only once it is in the job, so nothing it starts
// can be outside it; and with a console of its own and no window, so a
// runner with no console of its own (the desktop app's) opens no window
// for it, and Ctrl-C in the terminal of a runner started by hand reaches
// the runner, which stops it, not the program.
func startInGroup(cmd *exec.Cmd) (*processGroup, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("a job object: %w", err)
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		closeHandle(job)
		return nil, fmt.Errorf("a job object: %w", err)
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW
	if err := cmd.Start(); err != nil {
		closeHandle(job)
		return nil, err
	}
	g := &processGroup{pid: cmd.Process.Pid, job: job}
	// The process cannot go meanwhile: it is suspended, and os/exec holds
	// a handle of it until it is waited for, so its id names it.
	g.process, err = windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE,
		false, uint32(g.pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, g.process)
	}
	if err == nil {
		err = resumeProcess(g.pid)
	}
	if err != nil {
		_ = cmd.Process.Kill() // suspended, it ran nothing
		_ = cmd.Wait()         // reaped here: the caller has no process to wait for
		g.release()
		return nil, fmt.Errorf("the program could not be put in a job of its own: %w", err)
	}
	return g, nil
}

// resumeProcess lets the threads of a process started suspended run.
func resumeProcess(pid int) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer closeHandle(snap)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	resumed := false
	for err = windows.Thread32First(snap, &entry); err == nil; err = windows.Thread32Next(snap, &entry) {
		if entry.OwnerProcessID != uint32(pid) {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(thread)
		closeHandle(thread)
		if err != nil {
			return err
		}
		resumed = true
	}
	if !resumed {
		return fmt.Errorf("process %d has no thread", pid)
	}
	return nil
}

// leftGroup is the program a runner recorded before it stopped (its id and
// its start as processStart gave it), when it still runs: recognized by
// both, never by name. Its job ended with that runner, and so did what it
// started; it is its process alone.
func leftGroup(_ context.Context, id int, started string) (*processGroup, bool) {
	process, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(id))
	if err != nil {
		return nil, false
	}
	if now, err := creationTime(process); err != nil || now != started {
		closeHandle(process)
		return nil, false
	}
	return &processGroup{pid: id, process: process}, true
}

// id is what a journal records of the group: its program's process id.
func (g *processGroup) id() int { return g.pid }

// signal ends every process of the group outright, whichever signal is
// asked: Windows has no request to stop that a program without a console
// shared with the runner hears (Claude Code and Codex hear none other), so
// every step of a ladder is its last. A group that is gone is not an error.
func (g *processGroup) signal(groupSignal) {
	if g.job != 0 {
		_ = windows.TerminateJobObject(g.job, 1) // a job already empty has nothing to end
		return
	}
	_ = windows.TerminateProcess(g.process, 1) // a process already gone has nothing to end
}

// alive reports whether any process of the group is left.
func (g *processGroup) alive() bool {
	if g.job != 0 {
		var accounting jobAccounting
		err := windows.QueryInformationJobObject(g.job, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
		return err != nil || accounting.ActiveProcesses > 0 // not known: taken as left, so it is ended
	}
	event, err := windows.WaitForSingleObject(g.process, 0)
	return err == nil && event == uint32(windows.WAIT_TIMEOUT)
}

// jobAccounting is JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, which
// golang.org/x/sys/windows does not declare.
type jobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

// release lets go of the group's handles; what is still in its job ends
// with it.
func (g *processGroup) release() {
	if g.job != 0 {
		closeHandle(g.job)
		g.job = 0
	}
	if g.process != 0 {
		closeHandle(g.process)
		g.process = 0
	}
}

// processStart is when the process pid started, as the system keeps it:
// with the process id, what recognizes a program a runner launched before
// it stopped, whatever its name.
func processStart(_ context.Context, pid int) (string, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer closeHandle(process)
	return creationTime(process)
}

// creationTime is when a process started, to the 100 ns Windows keeps.
func creationTime(process windows.Handle) (string, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	return time.Unix(0, created.Nanoseconds()).UTC().Format(time.RFC3339Nano), nil
}

// setThreadExecutionState is kernel32's, which golang.org/x/sys/windows
// does not declare.
var setThreadExecutionState = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadExecutionState")

// keepAwake keeps the computer from idle sleep until done is called: a
// thread of its own asks the system to stay in the working state, which
// holds while that thread says so (SetThreadExecutionState); a closed lid
// or the power button still sleeps. The caller calls done once the
// program ended.
func keepAwake(context.Context, int) (done func()) {
	const continuous, systemRequired = 0x80000000, 0x00000001
	if setThreadExecutionState.Find() != nil {
		return func() {}
	}
	release, ended := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(ended)
		runtime.LockOSThread() // the state is the thread's: this one holds it, then lets it go
		defer runtime.UnlockOSThread()
		if ok, _, _ := setThreadExecutionState.Call(continuous | systemRequired); ok == 0 {
			<-release
			return
		}
		<-release
		_, _, _ = setThreadExecutionState.Call(continuous) // back to what the system decides; nothing to do if refused
	}()
	return func() {
		close(release)
		<-ended
	}
}

// untilAskedToStop is ctx, ended when the runner is asked to stop: by
// Ctrl-C or Ctrl-Break in its console, by its console closing, or by the
// guard that started it (its stop event, guard_windows.go), which is how
// the desktop app asks, with or without a console.
func untilAskedToStop(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, stopSignals := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	ctx, stopHeeding := heedStopRequests(ctx)
	return ctx, func() {
		stopHeeding()
		stopSignals()
	}
}

// replaceFile renames from over to, which may exist, through to the disk.
// A reader that has to open (Go opens files without letting them be
// renamed over meanwhile) holds it back a moment: it is tried again for a
// while.
func replaceFile(from, to string) error {
	src, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	dst, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := windows.MoveFileEx(src, dst, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		busy := errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_SHARING_VIOLATION)
		if !busy || time.Now().After(deadline) {
			if err != nil {
				return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
			}
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// readWhole reads a file that writeWhole writes, opened so that it can be
// replaced meanwhile (the read keeps what it opened). A file being
// replaced at that moment cannot be opened for an instant: it is tried
// again for a while.
func readWhole(path string) ([]byte, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
			windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			f := os.NewFile(uintptr(h), path)
			defer f.Close()
			return io.ReadAll(f)
		}
		if !errors.Is(err, windows.ERROR_ACCESS_DENIED) && !errors.Is(err, windows.ERROR_SHARING_VIOLATION) || time.Now().After(deadline) {
			return nil, &os.PathError{Op: "open", Path: path, Err: err}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// syncDir does nothing on Windows, which has no flush of a folder's
// entries: a rename is written through to the disk (replaceFile), and a
// removal lost to a power loss comes back as what the crash boundaries
// already take (a sent write sent again under its id, a journal beside
// its outcome).
func syncDir(string) error { return nil }

// closeHandle lets a handle go; one that cannot be closed has nothing more
// to give.
func closeHandle(h windows.Handle) { _ = windows.CloseHandle(h) }
