package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// useIn runs quadit use in the test's world, with the home folder home and
// no system folders.
func useIn(t *testing.T, home string, args ...string) (int, string) {
	t.Helper()
	sw, rest := takeSwitches(args)
	var out bytes.Buffer
	code := useWith(context.Background(), folderRules{home: home}, rest, sw, &out, &out)
	return code, out.String()
}

func TestUseTiesAFolderToAWorkspace(t *testing.T) {
	t.Run("the folder it runs in, to a workspace and a project of the tool's, in any case", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		code, said := useIn(t, w.dir, "Acme", "project=web")
		if code != 0 || said != "Tied "+w.work+" to Acme, project WEB: the quadit commands run in it, and in the folders inside it, work there.\n" {
			t.Fatalf("use: %d %s", code, said)
		}
		idx, _ := readIndex(w.dir)
		if len(idx.Folders) != 1 || idx.Folders[0] != (folderTie{Folder: w.work, WorkspaceID: acme.ID, Project: "WEB"}) {
			t.Fatalf("the ties are %+v", idx.Folders)
		}
		c, err := choose(t, workspaceAsk{})
		is(t, c, err, b)
	})
	t.Run("a dry run ties and unties nothing", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		if code, said := useIn(t, w.dir, "--dry-run", "acme"); code != 0 || !strings.HasPrefix(said, "would be accepted: Tied ") {
			t.Fatalf("use --dry-run: %d %s", code, said)
		}
		if idx, _ := readIndex(w.dir); len(idx.Folders) != 0 {
			t.Fatalf("a dry run tied %+v", idx.Folders)
		}
		useIn(t, w.dir, "acme")
		if code, said := useIn(t, w.dir, "--dry-run", "--clear"); code != 0 || !strings.HasPrefix(said, "would be accepted: Untied ") {
			t.Fatalf("use --dry-run --clear: %d %s", code, said)
		}
		if idx, _ := readIndex(w.dir); len(idx.Folders) != 1 {
			t.Fatal("a dry run untied the folder")
		}
	})
	t.Run("tied again, the folder's tie is replaced", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		useIn(t, w.dir, "acme")
		if code, said := useIn(t, w.dir, "--workspace=personal"); code != 0 {
			t.Fatal(said)
		}
		idx, _ := readIndex(w.dir)
		if len(idx.Folders) != 1 || idx.Folders[0].WorkspaceID != personal.ID {
			t.Fatalf("the ties are %+v", idx.Folders)
		}
	})
	t.Run("a project the agent may not work in, a workspace it is not in, and a home folder are refused", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		if code, said := useIn(t, w.dir, "acme", "project=OPS"); code != 1 || !strings.HasPrefix(said, "@claude may not work in a project OPS in Acme") {
			t.Fatalf("use: %d %s", code, said)
		}
		if code, said := useIn(t, w.dir, "client"); code != 1 || !strings.HasPrefix(said, `this tool is not connected to a workspace named "client"`) {
			t.Fatalf("use: %d %s", code, said)
		}
		if code, said := useIn(t, w.work, "acme"); code != 1 || !strings.Contains(said, "is your home folder") {
			t.Fatalf("use: %d %s", code, said)
		}
		if idx, _ := readIndex(w.dir); len(idx.Folders) != 0 {
			t.Fatalf("a refused tie was kept: %+v", idx.Folders)
		}
	})
	t.Run("a tool with one login ties a folder to its workspace, as its /me says", func(t *testing.T) {
		w := newToolWorld(t)
		w.login(w.base, newWorkspaceServer(t, personal, "qd_a"))
		if code, said := useIn(t, w.dir, "personal"); code != 0 {
			t.Fatal(said)
		}
		if code, said := useIn(t, w.dir, "acme"); code != 1 || said != "this tool works in Personal only, not in \"acme\"\n" {
			t.Fatalf("use: %d %s", code, said)
		}
	})
	t.Run("alone it says the tie in effect and the workspaces; --clear unties it from a folder inside", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		useIn(t, w.dir, "acme", "project=WEB")
		inside := filepath.Join(w.work, "src")
		if err := os.Mkdir(inside, 0o700); err != nil {
			t.Fatal(err)
		}
		code, said := useIn(t, w.dir, "folder="+inside)
		if code != 0 || !strings.HasPrefix(said, w.work+" is tied to Acme, project WEB.\nThis tool works in:\n  personal") {
			t.Fatalf("use: %d %s", code, said)
		}
		if code, said := useIn(t, w.dir, "--clear", "folder="+inside); code != 0 || said != "Untied "+w.work+" from Acme.\n" {
			t.Fatalf("use --clear: %d %s", code, said)
		}
		if code, said := useIn(t, w.dir); code != 0 || !strings.HasPrefix(said, w.work+" is tied to no workspace.\n") {
			t.Fatalf("use: %d %s", code, said)
		}
	})
}
