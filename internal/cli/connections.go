// The index of connections (index.json, beside the login files): the
// workspaces each tool works in, one login file each, and the folders
// tied to a workspace. A tool with no connection in it has its one login
// file, used as it always was.

package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// connectionIndex is index.json. It holds no token: those stay in the
// login files it names.
type connectionIndex struct {
	Connections []connection `json:"connections"`
	Folders     []folderTie  `json:"folders"`
}

// connection is one tool's login in one workspace. Tool is the tool's
// base login file (what its QUADIT_CONFIG names, or the default file),
// Login the file this connection's token is in. The identity is what the
// login's own GET /me said when it was registered.
type connection struct {
	Tool          string `json:"tool"`
	Login         string `json:"login"`
	Server        string `json:"server"`
	WorkspaceID   string `json:"workspace_id"`
	Workspace     string `json:"workspace"`
	WorkspaceName string `json:"workspace_name"`
	AgentID       string `json:"agent_id"`
	Agent         string `json:"agent"`
}

// folderTie ties a folder (absolute, links resolved) and everything under
// it to a workspace, and optionally to one of its projects (a key). It
// names the workspace, not a login: one tie serves every tool connected
// there.
type folderTie struct {
	Folder      string `json:"folder"`
	WorkspaceID string `json:"workspace_id"`
	Project     string `json:"project,omitempty"`
}

// indexFile is the index beside the login files in dir.
func indexFile(dir string) string { return filepath.Join(dir, "index.json") }

// readIndex reads the index in dir; none yet is an empty one.
func readIndex(dir string) (connectionIndex, error) {
	raw, err := os.ReadFile(indexFile(dir))
	if errors.Is(err, os.ErrNotExist) {
		return connectionIndex{}, nil
	}
	if err != nil {
		return connectionIndex{}, err
	}
	var idx connectionIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return connectionIndex{}, fmt.Errorf("%s: %w", indexFile(dir), err)
	}
	return idx, nil
}

// write writes the index in dir whole, private to the person running the
// command. Two commands writing at once is not guarded against: the index
// changes only when a person adds, removes or ties a connection.
func (idx connectionIndex) write(dir string) error {
	return writePrivate(indexFile(dir), plainJSON(idx))
}

// toolOf is the tool a login file belongs to: the tool of the connection
// whose file it is, or else the file itself, a tool's base login (a run's
// QUADIT_CONFIG names a connection's own file).
func (idx connectionIndex) toolOf(login string) string {
	for _, c := range idx.Connections {
		if samePath(c.Login, login) {
			return c.Tool
		}
	}
	return login
}

// of are the connections of a tool, by its base login file.
func (idx connectionIndex) of(tool string) []connection {
	var out []connection
	for _, c := range idx.Connections {
		if samePath(c.Tool, tool) {
			out = append(out, c)
		}
	}
	return out
}

// tieAt is the tie in effect in dir (absolute, links resolved): that of
// dir itself, or of the nearest folder above it that has one.
func (idx connectionIndex) tieAt(dir string) (folderTie, bool) {
	for {
		if i := slices.IndexFunc(idx.Folders, func(f folderTie) bool { return samePath(f.Folder, dir) }); i >= 0 {
			return idx.Folders[i], true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return folderTie{}, false
		}
		dir = parent
	}
}

// workspaceName is how a workspace is named in what the command says: its
// name as some connection of any tool knows it, else its id.
func (idx connectionIndex) workspaceName(workspaceID string) string {
	for _, c := range idx.Connections {
		if c.WorkspaceID == workspaceID && c.WorkspaceName != "" {
			return c.WorkspaceName
		}
	}
	return workspaceID
}

// foldsCase is whether this system's usual file systems take a name in
// any case as the same name: macOS's and Windows'.
var foldsCase = runtime.GOOS == "darwin" || runtime.GOOS == "windows"

// samePath reports whether two absolute paths name the same file by their
// spelling, cleaned, in any case where the system takes them so.
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if foldsCase {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// realFolder is a folder as ties are compared: absolute, its links
// resolved, in the plain form of a Windows path.
func realFolder(path string) (string, error) {
	abs, err := filepath.Abs(plainPath(path))
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// workspaceRef is a workspace as GET /me names it.
type workspaceRef struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// named reports whether what a person or a printed line gave names this
// workspace: its id, or its slug or name in any case.
func (w workspaceRef) named(name string) bool {
	return name != "" && (name == w.ID || strings.EqualFold(name, w.Slug) || strings.EqualFold(name, w.Name))
}

// ref is the connection's workspace.
func (c connection) ref() workspaceRef {
	return workspaceRef{ID: c.WorkspaceID, Slug: c.Workspace, Name: c.WorkspaceName}
}
