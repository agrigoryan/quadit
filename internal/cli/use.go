// The use command: tying a folder to one of the workspaces a tool works
// in, so that the quadit commands run in it, by any tool, work there.

package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// useUsage is what use says to arguments it does not take.
const useUsage = "usage: quadit use [WORKSPACE [project=KEY]] [folder=PATH]  or  quadit use --clear [folder=PATH]"

// use ties a folder (folder=, else the one it runs in) to a workspace, and
// optionally to one of its projects: `quadit use acme project=WEB`. The
// folder must pass the rules a folder Quadit runs an agent in passes (not
// the home folder, nothing above it, no system folder). Alone it says the
// tie in effect and the tool's connections; --clear unties the folder of
// the tie in effect. A dry run says what it would tie or untie, and
// writes nothing.
func use(ctx context.Context, args []string, sw switches, stdout, stderr io.Writer) int {
	host, err := systemHost()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return useWith(ctx, host.rules(), args, sw, stdout, stderr)
}

// useWith is use with rules for the folders.
func useWith(ctx context.Context, rules folderRules, args []string, sw switches, stdout, stderr io.Writer) int {
	pos, fields := splitFields(args)
	untying := slices.Contains(pos, "--clear")
	pos = slices.DeleteFunc(pos, func(a string) bool { return a == "--clear" })
	for key, values := range fields {
		if (key != "folder" && key != "project") || len(values) > 1 || (untying && key == "project") {
			fmt.Fprintln(stderr, useUsage)
			return 2
		}
	}
	workspace := sw.workspace
	if len(pos) > 0 {
		workspace = pos[0]
	}
	if len(pos) > 1 || (untying && workspace != "") || (workspace == "" && len(fields["project"]) > 0) {
		fmt.Fprintln(stderr, useUsage)
		return 2
	}
	folder := firstValue(fields["folder"])
	if folder == "" {
		var err error
		if folder, err = os.Getwd(); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	base := configPath()
	dir := filepath.Dir(base)
	idx, err := readIndex(dir)
	if err == nil {
		switch {
		case untying:
			err = untie(idx, dir, rules, folder, sw.dry, stdout)
		case workspace == "":
			err = showTie(idx, base, rules, folder, stdout)
		default:
			err = tie(ctx, idx, base, rules, tieAsk{folder: folder, workspace: workspace, project: firstValue(fields["project"]), dry: sw.dry}, stdout)
		}
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// tieAsk is what use was asked to tie: the folder, the workspace named,
// the project (or ""), and whether it is a dry run.
type tieAsk struct {
	folder, workspace, project string
	dry                        bool
}

// tie ties the folder to the workspace named, of the tool's connections
// (or, for a tool with none, its one login's), with the project when given:
// one the tool's agent there may work in.
func tie(ctx context.Context, idx connectionIndex, base string, rules folderRules, ask tieAsk, stdout io.Writer) error {
	workspace, project := ask.workspace, ask.project
	canon, label, err := rules.check(ask.folder)
	if err != nil {
		return err
	}
	conns := idx.of(idx.toolOf(base))
	var c *Client
	switch matches := slices.DeleteFunc(slices.Clone(conns), func(o connection) bool { return !o.ref().named(workspace) }); {
	case len(conns) == 0:
		if c, err = fileClient(base); err != nil {
			return err
		}
		w, err := c.workspace(ctx)
		if err == nil && w.ID == "" {
			err = errNoWorkspaceID
		}
		if err != nil {
			return fmt.Errorf("cannot check which workspace this tool's login is in: %w", err)
		}
		if !w.named(workspace) {
			return fmt.Errorf("this tool works in %s only, not in %q", w.Name, workspace)
		}
	case len(matches) == 0:
		return notConnectedThere(workspace, false, conns)
	case len(matches) > 1:
		return fmt.Errorf("%q names %d workspaces this tool works in; name one by its id:\n%s", workspace, len(matches), connectionLines(matches, true))
	default:
		if c, err = connectionClient(matches[0]); err != nil {
			return err
		}
	}
	if project != "" {
		me, err := c.me(ctx)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(me.Projects, func(key string) bool { return strings.EqualFold(key, project) })
		if i < 0 {
			return fmt.Errorf("%s may not work in a project %s in %s: quadit me --workspace=%s lists its projects", me.Handle, project, c.ws.Name, c.ws.ID)
		}
		project = me.Projects[i]
	}
	idx.Folders = slices.DeleteFunc(idx.Folders, func(f folderTie) bool { return samePath(f.Folder, canon) })
	idx.Folders = append(idx.Folders, folderTie{Folder: canon, WorkspaceID: c.ws.ID, WorkspaceName: c.ws.Name, Project: project})
	if ask.dry {
		fmt.Fprint(stdout, "would be accepted: ")
	} else if err := idx.write(filepath.Dir(base)); err != nil {
		return err
	}
	of := ""
	if project != "" {
		of = ", project " + project
	}
	fmt.Fprintf(stdout, "Tied %s to %s%s: the quadit commands run in it, and in the folders inside it, work there.\n", label, c.ws.Name, of)
	return nil
}

// untie takes away the tie in effect in folder: its own, or that of the
// nearest folder above it with one; in a dry run it only says so.
func untie(idx connectionIndex, dir string, rules folderRules, folder string, dry bool, stdout io.Writer) error {
	here, err := realFolder(folder)
	if err != nil {
		return fmt.Errorf("%s: %w", rules.shown(folder), err)
	}
	tied, ok := idx.tieAt(here)
	if !ok {
		fmt.Fprintf(stdout, "%s is tied to no workspace.\n", rules.shown(here))
		return nil
	}
	idx.Folders = slices.DeleteFunc(idx.Folders, func(f folderTie) bool { return samePath(f.Folder, tied.Folder) })
	if dry {
		fmt.Fprint(stdout, "would be accepted: ")
	} else if err := idx.write(dir); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Untied %s from %s.\n", rules.shown(tied.Folder), idx.workspaceName(tied.WorkspaceID))
	return nil
}

// showTie says the tie in effect in folder and the tool's connections.
func showTie(idx connectionIndex, base string, rules folderRules, folder string, stdout io.Writer) error {
	here, err := realFolder(folder)
	if err != nil {
		return fmt.Errorf("%s: %w", rules.shown(folder), err)
	}
	if tied, ok := idx.tieAt(here); ok {
		project := ""
		if tied.Project != "" {
			project = ", project " + tied.Project
		}
		fmt.Fprintf(stdout, "%s is tied to %s%s.\n", rules.shown(tied.Folder), idx.workspaceName(tied.WorkspaceID), project)
	} else {
		fmt.Fprintf(stdout, "%s is tied to no workspace.\n", rules.shown(here))
	}
	conns := idx.of(idx.toolOf(base))
	if len(conns) == 0 {
		fmt.Fprintf(stdout, "This tool has one login (%s), which every folder uses.\n", base)
		return nil
	}
	fmt.Fprintf(stdout, "This tool works in:\n%s\n", connectionLines(conns, false))
	return nil
}
