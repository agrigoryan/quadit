// The read commands: orient and find, made from an API address each.

package cli

import (
	"fmt"
	"net/url"
	"strings"
)

// Most of orient and find, and the reads of the other groups, are one
// address of the API printed as it answers. Those commands are made here
// from their address alone.

// readCommand makes a command that prints one address. A %s in the address
// stands for the command's first argument.
func readCommand(path string) func(*runner, input) error {
	return func(r *runner, in input) error {
		return r.printRead(address(path, in), nil)
	}
}

// readsWithFilters makes a command that prints one address, with the
// field=value arguments sent along as filters.
func readsWithFilters(path string) func(*runner, input) error {
	return func(r *runner, in input) error {
		return r.printRead(address(path, in), readFilters(in.f))
	}
}

// address fills the command's first argument into path, where path has a
// %s for it.
func address(path string, in input) string {
	if !strings.Contains(path, "%s") {
		return path
	}
	return fmt.Sprintf(path, url.PathEscape(in.pos[0]))
}

// me says who the login is, as the server says it; then, from a tool in
// several workspaces, the folder's tie that chose this one and the others
// it is in.
func (r *runner) me(input) error {
	if err := r.printRead("/me", nil); err != nil || r.json {
		return err
	}
	if tie := r.chosen.tie; tie != nil {
		project := ""
		if tie.Project != "" {
			project = ", project " + tie.Project
		}
		fmt.Fprintf(r.out, "This folder is tied to this workspace (%s%s): quadit commands in it work here.\n", tie.Folder, project)
	}
	conns := r.chosen.conns
	var others []string
	for _, c := range conns {
		if c.WorkspaceID != r.c.ws.ID {
			others = append(others, fmt.Sprintf("%s (%s in %s)", connectionRef(c, conns), c.Agent, c.WorkspaceName))
		}
	}
	if len(conns) > 1 && len(others) > 0 {
		fmt.Fprintf(r.out, "This tool is also connected to: %s. A command works there only when the person names it: --workspace=NAME.\n", strings.Join(others, ", "))
	}
	return nil
}

// search looks for the words given, all of them as one text.
func (r *runner) search(in input) error {
	q := readFilters(in.f)
	q.Set("q", strings.Join(in.pos, " "))
	return r.printRead("/search", q)
}
