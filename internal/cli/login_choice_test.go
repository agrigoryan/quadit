package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
)

// workspaceServer is a fake server of one workspace with one agent in it:
// GET /me answers who the agent is, as text or JSON as asked, for its
// token alone; POST /connect takes any code; DELETE /tokens/ID revokes.
// It keeps every request it was sent.
type workspaceServer struct {
	ws    workspaceRef
	token string
	also  string // another token it takes, when not ""
	url   string

	mu       sync.Mutex
	requests []string
	refuse   bool // answers every request 503
}

func newWorkspaceServer(t *testing.T, ws workspaceRef, token string) *workspaceServer {
	t.Helper()
	s := &workspaceServer{ws: ws, token: token}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	s.url = srv.URL
	return s
}

func (s *workspaceServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path)
	refuse, token, also := s.refuse, s.token, s.also
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch path := strings.TrimPrefix(r.URL.Path, "/api/v1/w/-"); {
	case refuse:
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":{"code":"unavailable","message":"down for a moment"}}`)
	case r.Header.Get("Authorization") != "Bearer "+token && (also == "" || r.Header.Get("Authorization") != "Bearer "+also):
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"code":"unauthorized","message":"bad token"}}`)
	case path == "/me" && r.Header.Get("Accept") == "text/plain":
		_, _ = io.WriteString(w, "@claude in "+s.ws.Name+"\n")
	case path == "/me":
		_ = json.NewEncoder(w).Encode(map[string]any{"handle": "@claude", "kind": "agent", "user_id": "0199dddd-0000-7000-8000-" + s.ws.ID[24:],
			"workspace": s.ws, "projects": []string{"SVA", "WEB"}})
	case path == "/connect":
		_ = json.NewEncoder(w).Encode(map[string]any{"agent": map[string]any{"handle": "@claude"}, "workspace": map[string]any{"name": s.ws.Name}})
	default:
		_, _ = io.WriteString(w, "{}")
	}
}

// takes changes the tokens the server takes: token, and also when not "".
func (s *workspaceServer) takes(token, also string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.token, s.also = token, also
}

// down makes the server answer every request 503.
func (s *workspaceServer) down() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refuse = true
}

// sent are the requests the server was sent.
func (s *workspaceServer) sent() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.requests)
}

var (
	personal = workspaceRef{ID: "0199aaaa-0000-7000-8000-00000000000a", Slug: "personal", Name: "Personal"}
	acme     = workspaceRef{ID: "0199aaaa-0000-7000-8000-00000000000b", Slug: "acme", Name: "Acme"}
	client   = workspaceRef{ID: "0199aaaa-0000-7000-8000-00000000000c", Slug: "client", Name: "Client"}
)

// toolWorld is one tool's login files, in a folder of the test's own that
// QUADIT_CONFIG points at, and the folders the test runs commands in.
type toolWorld struct {
	t    *testing.T
	dir  string // where the logins and the index are
	base string // the tool's base login
	work string // a folder to run commands in, links resolved
}

func newToolWorld(t *testing.T) *toolWorld {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	w := &toolWorld{t: t, dir: filepath.Join(root, "quadit"), work: filepath.Join(root, "work")}
	w.base = filepath.Join(w.dir, "claude.json")
	for _, d := range []string{w.dir, w.work} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("QUADIT_CONFIG", w.base)
	t.Setenv("QUADIT_URL", "")
	t.Setenv("QUADIT_TOKEN", "")
	t.Setenv("QUADIT_WORKSPACE", "")
	t.Chdir(w.work)
	return w
}

// login writes a login file for the server.
func (w *toolWorld) login(path string, s *workspaceServer) {
	w.t.Helper()
	writeJSON(w.t, path, map[string]string{"url": s.url, "token": s.token})
}

// connected makes the tool connected to each server, the first in its
// base login, the others beside it, all in the index.
func (w *toolWorld) connected(servers ...*workspaceServer) {
	w.t.Helper()
	idx, err := readIndex(w.dir)
	if err != nil {
		w.t.Fatal(err)
	}
	for i, s := range servers {
		path := w.base
		if i > 0 {
			path = filepath.Join(w.dir, "claude-"+s.ws.Slug+".json")
		}
		w.login(path, s)
		idx.Connections = append(idx.Connections, connection{Tool: w.base, Login: path, Server: s.url, WorkspaceID: s.ws.ID, Workspace: s.ws.Slug,
			WorkspaceName: s.ws.Name, AgentID: "0199dddd-0000-7000-8000-" + s.ws.ID[24:], Agent: "@claude"})
	}
	if err := idx.write(w.dir); err != nil {
		w.t.Fatal(err)
	}
}

// tie ties folder (made when missing) to a workspace in the index.
func (w *toolWorld) tie(folder string, ws workspaceRef, project string) {
	w.t.Helper()
	if err := os.MkdirAll(folder, 0o700); err != nil {
		w.t.Fatal(err)
	}
	idx, err := readIndex(w.dir)
	if err != nil {
		w.t.Fatal(err)
	}
	idx.Folders = append(idx.Folders, folderTie{Folder: folder, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Project: project})
	if err := idx.write(w.dir); err != nil {
		w.t.Fatal(err)
	}
}

// choose is the login a command would work as, asked as ask says.
func choose(t *testing.T, ask workspaceAsk) (*Client, error) {
	t.Helper()
	c, _, err := openLogin(context.Background(), ask)
	return c, err
}

// is fails the test unless c is the login of s.
func is(t *testing.T, c *Client, err error, s *workspaceServer) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if c.URL != s.url || c.Token != s.token {
		t.Fatalf("chose %s, want %s's login (%s)", c.URL, s.ws.Name, s.url)
	}
}

func TestACommandWorksInTheWorkspaceItIsToldElseTheFoldersElseTheOnly(t *testing.T) {
	t.Run("one login and no index is used as it always was, nothing asked", func(t *testing.T) {
		w := newToolWorld(t)
		a := newWorkspaceServer(t, personal, "qd_a")
		w.login(w.base, a)
		c, err := choose(t, workspaceAsk{})
		is(t, c, err, a)
		if len(a.sent()) != 0 {
			t.Fatalf("choosing the only login asked the server %v", a.sent())
		}
	})
	t.Run("one connection is used without a tie", func(t *testing.T) {
		w := newToolWorld(t)
		a := newWorkspaceServer(t, personal, "qd_a")
		w.connected(a)
		c, err := choose(t, workspaceAsk{})
		is(t, c, err, a)
		if c.ws != personal {
			t.Fatalf("the workspace is not known from the index: %+v", c.ws)
		}
	})
	t.Run("a workspace named by id, slug or name, in any case, is chosen without asking a server", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		for _, name := range []string{acme.ID, "acme", "ACME", "Acme"} {
			c, err := choose(t, workspaceAsk{named: name})
			is(t, c, err, b)
		}
		if len(a.sent())+len(b.sent()) != 0 {
			t.Fatalf("the servers were asked %v %v", a.sent(), b.sent())
		}
	})
	t.Run("the folder's tie chooses, from inside it and through a link", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		site := filepath.Join(w.work, "site")
		w.tie(site, acme, "WEB")
		deep := filepath.Join(site, "src", "app")
		if err := os.MkdirAll(deep, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Chdir(deep)
		c, err := choose(t, workspaceAsk{})
		is(t, c, err, b)
		link := filepath.Join(w.dir, "site-link")
		symlink(t, site, link)
		t.Chdir(link)
		c, err = choose(t, workspaceAsk{})
		is(t, c, err, b)
	})
	t.Run("on macOS and Windows a tie is found in another case", func(t *testing.T) {
		if !foldsCase {
			t.Skip("this system tells case apart")
		}
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		site := filepath.Join(w.work, "site")
		w.tie(strings.ToUpper(site), acme, "")
		if err := os.MkdirAll(site, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Chdir(site)
		c, err := choose(t, workspaceAsk{})
		is(t, c, err, b)
	})
	t.Run("a workspace named wins over the folder's tie, for that command", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		w.tie(w.work, acme, "")
		c, err := choose(t, workspaceAsk{named: "personal"})
		is(t, c, err, a)
	})
	t.Run("QUADIT_WORKSPACE names one, and --workspace= wins over it", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		t.Setenv("QUADIT_WORKSPACE", acme.ID)
		c, err := choose(t, workspaceAsk{named: namedWorkspace(switches{})})
		is(t, c, err, b)
		c, err = choose(t, workspaceAsk{named: namedWorkspace(switches{workspace: "personal"})})
		is(t, c, err, a)
	})
	t.Run("a tie leaves the folder's commands alone where it is not", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		w.tie(filepath.Join(w.work, "site"), acme, "")
		_, err := choose(t, workspaceAsk{})
		if !errors.As(err, new(errSeveral)) {
			t.Fatalf("a tie beside the folder chose for it: %v", err)
		}
	})
}

func TestACommandAmongSeveralWorkspacesNeverGuesses(t *testing.T) {
	t.Run("several connections, no tie and nothing named: refused with the list, nothing sent", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		_, err := choose(t, workspaceAsk{})
		want := "This folder is tied to no Quadit workspace, and this tool works in 2:\n" +
			"  personal  @claude in Personal (" + serverHost(a.url) + ")\n" +
			"  acme      @claude in Acme (" + serverHost(b.url) + ")\n" +
			"Say which: --workspace=personal, or tie this folder: quadit use personal [project=KEY]"
		if err == nil || err.Error() != want {
			t.Fatalf("got %v, want:\n%s", err, want)
		}
		if len(a.sent())+len(b.sent()) != 0 {
			t.Fatal("a server was sent something")
		}
		code, out, errs := runCLI(t, "comment", "SVA-12", "hello")
		if code != 2 || !strings.Contains(errs, "this tool works in 2") || out != "" || len(a.sent())+len(b.sent()) != 0 {
			t.Fatalf("quadit comment: %d %q %q, sent %v %v", code, out, errs, a.sent(), b.sent())
		}
	})
	t.Run("quadit me lists them instead", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		code, out, _ := runCLI(t, "me")
		if code != 0 || !strings.HasPrefix(out, "This folder is tied to no Quadit workspace, and this tool works in 2:") {
			t.Fatalf("quadit me: %d %q", code, out)
		}
	})
	t.Run("a name none of them has is refused with the list", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		_, err := choose(t, workspaceAsk{named: "client"})
		if err == nil || !strings.HasPrefix(err.Error(), `this tool is not connected to a workspace named "client"; it works in:`) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a slug two workspaces have asks for the id", func(t *testing.T) {
		w := newToolWorld(t)
		other := acme
		other.ID = "0199aaaa-0000-7000-8000-00000000000d"
		w.connected(newWorkspaceServer(t, acme, "qd_a"), newWorkspaceServer(t, other, "qd_b"))
		_, err := choose(t, workspaceAsk{named: "acme"})
		if err == nil || !strings.Contains(err.Error(), `"acme" names 2 workspaces this tool works in; name one by its id:`) || !strings.Contains(err.Error(), other.ID) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a folder tied to a workspace the tool is not connected to is refused", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		w.tie(w.work, client, "")
		_, err := choose(t, workspaceAsk{})
		if err == nil || !strings.HasPrefix(err.Error(), "this folder is tied to Client, where this tool is not connected") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a folder that cannot be found is refused when folders are tied, nothing sent", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Windows does not remove the folder a process works in")
		}
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		w.tie(filepath.Join(w.work, "site"), acme, "")
		gone := filepath.Join(w.work, "gone")
		if err := os.Mkdir(gone, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Chdir(gone)
		if err := os.Remove(gone); err != nil {
			t.Fatal(err)
		}
		_, err := choose(t, workspaceAsk{})
		if err == nil || !strings.HasPrefix(err.Error(), "cannot tell which folder this command runs in") || len(a.sent())+len(b.sent()) != 0 {
			t.Fatalf("got %v", err)
		}
	})
}

func TestTheEnvironmentsLoginMustBeTheOneChosen(t *testing.T) {
	t.Run("with nothing named and no tie, QUADIT_URL and QUADIT_TOKEN win, as they always did", func(t *testing.T) {
		w := newToolWorld(t)
		a, b, c := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"), newWorkspaceServer(t, client, "qd_c")
		w.connected(a, b)
		t.Setenv("QUADIT_URL", c.url)
		t.Setenv("QUADIT_TOKEN", c.token)
		got, err := choose(t, workspaceAsk{})
		is(t, got, err, c)
	})
	t.Run("a tie or a name that chooses another login is refused", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		t.Setenv("QUADIT_URL", a.url)
		t.Setenv("QUADIT_TOKEN", a.token)
		w.tie(w.work, acme, "")
		_, err := choose(t, workspaceAsk{})
		if err == nil || err.Error() != "QUADIT_URL and QUADIT_TOKEN are set for another login than Acme's: unset them here" {
			t.Fatalf("got %v", err)
		}
		_, err = choose(t, workspaceAsk{named: "acme"})
		if err == nil || !strings.HasPrefix(err.Error(), "QUADIT_URL and QUADIT_TOKEN are set for another login than Acme's") {
			t.Fatalf("got %v", err)
		}
		got, err := choose(t, workspaceAsk{named: "personal"})
		is(t, got, err, a)
	})
	t.Run("a login the index does not know is asked its workspace, and must be the one chosen", func(t *testing.T) {
		w := newToolWorld(t)
		a, b, c := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"), newWorkspaceServer(t, client, "qd_c")
		w.connected(a, b)
		t.Setenv("QUADIT_URL", c.url)
		t.Setenv("QUADIT_TOKEN", c.token)
		got, err := choose(t, workspaceAsk{named: client.ID})
		is(t, got, err, c)
		_, err = choose(t, workspaceAsk{named: "nowhere"})
		if err == nil || err.Error() != `QUADIT_URL and QUADIT_TOKEN are set for a login in Client, not in nowhere: unset them here` {
			t.Fatalf("got %v", err)
		}
	})
}

func TestAToolWithOneLoginIsAskedItsWorkspaceWhenOneIsChosen(t *testing.T) {
	w := newToolWorld(t)
	a := newWorkspaceServer(t, personal, "qd_a")
	w.login(w.base, a)
	t.Run("a printed line of its own workspace works", func(t *testing.T) {
		c, err := choose(t, workspaceAsk{named: personal.ID})
		is(t, c, err, a)
	})
	t.Run("another workspace is refused", func(t *testing.T) {
		_, err := choose(t, workspaceAsk{named: acme.ID})
		if err == nil || err.Error() != `this tool works in Personal only, not in "`+acme.ID+`"` {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a folder tied to another workspace by another tool is refused", func(t *testing.T) {
		w.tie(w.work, acme, "")
		_, err := choose(t, workspaceAsk{})
		if err == nil || !strings.HasPrefix(err.Error(), "this folder is tied to Acme, and this tool works in Personal only") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a server that cannot say is refused", func(t *testing.T) {
		a.down()
		_, err := choose(t, workspaceAsk{named: personal.ID})
		if err == nil || !strings.HasPrefix(err.Error(), "cannot check which workspace this login is in") {
			t.Fatalf("got %v", err)
		}
	})
}

func TestConnectSendsTheCodeOnlyToTheWorkspaceItsLineNames(t *testing.T) {
	w := newToolWorld(t)
	a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
	w.connected(a, b)
	w.tie(w.work, personal, "")
	posted := func(s *workspaceServer) bool { return slices.Contains(s.sent(), "POST /api/v1/w/-/connect") }
	t.Run("without the workspace, nothing is sent, even in a tied folder", func(t *testing.T) {
		code, _, errs := runCLI(t, "connect", "K7PQ2M")
		if code != 2 || !strings.HasPrefix(errs, "This tool works in 2 Quadit workspaces:") || posted(a) || posted(b) {
			t.Fatalf("connect: %d %q", code, errs)
		}
	})
	t.Run("the line's own words are refused as part of the code", func(t *testing.T) {
		code, _, errs := runCLI(t, "connect", "K7PQ2M", "in", "Acme", "--workspace=acme")
		if code != 1 || !strings.Contains(errs, "quadit connect CODE --workspace=NAME") || posted(a) || posted(b) {
			t.Fatalf("connect: %d %q", code, errs)
		}
	})
	t.Run("named, it goes to that server alone, though the folder is tied to the other", func(t *testing.T) {
		code, out, errs := runCLI(t, "connect", "K7PQ2M", "--workspace=Acme")
		if code != 0 || !strings.HasPrefix(out, `Connected as @claude in the workspace "Acme".`) || posted(a) || !posted(b) {
			t.Fatalf("connect: %d %q %q", code, out, errs)
		}
	})
}

func TestAConnectCodeIsNotSettledByTheEnvironment(t *testing.T) {
	t.Run("several connections: refused with the list, though QUADIT_URL and QUADIT_TOKEN are set", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		t.Setenv("QUADIT_URL", a.url)
		t.Setenv("QUADIT_TOKEN", a.token)
		code, _, errs := runCLI(t, "connect", "K7PQ2M")
		if code != 2 || !strings.HasPrefix(errs, "This tool works in 2 Quadit workspaces:") || len(a.sent())+len(b.sent()) != 0 {
			t.Fatalf("connect: %d %q, sent %v %v", code, errs, a.sent(), b.sent())
		}
	})
	t.Run("one login: QUADIT_URL and QUADIT_TOKEN of another are refused", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.login(w.base, a)
		t.Setenv("QUADIT_URL", b.url)
		t.Setenv("QUADIT_TOKEN", b.token)
		code, _, errs := runCLI(t, "connect", "K7PQ2M")
		if code != 2 || !strings.HasPrefix(errs, "QUADIT_URL and QUADIT_TOKEN are set for another login than this tool's") || len(a.sent())+len(b.sent()) != 0 {
			t.Fatalf("connect: %d %q", code, errs)
		}
	})
}

// TestALoginFileOfAnotherWorkspaceThanTheIndexSaysIsRefused: when a login
// file was replaced by another workspace's, the GET /me a command makes
// anyway says so, and nothing more is sent.
func TestALoginFileOfAnotherWorkspaceThanTheIndexSaysIsRefused(t *testing.T) {
	w := newToolWorld(t)
	a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
	w.connected(a, b)
	w.login(filepath.Join(w.dir, "claude-acme.json"), a) // Personal's login, where Acme's was
	code, out, errs := runCLI(t, "connect", "--workspace=acme")
	if code != 1 || !strings.Contains(errs, "holds a login in Personal, not in Acme") {
		t.Fatalf("connect: %d %q %q", code, out, errs)
	}
}

// runCLI runs quadit with args, as the command line does.
func runCLI(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errs strings.Builder
	code = Run(args, &out, &errs)
	return code, out.String(), errs.String()
}
