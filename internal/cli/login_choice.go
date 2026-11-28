// Which login a command works as. A tool may be an agent in several
// workspaces, one login file each (connections.go); a command takes the
// one it is told (--workspace=, or QUADIT_WORKSPACE from a process Quadit
// started), else the one its folder is tied to, else the only one. Among
// several it never picks one by itself: it refuses, and lists them.

package cli

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// workspaceAsk is what a command was told about the workspace it works
// in: a workspace named (by id, slug or name), and whether the folder's
// tie counts.
type workspaceAsk struct {
	named    string
	byFolder bool
}

// askOf is what a command was told: --workspace=, else QUADIT_WORKSPACE.
func askOf(sw switches, byFolder bool) workspaceAsk {
	return workspaceAsk{named: cmp.Or(sw.workspace, os.Getenv("QUADIT_WORKSPACE")), byFolder: byFolder}
}

// chosenLogin is what the choice was made from, for a command that says
// so (quadit me): the tool's connections and the folder's tie, when it
// counted.
type chosenLogin struct {
	conns []connection
	tie   *folderTie
}

// openLogin is the client of the login a command works as, chosen by ask:
//
//  1. a workspace named, matched against the tool's connections;
//  2. else the tie of the folder the command runs in (its real path, or
//     the nearest folder above it with one);
//  3. else the tool's only connection, or its one login file when it has
//     none, as before there were connections;
//  4. several connections and nothing else: errSeveral, nothing is sent.
//
// QUADIT_URL and QUADIT_TOKEN, both set, are used when nothing is named
// and no tie counts, as they always were; when something is, they must be
// that login, or the command is refused. A login whose workspace the index
// does not know (the environment's, or the file of a tool with no
// connections) is asked for it with its own GET /me.
func openLogin(ctx context.Context, ask workspaceAsk) (*Client, chosenLogin, error) {
	base := configPath()
	dir := filepath.Dir(base)
	idx, err := readIndex(dir)
	if err != nil {
		return nil, chosenLogin{}, err
	}
	chosen := chosenLogin{conns: idx.of(idx.toolOf(base))}
	if ask.named == "" && ask.byFolder && len(idx.Folders) > 0 {
		here, err := os.Getwd()
		if err == nil {
			here, err = realFolder(here)
		}
		if err != nil {
			return nil, chosen, fmt.Errorf("cannot tell which folder this command runs in (%w), and folders are tied to Quadit workspaces: nothing was sent", err)
		}
		if tie, ok := idx.tieAt(here); ok {
			chosen.tie = &tie
		}
	}
	env := envClient()

	// What the command wants, if anything, and how to say it.
	var wanted func(workspaceRef) bool
	var wantedName string
	switch {
	case ask.named != "":
		wanted, wantedName = func(w workspaceRef) bool { return w.named(ask.named) }, ask.named
	case chosen.tie != nil:
		tied := chosen.tie.WorkspaceID
		wanted, wantedName = func(w workspaceRef) bool { return w.ID == tied }, idx.workspaceName(tied)
	}
	if wanted == nil {
		switch {
		case env != nil:
			return env, chosen, nil
		case len(chosen.conns) == 0:
			c, err := fileClient(base)
			return c, chosen, err
		case len(chosen.conns) == 1:
			c, err := connectionClient(chosen.conns[0])
			return c, chosen, err
		}
		return nil, chosen, errSeveral{conns: chosen.conns, byFolder: ask.byFolder}
	}

	var matches []connection
	for _, c := range chosen.conns {
		if wanted(c.ref()) {
			matches = append(matches, c)
		}
	}
	switch {
	case len(matches) > 1:
		return nil, chosen, fmt.Errorf("%q names %d workspaces this tool works in; name one by its id:\n%s", ask.named, len(matches), connectionLines(matches, true))
	case len(matches) == 1:
		c, err := connectionClient(matches[0])
		if err != nil {
			return nil, chosen, err
		}
		if env != nil && (env.URL != c.URL || env.Token != c.Token) {
			return nil, chosen, fmt.Errorf("QUADIT_URL and QUADIT_TOKEN are set for another login than %s's: unset them here", matches[0].WorkspaceName)
		}
		return c, chosen, nil
	}

	// None of the tool's connections. The environment's login, or the one
	// file of a tool that has no connections, may still be in it.
	c := env
	if c == nil {
		if len(chosen.conns) > 0 {
			return nil, chosen, notConnectedThere(wantedName, ask.named == "", chosen.conns)
		}
		if c, err = fileClient(base); err != nil {
			return nil, chosen, err
		}
	}
	w, err := c.workspace(ctx)
	if err != nil {
		return nil, chosen, fmt.Errorf("cannot check which workspace this login is in: %w", err)
	}
	switch {
	case wanted(w):
		return c, chosen, nil
	case env != nil:
		return nil, chosen, fmt.Errorf("QUADIT_URL and QUADIT_TOKEN are set for a login in %s, not in %s: unset them here", w.Name, wantedName)
	case ask.named == "":
		return nil, chosen, fmt.Errorf("this folder is tied to %s, and this tool works in %s only: connect it to %s in the Quadit app, or, when the person names %s for this command, add --workspace=%s",
			wantedName, w.Name, wantedName, w.Name, w.Slug)
	}
	return nil, chosen, fmt.Errorf("this tool works in %s only, not in %q", w.Name, ask.named)
}

// errSeveral refuses a command that names no workspace, in a folder tied
// to none, from a tool connected to several: which one would be a guess.
// Its words list them and how to say which.
type errSeveral struct {
	conns    []connection
	byFolder bool // whether a folder's tie would have settled it
}

func (e errSeveral) Error() string {
	head := fmt.Sprintf("This tool works in %d Quadit workspaces:", len(e.conns))
	if e.byFolder {
		head = fmt.Sprintf("This folder is tied to no Quadit workspace, and this tool works in %d:", len(e.conns))
	}
	which := connectionRef(e.conns[0], e.conns)
	tail := "Say which: --workspace=" + which
	if e.byFolder {
		tail += ", or tie this folder: quadit use " + which + " [project=KEY]"
	}
	return head + "\n" + connectionLines(e.conns, false) + "\n" + tail
}

// notConnectedThere refuses a command whose workspace (named, or the
// folder's when tied) is none of the tool's connections.
func notConnectedThere(workspace string, tied bool, conns []connection) error {
	if tied {
		return fmt.Errorf("this folder is tied to %s, where this tool is not connected: connect it there in the Quadit app, or, when the person names another workspace for this command, add --workspace=NAME. It works in:\n%s",
			workspace, connectionLines(conns, false))
	}
	return fmt.Errorf("this tool is not connected to a workspace named %q; it works in:\n%s", workspace, connectionLines(conns, false))
}

// connectionLines are connections one a line: what names it for
// --workspace=, its agent, its workspace and its server.
func connectionLines(conns []connection, byID bool) string {
	refs := make([]string, len(conns))
	width := 0
	for i, c := range conns {
		refs[i] = connectionRef(c, conns)
		if byID {
			refs[i] = c.WorkspaceID
		}
		width = max(width, len(refs[i]))
	}
	lines := make([]string, len(conns))
	for i, c := range conns {
		lines[i] = fmt.Sprintf("  %-*s  %s in %s (%s)", width, refs[i], c.Agent, c.WorkspaceName, serverHost(c.Server))
	}
	return strings.Join(lines, "\n")
}

// connectionRef is what names a connection's workspace among conns: its
// slug, or its id when another of them has the same slug.
func connectionRef(c connection, conns []connection) string {
	for _, o := range conns {
		if o.WorkspaceID != c.WorkspaceID && strings.EqualFold(o.Workspace, c.Workspace) {
			return c.WorkspaceID
		}
	}
	return c.Workspace
}

// serverHost is a server's address as a person reads it: its host and
// port, without the scheme.
func serverHost(server string) string {
	if u, err := url.Parse(server); err == nil && u.Host != "" {
		return u.Host
	}
	return server
}

// envClient is the client of QUADIT_URL and QUADIT_TOKEN when both are
// set, else nil: the two are never mixed with a file's.
func envClient() *Client {
	u, token := os.Getenv("QUADIT_URL"), os.Getenv("QUADIT_TOKEN")
	if u == "" || token == "" {
		return nil
	}
	return &Client{URL: strings.TrimRight(u, "/"), Token: token, HTTP: &http.Client{Timeout: requestTimeout}}
}

// errNotConnected is a command with no login at all.
var errNotConnected = errors.New("not connected: set QUADIT_URL and QUADIT_TOKEN, or run: quadit login <url> <token>")

// fileClient is the client of the login file at path, which starts the
// desktop app when the login is one it made and its server is not
// running. No file is not being connected.
func fileClient(path string) (*Client, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNotConnected
	}
	if err != nil {
		return nil, err
	}
	sc, err := readLogin(raw, path)
	if err != nil {
		return nil, err
	}
	c := &Client{URL: strings.TrimRight(sc.URL, "/"), Token: sc.Token, HTTP: &http.Client{Timeout: requestTimeout}, login: path}
	if sc.App != nil {
		c.app = &appStart{login: *sc.App, dir: filepath.Dir(path), starter: systemStarter{}, within: appStartWithin, stderr: os.Stderr}
	}
	return c, nil
}

// connectionClient is the client of a connection's login file, its
// workspace known from the index.
func connectionClient(conn connection) (*Client, error) {
	c, err := fileClient(conn.Login)
	if errors.Is(err, errNotConnected) {
		return nil, fmt.Errorf("the login file of %s is gone (%s): connect this tool there again, or run: quadit logout --workspace=%s", conn.WorkspaceName, conn.Login, conn.WorkspaceID)
	}
	if err != nil {
		return nil, err
	}
	c.ws = conn.ref()
	return c, nil
}

// whoAmI is what GET /me says of a login: who, in which workspace, and
// the projects it may work in.
type whoAmI struct {
	Handle      string       `json:"handle"`
	Kind        string       `json:"kind"`
	UserID      string       `json:"user_id"`
	ReadOnly    bool         `json:"read_only"`
	Responsible string       `json:"responsible"`
	Seq         int64        `json:"seq"`
	Workspace   workspaceRef `json:"workspace"`
	Projects    []string     `json:"projects"`
}

// me asks the login who it is. A server that does not name the workspace
// is older than this quadit.
func (c *Client) me(ctx context.Context) (whoAmI, error) {
	raw, err := c.JSON(ctx, "/me", url.Values{})
	if err != nil {
		return whoAmI{}, err
	}
	var me whoAmI
	if err := json.Unmarshal(raw, &me); err != nil {
		return whoAmI{}, err
	}
	if !pageForm.MatchString(me.Workspace.ID) {
		return whoAmI{}, errors.New("the server did not say which workspace this login is in: it is older than this quadit, update it")
	}
	c.ws = me.Workspace
	return me, nil
}

// workspace is the workspace the client's login is in: as the index has
// it, else as its GET /me says, asked once.
func (c *Client) workspace(ctx context.Context) (workspaceRef, error) {
	if c.ws.ID != "" {
		return c.ws, nil
	}
	_, err := c.me(ctx)
	return c.ws, err
}
