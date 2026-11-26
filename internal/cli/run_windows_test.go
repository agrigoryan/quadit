//go:build windows

package cli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/agrigoryan/quadit/internal/fakeagent"
)

// What the runner's tests ask of the system on Windows.

// programOutlivesRunner: a program whose runner is killed ends with it:
// its job ends when the runner's handle of it closes.
const programOutlivesRunner = false

// alive reports whether a process lives.
func alive(pid int) bool {
	process, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer closeHandle(process)
	event, err := windows.WaitForSingleObject(process, 0)
	return err == nil && event == uint32(windows.WAIT_TIMEOUT)
}

// groupLeft reports whether anything of the group of the program pid is
// left that a test can see: the program itself (its job is the runner's,
// and each grandchild a test starts is checked by its own pid).
func groupLeft(pid int) bool { return alive(pid) }

// killLeft kills what a failed test left.
func killLeft(pid int) {
	process, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return
	}
	defer closeHandle(process)
	_ = windows.TerminateProcess(process, 1) // one already gone has nothing to end
}

// askThisRunnerToStop asks the runner of this process to stop as the
// desktop app's guard does: its stop event.
func askThisRunnerToStop() error {
	if !askToStop(os.Getpid()) {
		return os.ErrNotExist
	}
	return nil
}

// refuseWritesIn makes dir refuse new files, and the removal and
// replacement of those in it, until allow is called, as a folder of mode
// 0500 does: entries of its access list deny everyone adding a file or a
// folder or removing one there, and removing any file it holds.
func refuseWritesIn(t *testing.T, dir string) (allow func()) {
	t.Helper()
	const addFile, addFolder, deleteChild = 0x2, 0x4, 0x40 // FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD
	return deny(t, dir,
		denial(addFile|addFolder|deleteChild, windows.NO_INHERITANCE),
		denial(windows.DELETE, windows.SUB_OBJECTS_ONLY_INHERIT|windows.INHERIT_ONLY))
}

// makeUnreadable makes a file refuse to be read: an entry of its access
// list denies everyone reading it.
func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	deny(t, path, denial(windows.FILE_READ_DATA, windows.NO_INHERITANCE))
}

// denial is an entry of an access list denying everyone access, inherited
// as inheritance says.
func denial(access windows.ACCESS_MASK, inheritance uint32) windows.EXPLICIT_ACCESS {
	everyone, _ := windows.CreateWellKnownSid(windows.WinWorldSid) // a well-known SID is always made
	return windows.EXPLICIT_ACCESS{AccessPermissions: access, AccessMode: windows.DENY_ACCESS, Inheritance: inheritance,
		Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_WELL_KNOWN_GROUP, TrusteeValue: windows.TrusteeValueFromSID(everyone)}}
}

// deny adds entries to path's access list, until undo (or the test's end)
// puts the list back as it was (and with it what its files inherited).
func deny(t *testing.T, path string, entries ...windows.EXPLICIT_ACCESS) (undo func()) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	was, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	denied, err := windows.ACLFromEntries(entries, was)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, denied, nil); err != nil {
		t.Fatal(err)
	}
	undo = func() {
		_ = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, was, nil)
	}
	t.Cleanup(undo)
	return undo
}

// startAlone starts cmd outside any job of the runner's, as a program
// left by a runner that stopped would be, were its job not ended.
func startAlone(cmd *exec.Cmd) error { return cmd.Start() }

func TestAProgramIsAnExeOrACmdStartedThroughCmdExeWithEveryArgumentQuoted(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"claude.exe", "codex.cmd", "run.bat", "claude.ps1", "claude"} {
		_ = os.WriteFile(filepath.Join(dir, name), nil, 0o600)
	}
	t.Run("an .exe is started as it is", func(t *testing.T) {
		cmd, err := programCommand(t.Context(), filepath.Join(dir, "claude.exe"), []string{"-p", "two words"})
		if err != nil || cmd.Path != filepath.Join(dir, "claude.exe") || !slices.Equal(cmd.Args[1:], []string{"-p", "two words"}) || cmd.SysProcAttr != nil {
			t.Fatalf("%+v %v", cmd, err)
		}
	})
	t.Run("a .cmd goes through cmd.exe, every argument in double quotes", func(t *testing.T) {
		shim := filepath.Join(dir, "codex.cmd")
		cmd, err := programCommand(t.Context(), shim, []string{"exec", "a&b", `C:\out\`, ""})
		if err != nil {
			t.Fatal(err)
		}
		shell := filepath.Join(systemRoot(), "System32", "cmd.exe")
		want := `"` + shell + `" /d /v:off /s /c ""` + shim + `" "exec" "a&b" "C:\out\\" """`
		if cmd.Path != shell || cmd.SysProcAttr == nil || cmd.SysProcAttr.CmdLine != want {
			t.Fatalf("the line %q, want %q", cmd.SysProcAttr.CmdLine, want)
		}
	})
	t.Run("what cmd.exe reads even inside quotes is refused", func(t *testing.T) {
		for _, arg := range []string{"50%", `"`, "a\nb", "a\x00b"} {
			if _, err := programCommand(t.Context(), filepath.Join(dir, "run.bat"), []string{arg}); err == nil {
				t.Fatalf("%q was let through", arg)
			}
		}
	})
	t.Run("anything else is not a program", func(t *testing.T) {
		for _, path := range []string{filepath.Join(dir, "claude.ps1"), filepath.Join(dir, "claude"), dir} {
			if _, err := programCommand(t.Context(), path, nil); err == nil {
				t.Fatalf("%s taken as a program", path)
			}
		}
	})
}

func TestTwoOpensOfALockFileAreTwoHoldersAndItsTextStaysReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runner.lock")
	first, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := tryLock(first); err != nil {
		t.Fatal(err)
	}
	_, _ = first.WriteString("4123\n")
	if raw, err := os.ReadFile(path); err != nil || string(raw) != "4123\n" {
		t.Fatalf("the holder's text read as %q (%v)", raw, err)
	}
	second, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := tryLock(second); !errors.Is(err, errLocked) {
		t.Fatalf("a second open took the lock beside the first: %v", err)
	}
	first.Close()
	if err := tryLock(second); err != nil {
		t.Fatalf("the lock was not let go with its holder's file: %v", err)
	}
}

func TestAFolderIsOneWhateverItsSpelling(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	spellings := []string{strings.ToUpper(dir), strings.ToLower(dir), strings.ReplaceAll(dir, `\`, "/"), `\\?\` + dir}
	long, _ := windows.UTF16PtrFromString(dir)
	short := make([]uint16, windows.MAX_LONG_PATH)
	if n, err := windows.GetShortPathName(long, &short[0], uint32(len(short))); err == nil && n > 0 {
		spellings = append(spellings, windows.UTF16ToString(short[:n]))
	}
	want, err := fileIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range spellings {
		if got, err := fileIdentity(s); err != nil || got != want {
			t.Fatalf("%s is %q (%v), %s is %q", s, got, err, dir, want)
		}
	}
	if other, _ := fileIdentity(filepath.Dir(dir)); other == want {
		t.Fatal("a folder and the one above it have one identity")
	}
}

func TestAProgramsJobEndsWhatItStartedWhenLetGo(t *testing.T) {
	dir := t.TempDir()
	record := filepath.Join(dir, "record.jsonl")
	scripts := filepath.Join(dir, "scripts.json")
	writeJSON(t, scripts, [][]fakeagent.Step{{{Child: true}, {SleepMS: 60_000}}})
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), "FAKEAGENT=claude", "FAKEAGENT_SCRIPTS="+scripts, "FAKEAGENT_RECORD="+record)
	group, err := startInGroup(cmd)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = cmd.Wait() }() // reaped as it ends; the test looks at its pid
	child := 0
	for deadline := time.Now().Add(10 * time.Second); child == 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the program started no child")
		}
		for _, r := range fakeagent.Records(record) {
			child = max(child, r.Child)
		}
	}
	if !group.alive() {
		t.Fatal("a group with two processes reads as gone")
	}
	// What a runner that dies does: its handle of the job closes.
	group.release()
	for deadline := time.Now().Add(10 * time.Second); alive(cmd.Process.Pid) || alive(child); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the program or its child outlived its job")
		}
	}
}

func TestWindowsFoldersOutsideTheRulesAreRefused(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(dir, "home")
	project := filepath.Join(home, "devel", "game")
	_ = os.MkdirAll(project, 0o700)
	rules := folderRules{home: home, roots: systemRoots()}
	t.Run("another drive's top", func(t *testing.T) {
		drives, _ := windows.GetLogicalDrives()
		for i := range 26 {
			root := string(rune('A'+i)) + `:\`
			if drives&(1<<i) == 0 || strings.EqualFold(root, filepath.VolumeName(dir)+`\`) {
				continue
			}
			if st, err := os.Stat(root); err != nil || !st.IsDir() {
				continue
			}
			if _, _, err := rules.check(root); err == nil || err.Error() != root+" is a whole drive: pick the project's own folder" {
				t.Fatalf("check(%s) = %v", root, err)
			}
			return
		}
		t.Skip("this computer has one drive")
	})
	t.Run("where programs are installed", func(t *testing.T) {
		for _, name := range []string{"ProgramFiles", "ProgramData", "SystemRoot"} {
			if _, _, err := rules.check(os.Getenv(name)); err == nil || !strings.Contains(err.Error(), "is a system folder") {
				t.Fatalf("%%%s%%: %v", name, err)
			}
		}
	})
	t.Run("a path in its long form is the plain one", func(t *testing.T) {
		canon, label, err := (folderRules{home: home, roots: testRoots()}).check(`\\?\` + project)
		if err != nil || canon != project || label != `~\devel\game` {
			t.Fatalf("check = %s %s %v", canon, label, err)
		}
	})
	t.Run("a folder outside the home folder is labeled as it is", func(t *testing.T) {
		if label := (folderRules{home: home}).label(`D:\work\site`); label != `D:\work\site` {
			t.Fatalf("labeled %s", label)
		}
	})
}
