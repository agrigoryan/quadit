package cli

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
)

func TestTheRegistryRefusesAFolderOutsideTheRules(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(dir, "home")
	project := filepath.Join(home, "devel", "game")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(project, "README")
	_ = os.WriteFile(file, nil, 0o600)
	// The system's own folder and the top of the drive the home folder is on.
	system, root := "/usr/bin", "/"
	if runtime.GOOS == "windows" {
		system, root = filepath.Join(cmp.Or(os.Getenv("SystemRoot"), `C:\Windows`), "System32"), filepath.VolumeName(dir)+`\`
	}
	strict := folderRules{home: home, roots: systemRoots()} // the computer's own system folders
	lenient := folderRules{home: home, roots: testRoots()}
	// A link is made in its own case, so a computer that makes none skips
	// that case alone.
	for _, c := range []struct {
		name, path string
		link       string // the path is a link to this, made first
		rules      folderRules
		want       string
	}{
		{"a relative path", filepath.FromSlash("devel/game"), "", lenient, "folder= must be an absolute path"},
		{"a folder that does not exist", filepath.Join(home, "nope"), "", lenient, filepath.FromSlash("~/nope does not exist")},
		{"a file", file, "", lenient, filepath.FromSlash("~/devel/game/README is not a folder")},
		{"the home folder", home, "", lenient, "~ is your home folder: pick the project's own folder"},
		{"a link to the home folder", filepath.Join(dir, "to-home"), home, lenient, "is your home folder"},
		{"above the home folder", dir, "", lenient, dir + " is above your home folder: pick the project's own folder"},
		{"the root", root, "", lenient, root + " is above your home folder"},
		{"a system folder", system, "", strict, system + " is a system folder: pick the project's own folder"},
		{"a link to a system folder", filepath.Join(project, "to-system"), system, lenient, filepath.FromSlash("~/devel/game/to-system is a system folder")},
	} {
		t.Run(c.name, func(t *testing.T) {
			if c.link != "" {
				symlink(t, c.link, c.path)
			}
			_, _, err := c.rules.check(c.path)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("check(%s) = %v, want %q", c.path, err, c.want)
			}
		})
	}
	if runtime.GOOS == "darwin" {
		t.Run("/tmp, which is under /private on macOS", func(t *testing.T) {
			if _, _, err := (folderRules{home: home, roots: []string{"/tmp"}}).check("/tmp"); err == nil || !strings.Contains(err.Error(), "system folder") {
				t.Fatalf("check(/tmp) = %v", err)
			}
		})
	}
	t.Run("the project's own folder, labeled with ~", func(t *testing.T) {
		canon, label, err := lenient.check(project)
		if err != nil || canon != project || label != filepath.FromSlash("~/devel/game") {
			t.Fatalf("check = %s %s %v", canon, label, err)
		}
	})
}

// add runs quadit run add in the test's world.
func (rt *runTest) add(args ...string) (int, string) {
	var out bytes.Buffer
	fields := map[string][]string{}
	for _, a := range args {
		k, v, _ := strings.Cut(a, "=")
		fields[k] = append(fields[k], v)
	}
	code := runAdd(context.Background(), rt.files, rt.host(), fields, false, &out, &out)
	return code, strings.TrimSpace(out.String())
}

func TestTheRegistryBindsAnEntryByIDs(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	rt.writeRegistry()
	link := filepath.Join(rt.dir, "game-link")
	symlink(t, rt.folder, link)
	program := filepath.Join(rt.dir, "bin", "claude"+filepath.Ext(rt.entry.ProgramPath))
	_ = os.MkdirAll(filepath.Dir(program), 0o700)
	symlink(t, rt.entry.ProgramPath, program)
	code, said := rt.add("login="+rt.login, "project=sva", "folder="+link, "program=claude", "program_path="+program)
	if code != 0 || said != "Added: @claude runs SVA in "+filepath.FromSlash("~/devel/game")+" with Claude Code 2.1.331 on Test Mac." {
		t.Fatalf("add: %d %s", code, said)
	}
	reg, err := readRegistry(rt.files.registry)
	if err != nil || len(reg.Entries) != 1 {
		t.Fatalf("registry %+v %v", reg, err)
	}
	e := reg.Entries[0]
	if e.Server != rt.url || e.WorkspaceID != fakeWorkspaceID || e.AgentID != fakeAgentID || e.ProjectID != fakeProjectID || e.Folder != rt.folder ||
		e.ProgramPath != program || e.Login != rt.login || e.Mode != modeInPlace || len(e.ID) != 8 {
		t.Fatalf("the entry is not bound by ids, the canonical folder and the program as given: %+v", e)
	}
	if st, _ := os.Stat(rt.files.registry); runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 { // Windows keeps no such mode
		t.Fatalf("the registry's mode is %v", st.Mode())
	}
}

// TestAddingAnEntryTiesItsFolderToItsWorkspace: the quadit commands a
// person runs in a folder Quadit runs an agent in work in the entry's
// workspace; a folder tied to another is refused, and nothing is added.
func TestAddingAnEntryTiesItsFolderToItsWorkspace(t *testing.T) {
	t.Run("an untied folder is tied, with the entry's project", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude)
		rt.writeRegistry()
		if code, said := rt.add("login="+rt.login, "project=SVA", "folder="+rt.folder, "program=claude", "program_path="+rt.entry.ProgramPath); code != 0 {
			t.Fatal(said)
		}
		idx, err := readIndex(filepath.Dir(rt.login))
		if err != nil || len(idx.Folders) != 1 || idx.Folders[0] != (folderTie{Folder: rt.folder, WorkspaceID: fakeWorkspaceID, Project: "SVA"}) {
			t.Fatalf("the ties are %+v (%v)", idx.Folders, err)
		}
	})
	t.Run("a folder tied to another workspace is refused", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude)
		rt.writeRegistry()
		idx := connectionIndex{Folders: []folderTie{{Folder: filepath.Dir(rt.folder), WorkspaceID: acme.ID}}}
		if err := idx.write(filepath.Dir(rt.login)); err != nil {
			t.Fatal(err)
		}
		code, said := rt.add("login="+rt.login, "project=SVA", "folder="+rt.folder, "program=claude", "program_path="+rt.entry.ProgramPath)
		if code != 1 || !strings.HasPrefix(said, filepath.FromSlash("~/devel/game")+" is tied to "+acme.ID+", not Personal: untie it first") {
			t.Fatalf("add: %d %s", code, said)
		}
		if reg, _ := readRegistry(rt.files.registry); len(reg.Entries) != 0 {
			t.Fatalf("added %+v", reg.Entries)
		}
	})
}

// TestRemovingByWorkspaceKeepsTheOthers: run remove login=… workspace=ID
// removes only that workspace's entries of the login.
func TestRemovingByWorkspaceKeepsTheOthers(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	other := rt.entry
	other.ID, other.WorkspaceID, other.ProjectID = "0000bbbb", acme.ID, "0199aaaa-0000-7000-8000-0000000000ac"
	other.Folder = filepath.Join(rt.home, "devel", "site")
	_ = os.MkdirAll(other.Folder, 0o700)
	rt.writeRegistry(rt.entry, other)
	var out bytes.Buffer
	if code := runRemove(context.Background(), rt.files, rt.host(), nil, map[string][]string{"login": {rt.login}, "workspace": {fakeWorkspaceID}}, &out, &out); code != 0 {
		t.Fatalf("remove: %s", out.String())
	}
	reg, _ := readRegistry(rt.files.registry)
	if len(reg.Entries) != 1 || reg.Entries[0].ID != other.ID || reg.Entries[0].Removing {
		t.Fatalf("the registry holds %+v", reg.Entries)
	}
}

func TestALoginOfAnotherWorkspaceOrReadOnlyIsAnEntryError(t *testing.T) {
	t.Run("add refuses a read-only login and a person's", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude)
		rt.writeRegistry()
		rt.f.set(func(f *fakeQuadit) { m := f.members[agentToken]; m.ReadOnly = true; f.members[agentToken] = m })
		if code, said := rt.add("login="+rt.login, "project=SVA", "folder="+rt.folder, "program=claude", "program_path="+rt.entry.ProgramPath); code != 1 ||
			said != "this login may only read: Quadit runs an agent whose login may write" {
			t.Fatalf("add: %d %s", code, said)
		}
		writeJSON(t, rt.login, map[string]string{"url": rt.url, "token": "owner-token"})
		if code, said := rt.add("login="+rt.login, "project=SVA", "folder="+rt.folder, "program=claude", "program_path="+rt.entry.ProgramPath); code != 1 ||
			said != "this login is @aram's, a person's: Quadit runs an agent with the agent's own login" {
			t.Fatalf("add: %d %s", code, said)
		}
	})
	t.Run("an entry whose login is of another workspace is not served", func(t *testing.T) {
		rt := newRunTest(t, core.ProgramClaude)
		other := rt.entry
		other.WorkspaceID = "0199aaaa-0000-7000-8000-00000000ffff"
		rt.writeRegistry(other)
		rt.f.addItem(fakeItem{Task: "SVA-1"})
		rt.serve()
		rt.eventually("the entry's error", func() bool {
			return readStatus(rt.files.status()).Entries[other.ID].Message == string(errLoginRefused)
		})
		if len(rt.f.holdList()) != 0 || len(rt.records()) != 0 {
			t.Fatal("an entry whose login is not its own held the listener or ran the program")
		}
	})
}

func TestTheRegistryHoldsOneProjectPerFolderAndOneEntryPerAgentAndProject(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	add := func() (int, string) {
		return rt.add("login="+rt.login, "project=SVA", "folder="+rt.folder, "program=claude", "program_path="+rt.entry.ProgramPath)
	}
	if code, said := add(); code != 1 || said != "@claude already runs SVA on this computer, in "+filepath.FromSlash("~/devel/game") {
		t.Fatalf("a second entry of the agent and project: %d %s", code, said)
	}
	other := rt.entry
	other.ID, other.ProjectID, other.Project, other.AgentID = "0000aaaa", "0199aaaa-0000-7000-8000-0000000000ab", "GS", fakeCodexID
	rt.writeRegistry(other)
	if code, said := add(); code != 1 || said != filepath.FromSlash("~/devel/game")+" already runs GS on this computer: one project per folder" {
		t.Fatalf("a second project in the folder: %d %s", code, said)
	}
	other.ProjectID, other.Project = fakeProjectID, "SVA" // another agent on the same project and folder is allowed
	rt.writeRegistry(other)
	if code, said := add(); code != 0 {
		t.Fatalf("a second agent on the project: %d %s", code, said)
	}
}

func TestTheRegistryIsWrittenWhole(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	rt.writeRegistry()
	stop := make(chan struct{})
	var readers sync.WaitGroup
	torn := make(chan string, 1)
	readers.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			raw, err := readWhole(rt.files.registry) // as quadit run and its forms read it
			if err == nil && !json.Valid(raw) {
				select {
				case torn <- string(raw):
				default:
				}
			}
		}
	})
	var writers sync.WaitGroup
	for i := range 20 {
		writers.Go(func() {
			_, err := changeRegistry(context.Background(), rt.files, func(reg *registry) error {
				reg.Entries = append(reg.Entries, regEntry{ID: fmt.Sprintf("%08d", i)})
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		})
	}
	writers.Wait()
	close(stop)
	readers.Wait()
	select {
	case raw := <-torn:
		t.Fatalf("a reader saw a registry half written: %q", raw)
	default:
	}
	reg, err := readRegistry(rt.files.registry)
	if err != nil || len(reg.Entries) != 20 || reg.Machine.ID != testMachine.ID {
		t.Fatalf("after twenty writers the registry holds %d entries (%v), machine %+v", len(reg.Entries), err, reg.Machine)
	}
}

func TestTheFolderLockFollowsTheFoldersIdentity(t *testing.T) {
	rt := newRunTest(t, core.ProgramClaude)
	link := filepath.Join(rt.dir, "game-link")
	symlink(t, rt.folder, link)
	srv := newServing(rt.files, rt.host(), testMachine, &syncBuffer{}, "")
	lock, err := srv.takeFolder(rt.folder, "@claude")
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	spellings := []string{link, rt.folder + "/."}
	if upper := strings.ToUpper(rt.folder); upper != rt.folder {
		if st, err := os.Stat(upper); err == nil && st.IsDir() { // a volume that does not tell case apart
			spellings = append(spellings, upper)
		}
	}
	for _, other := range spellings {
		if f, err := srv.takeFolder(other, "@codex"); !errors.Is(err, errLocked) {
			if f != nil {
				f.Close()
			}
			t.Fatalf("%s took the folder's lock beside %s (%v)", other, rt.folder, err)
		}
	}
}

func TestAFolderSpelledOtherwiseIsStillRefused(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(dir, "home")
	_ = os.MkdirAll(home, 0o700)
	if st, err := os.Stat(strings.ToUpper(home)); err != nil || !st.IsDir() {
		t.Skip("this volume tells case apart: no other spelling names the same folder")
	}
	system := "/Library"
	if runtime.GOOS == "windows" {
		system = cmp.Or(os.Getenv("SystemRoot"), `C:\Windows`)
	}
	rules := folderRules{home: home, roots: append(testRoots(), system)}
	for _, path := range []string{strings.ToUpper(home), strings.ToUpper(dir), strings.ToUpper(system)} {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if _, _, err := rules.check(path); err == nil {
			t.Fatalf("%s passed the folder rules", path)
		}
	}
}

// symlink makes a link, or skips the test where this computer gives no
// right to make one (Windows, for one not an administrator and without
// Developer Mode).
func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("this computer makes no symbolic links for this test: %v", err)
		}
		t.Fatal(err)
	}
}
