// The login commands: saving the server's address and a token (login),
// and taking one away (logout). A tool's first login is its own file, as
// it always was; a login in another workspace is a file of its own beside
// it, and both are then connections in the index (connections.go).

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// login checks a server address and a token by asking who they are, and
// saves them where the tool's commands find them (saveLogin). A token of
// "-" is read from stdin, so that it is not in the list of running
// processes. "login --path" prints where the tool's login is kept. "--app
// PATH" is for the desktop app, making a login for the server it runs:
// PATH is its executable, which the command starts when that server is not
// running (appstart.go). A login without it has no such mark, even where
// the one before had.
func login(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "--path" {
		fmt.Fprintln(stdout, configPath())
		return 0
	}
	var app *appLogin
	if len(args) == 4 && args[2] == "--app" {
		app, args = &appLogin{Path: args[3]}, args[:2]
	}
	if len(args) != 2 {
		fmt.Fprintln(stderr, "usage: quadit login URL TOKEN|- [--app PATH]  or  quadit login --path")
		return 2
	}
	token := args[1]
	if token == "-" {
		raw, err := io.ReadAll(stdin)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		token = strings.TrimSpace(string(raw))
		if token == "" {
			fmt.Fprintln(stderr, "no token on standard input")
			return 2
		}
	}
	c := &Client{URL: strings.TrimRight(args[0], "/"), Token: token, HTTP: &http.Client{Timeout: requestTimeout}}
	me, err := c.Text(ctx, "/me", nil)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path, more, err := saveLogin(ctx, c, app)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "saved to %s\n%s", path, me)
	if more != "" {
		fmt.Fprintln(stdout, more)
	}
	return 0
}

// saveLogin saves the login c signs in with, and gives the file it went to
// and, when the tool now works in several workspaces, what to say of it.
//
// A tool with no connections has one file, its base login: it is written
// there when it is empty, or holds this login or another of the same
// workspace (by its id, whatever address its server was reached at). When it holds a login in another workspace, that login's own
// GET /me says which (when it cannot be asked, nothing is changed), it
// becomes the tool's first connection, and this one its second, in a file
// of its own beside it. A tool with connections replaces the token of the
// one in this login's workspace, or adds one.
func saveLogin(ctx context.Context, c *Client, app *appLogin) (path, more string, err error) {
	base := configPath()
	dir := filepath.Dir(base)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	idx, err := readIndex(dir)
	if err != nil {
		return "", "", err
	}
	tool := idx.toolOf(base)
	raw, _ := json.MarshalIndent(savedConfig{URL: c.URL, Token: c.Token, App: app}, "", "  ")
	if len(idx.of(tool)) == 0 {
		old, err := fileClient(tool)
		switch {
		case errors.Is(err, errNotConnected) || err == nil && old.URL == c.URL && old.Token == c.Token:
			// No login there, or this one again: written as it always was.
			return tool, "", writePrivate(tool, raw)
		case err != nil:
			return "", "", fmt.Errorf("this tool's login cannot be read, so nothing was changed: %w\n  when it is a login no longer used, remove the file and log in again", err)
		}
		was, err := old.me(ctx)
		if err == nil && was.Workspace.ID == "" {
			err = errNoWorkspaceID
		}
		if err != nil {
			return "", "", fmt.Errorf("this tool's login (%s) could not be asked which workspace it is in, so nothing was changed: %w\n  when it is a login no longer used, quadit logout removes it", tool, err)
		}
		now, err := c.me(ctx)
		if err == nil && now.Workspace.ID == "" {
			err = errNoWorkspaceID
		}
		if err != nil {
			return "", "", err
		}
		if was.Workspace.ID == now.Workspace.ID {
			return tool, "", writePrivate(tool, raw)
		}
		idx.Connections = append(idx.Connections, connectionOf(tool, tool, old.URL, was))
	}
	now, err := c.me(ctx)
	if err == nil && now.Workspace.ID == "" {
		err = errNoWorkspaceID
	}
	if err != nil {
		return "", "", err
	}
	conns := idx.of(tool)
	i := slices.IndexFunc(idx.Connections, func(o connection) bool {
		return samePath(o.Tool, tool) && o.WorkspaceID == now.Workspace.ID
	})
	if i >= 0 {
		path = idx.Connections[i].Login
		idx.Connections[i] = connectionOf(tool, path, c.URL, now)
	} else {
		path = newLoginFile(tool, now.Workspace.Slug, idx)
		idx.Connections = append(idx.Connections, connectionOf(tool, path, c.URL, now))
		conns = append(conns, idx.Connections[len(idx.Connections)-1])
	}
	if err := writePrivate(path, raw); err != nil {
		return "", "", err
	}
	if err := idx.write(dir); err != nil {
		return "", "", err
	}
	if len(conns) < 2 {
		return path, "", nil
	}
	return path, fmt.Sprintf("This tool now works in %d workspaces:\n%s\nA command in a folder tied to none names one (--workspace=NAME); quadit use NAME ties the folder it runs in.",
		len(conns), connectionLines(conns, false)), nil
}

// connectionOf is the connection of a login, as its GET /me said.
func connectionOf(tool, login, server string, me whoAmI) connection {
	return connection{Tool: tool, Login: login, Server: server, WorkspaceID: me.Workspace.ID, Workspace: me.Workspace.Slug,
		WorkspaceName: me.Workspace.Name, AgentID: me.UserID, Agent: me.Handle}
}

// slugForm is a workspace's slug as it can go into a file's name.
var slugForm = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// newLoginFile is where a tool's login in another workspace goes: beside
// its base login, named after it and the workspace (claude-acme.json), with
// -2, -3… when that name is taken.
func newLoginFile(tool, slug string, idx connectionIndex) string {
	if !slugForm.MatchString(slug) {
		slug = "workspace"
	}
	stem := strings.TrimSuffix(tool, filepath.Ext(tool)) + "-" + slug
	for n := 1; ; n++ {
		path := stem + ".json"
		if n > 1 {
			path = fmt.Sprintf("%s-%d.json", stem, n)
		}
		_, err := os.Lstat(path)
		taken := slices.ContainsFunc(idx.Connections, func(c connection) bool { return samePath(c.Login, path) })
		if errors.Is(err, os.ErrNotExist) && !taken {
			return path
		}
	}
}

// logout takes away the tool's login in a workspace: with --revoke=ID it
// first revokes that token with the login itself (a revocation that fails
// changes nothing), then removes its file and its connection. Folder ties
// stay: they name a workspace, which other tools may still work in, and
// in a folder tied to a workspace a tool is not connected to its commands
// are refused (quadit use --clear unties it). The login is the workspace
// named, or the tool's only one, never the folder's. A dry run says what
// would be taken away, and takes nothing.
func logout(ctx context.Context, args []string, named string, dry bool, stdout, stderr io.Writer) int {
	revoke := ""
	for _, a := range args {
		v, ok := strings.CutPrefix(a, "--revoke=")
		if !ok || !pageForm.MatchString(v) {
			fmt.Fprintln(stderr, "usage: quadit logout [--workspace=W] [--revoke=TOKEN_ID]")
			return 2
		}
		revoke = v
	}
	if err := logoutWith(ctx, named, revoke, dry, stdout); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// logoutWith is logout, once its arguments are read.
func logoutWith(ctx context.Context, named, revoke string, dry bool, stdout io.Writer) error {
	base := configPath()
	dir := filepath.Dir(base)
	idx, err := readIndex(dir)
	if err != nil {
		return err
	}
	conns := idx.of(idx.toolOf(base))
	var conn *connection
	var c *Client
	switch {
	case len(conns) == 0:
		c, err = fileClient(base)
		if errors.Is(err, errNotConnected) {
			fmt.Fprintln(stdout, "This tool has no login to take away.")
			return nil
		}
		if err != nil {
			return err
		}
		if named != "" {
			w, err := c.workspace(ctx)
			if err != nil {
				return fmt.Errorf("cannot check which workspace this tool's login is in (%w): quadit logout without --workspace takes it away", err)
			}
			if !w.named(named) {
				return fmt.Errorf("this tool works in %s only, not in %q", w.Name, named)
			}
		}
	case named != "":
		var matches []connection
		for _, o := range conns {
			if o.ref().named(named) {
				matches = append(matches, o)
			}
		}
		switch len(matches) {
		case 0:
			return notConnectedThere(named, false, conns)
		case 1:
			conn = &matches[0]
		default:
			return fmt.Errorf("%q names %d workspaces this tool works in; name one by its id:\n%s", named, len(matches), connectionLines(matches, true))
		}
	case len(conns) == 1:
		conn = &conns[0]
	default:
		return errSeveral{conns: conns}
	}
	if conn != nil {
		if c, err = fileClient(conn.Login); err != nil && !errors.Is(err, errNotConnected) {
			return err
		}
	}

	login, name := base, "its workspace"
	switch {
	case conn != nil:
		login, name = conn.Login, conn.WorkspaceName
	case c.ws.Name != "":
		name = c.ws.Name
	}
	if dry {
		revoked := ""
		if revoke != "" {
			revoked = ", and its token revoked"
		}
		fmt.Fprintf(stdout, "would be accepted: Logged out of %s: %s would be removed%s.\n", name, login, revoked)
		return nil
	}
	revoked := ""
	if revoke != "" {
		if c == nil {
			return errors.New("the login file is gone, so its token cannot be revoked with it: revoke it in Quadit's settings, then run quadit logout again without --revoke")
		}
		if _, err := c.workspaceRequest(ctx, apiRequest{method: http.MethodDelete, path: "/tokens/" + url.PathEscape(revoke)}); err != nil {
			return fmt.Errorf("the token could not be revoked, so nothing was taken away: %w", err)
		}
		revoked = ", and its token is revoked"
	}
	if err := os.Remove(login); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if conn != nil {
		idx.Connections = slices.DeleteFunc(idx.Connections, func(o connection) bool { return samePath(o.Login, conn.Login) })
		if err := idx.write(dir); err != nil {
			return err
		}
	}
	fmt.Fprintf(stdout, "Logged out of %s: %s is removed%s.\n", name, login, revoked)
	return nil
}

// writePrivate writes a login file or the index whole: a temporary file
// beside it, kept to the person running the command (makePrivate) before
// anything goes into it, then renamed over it. A reader sees the old file
// or the new one, and a token is never in a file others may read.
func writePrivate(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	err = tmp.Close()
	if err == nil {
		err = makePrivate(name)
	}
	if err == nil {
		err = writeSynced(name, data)
	}
	if err == nil {
		err = replaceFile(name, path, true)
	}
	if err != nil {
		_ = os.Remove(name) // the temporary file, when it is still there
		return err
	}
	return syncDir(filepath.Dir(path))
}

// writeSynced writes data into the file at path, there already, and
// flushes it to the disk.
func writeSynced(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}
