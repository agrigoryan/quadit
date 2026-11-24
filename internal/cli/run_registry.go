// The registry of `quadit run` (runner.json): what this computer serves,
// one entry per agent and project, bound to its server, workspace, agent,
// project, folder and program by ids and paths; where the runner keeps its
// other files; and the rules a folder must pass to be run in.

package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// registry is runner.json.
type registry struct {
	Version int        `json:"version"`
	Machine machine    `json:"machine"`
	Entries []regEntry `json:"entries"`
}

// machine is this computer as the runner names it to servers: a random id
// made when the registry is first written, and a name a person reads.
type machine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// regEntry is one entry of the registry: an agent's login, a project, a
// folder and a program. It is bound by Server, WorkspaceID, AgentID,
// ProjectID, Folder (canonical) and ProgramPath; Workspace, Agent and
// Project are for display.
type regEntry struct {
	ID          string `json:"id"`
	Server      string `json:"server"`
	WorkspaceID string `json:"workspace_id"`
	Workspace   string `json:"workspace"`
	AgentID     string `json:"agent_id"`
	Agent       string `json:"agent"`
	Login       string `json:"login"`
	ProjectID   string `json:"project_id"`
	Project     string `json:"project"`
	Folder      string `json:"folder"`
	Program     string `json:"program"`
	ProgramPath string `json:"program_path"`
	// Mode is how the folder is used: "in_place", the one this version
	// knows (worktrees come later).
	Mode       string `json:"mode"`
	MaxMinutes int    `json:"max_minutes"` // the optional wall-clock cap of a run; 0: none
	Removing   bool   `json:"removing"`    // quadit run remove asked a serving runner to let it go
	AddedAt    string `json:"added_at"`
}

// modeInPlace runs the program in the registered folder itself.
const modeInPlace = "in_place"

// sameAgentAndProject reports whether two entries serve one agent's
// project: a computer has one entry for each.
func (e regEntry) sameAgentAndProject(o regEntry) bool {
	return e.Server == o.Server && e.WorkspaceID == o.WorkspaceID && e.AgentID == o.AgentID && e.ProjectID == o.ProjectID
}

// runFiles are where the runner keeps what it keeps: the registry, and in
// the folder runner/ beside it everything else.
type runFiles struct{ registry, dir string }

// runFilesFor gives the files of the registry at path, or of the default
// one, runner.json in the folder of the login files, when path is "".
func runFilesFor(path string) (runFiles, error) {
	if path == "" {
		path = filepath.Join(filepath.Dir(configPath()), "runner.json")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return runFiles{}, err
	}
	return runFiles{registry: abs, dir: filepath.Join(filepath.Dir(abs), "runner")}, nil
}

func (f runFiles) runnerLock() string   { return filepath.Join(f.dir, "runner.lock") }
func (f runFiles) registryLock() string { return filepath.Join(f.dir, "registry.lock") }
func (f runFiles) status() string       { return filepath.Join(f.dir, "status.json") }
func (f runFiles) runnerLog() string    { return filepath.Join(f.dir, "runner.log") }
func (f runFiles) runs() string         { return filepath.Join(f.dir, "runs") }
func (f runFiles) entry(id string) string {
	return filepath.Join(f.dir, "entries", id)
}

// folderLock is the lock of one folder: one run at a time works in it,
// whichever agent and entry it is of.
func (f runFiles) folderLock(folder string) string {
	return filepath.Join(f.dir, "locks", hashOf(folder)[:16]+".lock")
}

// readRegistry reads the registry; none yet is an empty one.
func readRegistry(path string) (registry, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return registry{Version: 1}, nil
	}
	if err != nil {
		return registry{}, err
	}
	var reg registry
	if err := json.Unmarshal(raw, &reg); err != nil {
		return registry{}, fmt.Errorf("%s: %w", path, err)
	}
	if reg.Version != 1 {
		return registry{}, fmt.Errorf("%s is of version %d, which this quadit does not know: update quadit", path, reg.Version)
	}
	return reg, nil
}

// changeRegistry changes the registry with change, holding the registry's
// lock from the read to the write, and writes it whole (a temporary file
// renamed over it): a reader sees the old registry or the new one. A
// registry written the first time gets this computer's machine.
func changeRegistry(ctx context.Context, files runFiles, change func(*registry) error) (registry, error) {
	if err := os.MkdirAll(files.dir, 0o700); err != nil {
		return registry{}, err
	}
	lock, err := os.OpenFile(files.registryLock(), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return registry{}, err
	}
	defer lock.Close() // closing it lets the lock go
	if err := waitLock(lock); err != nil {
		return registry{}, err
	}
	reg, err := readRegistry(files.registry)
	if err != nil {
		return registry{}, err
	}
	if reg.Machine.ID == "" {
		reg.Machine = machine{ID: randomHex(8), Name: machineName(ctx)}
	}
	if err := change(&reg); err != nil {
		return registry{}, err
	}
	return reg, writeWhole(files.registry, plainJSON(reg))
}

// writeWhole writes a file whole and durably: a temporary file in the same
// folder, flushed to the disk, renamed over the file. Mode 0600.
func writeWhole(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Chmod(0o600)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return syncDir(filepath.Dir(path))
}

// removeDurably removes a file and makes its removal durable; one already
// gone is removed.
func removeDurably(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Dir(path))
}

// syncDir flushes a folder's entries to the disk: the renames and
// removals the crash boundaries rely on survive a power loss.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// plainJSON is one of the runner's own values as indented JSON, as its
// files are written.
func plainJSON(v any) []byte {
	var buf bytes.Buffer
	_ = json.Indent(&buf, plainjson.Marshal(v), "", "  ") // what Marshal makes is JSON, which indents
	buf.WriteByte('\n')
	return buf.Bytes()
}

// hashOf is the SHA-256 of s in hex.
func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// randomHex is n random bytes in lower-case hex.
func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never fails
	return hex.EncodeToString(b)
}

// machineName is this computer's name as a person reads it: on macOS the
// computer name of its sharing settings, else the host name without
// .local; at most 64 characters, none of them control characters.
func machineName(ctx context.Context) string {
	name := ""
	if runtime.GOOS == "darwin" {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, "scutil", "--get", "ComputerName").Output(); err == nil {
			name = string(out)
		}
	}
	if strings.TrimSpace(name) == "" {
		host, _ := os.Hostname() // no host name: the fallback below
		name = strings.TrimSuffix(host, ".local")
	}
	return cleanMachineName(name)
}

// cleanMachineName is name in the form a server takes: trimmed, no control
// characters, 1 to 64 characters.
func cleanMachineName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	if utf8.RuneCountInString(name) > 64 {
		name = strings.TrimSpace(string([]rune(name)[:64]))
	}
	if name == "" {
		name = "this computer"
	}
	return name
}

// folderRules are the rules a folder must pass for a program to run in it
// with full access: not the home folder nor above it, nothing at or under
// a system folder.
type folderRules struct {
	home  string   // the person's home folder
	roots []string // the system folders
}

// systemRoots are the folders a program is never run in, nor anywhere
// under them.
var systemRoots = []string{"/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/var", "/private",
	"/opt", "/tmp", "/dev", "/proc", "/sys", "/boot", "/lib", "/lib64", "/snap", "/nix", "/root", "/cores"}

// check gives the canonical form of path (absolute, links resolved) and
// its label for servers (the home folder written ~), or refuses it in the
// words a person reads.
func (rules folderRules) check(path string) (canon, label string, err error) {
	if !filepath.IsAbs(path) {
		return "", "", errors.New("folder= must be an absolute path")
	}
	path = filepath.Clean(path)
	shown := rules.shown(path)
	canon, err = filepath.EvalSymlinks(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", "", fmt.Errorf("%s does not exist", shown)
		}
		return "", "", fmt.Errorf("%s: %w", shown, err)
	}
	if st, err := os.Stat(canon); err != nil || !st.IsDir() {
		return "", "", fmt.Errorf("%s is not a folder", shown)
	}
	home := resolved(rules.home)
	switch {
	case canon == home:
		return "", "", fmt.Errorf("%s is your home folder: pick the project's own folder", shown)
	case canon == "/" || strings.HasPrefix(home, canon+"/"):
		return "", "", fmt.Errorf("%s is above your home folder: pick the project's own folder", shown)
	}
	for _, root := range rules.roots {
		for _, r := range []string{root, resolved(root)} {
			if canon == r || strings.HasPrefix(canon, r+"/") {
				return "", "", fmt.Errorf("%s is a system folder: pick the project's own folder", shown)
			}
		}
	}
	return canon, rules.label(canon), nil
}

// label is a canonical folder as servers see it: the home folder written ~.
func (rules folderRules) label(canon string) string {
	home := resolved(rules.home)
	if canon == home {
		return "~"
	}
	if rest, ok := strings.CutPrefix(canon, home+"/"); ok {
		return "~/" + rest
	}
	return canon
}

// shown is a path as a refusal says it: under the home folder, with ~.
func (rules folderRules) shown(path string) string {
	for _, home := range []string{filepath.Clean(rules.home), resolved(rules.home)} {
		if path == home {
			return "~"
		}
		if rest, ok := strings.CutPrefix(path, home+"/"); ok {
			return "~/" + rest
		}
	}
	return path
}

// resolved is path with its links resolved, or as it is when that fails.
func resolved(path string) string {
	if r, err := filepath.EvalSymlinks(path); err == nil {
		return r
	}
	return filepath.Clean(path)
}
