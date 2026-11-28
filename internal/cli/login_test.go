package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestLoginTakesTheTokenFromStandardInput: "-" for the token reads it from
// standard input, so it is never in the list of running processes. It is
// checked with the server before it is saved, as one on the command line is.
func TestLoginTakesTheTokenFromStandardInput(t *testing.T) {
	var seen string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		if seen != "Bearer qd_secret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":{"code":"unauthorized","message":"bad token"}}`)
			return
		}
		_, _ = io.WriteString(w, "@claude in games\n")
	}))
	t.Cleanup(srv.Close)
	path := filepath.Join(t.TempDir(), "claude.json")
	t.Setenv("QUADIT_CONFIG", path)

	t.Run("saved once the server knows it", func(t *testing.T) {
		var out, errs bytes.Buffer
		if code := login(context.Background(), []string{srv.URL + "/", "-"}, strings.NewReader("qd_secret\n"), &out, &errs); code != 0 {
			t.Fatalf("exit %d: %s", code, errs.String())
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var saved savedConfig
		if err := json.Unmarshal(raw, &saved); err != nil {
			t.Fatal(err)
		}
		if saved != (savedConfig{URL: srv.URL, Token: "qd_secret"}) {
			t.Fatalf("saved %+v", saved)
		}
		if readableByOthers(t, path) {
			t.Fatal("saved where others may read it")
		}
	})
	t.Run("a login file readable by others is made private", func(t *testing.T) {
		openToOthers(t, path)
		var out, errs bytes.Buffer
		if code := login(context.Background(), []string{srv.URL, "-"}, strings.NewReader("qd_secret"), &out, &errs); code != 0 {
			t.Fatalf("exit %d: %s", code, errs.String())
		}
		if readableByOthers(t, path) {
			t.Fatal("left where others may read it")
		}
	})
	t.Run("refused by the server, nothing is saved", func(t *testing.T) {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		var out, errs bytes.Buffer
		if code := login(context.Background(), []string{srv.URL, "-"}, strings.NewReader("qd_other"), &out, &errs); code != 1 {
			t.Fatalf("exit %d", code)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("a refused token was saved: %v", err)
		}
	})
	t.Run("nothing on standard input is a usage error", func(t *testing.T) {
		var out, errs bytes.Buffer
		if code := login(context.Background(), []string{srv.URL, "-"}, strings.NewReader("\n"), &out, &errs); code != 2 {
			t.Fatalf("exit %d: %s", code, errs.String())
		}
	})
}

// TestLoginPathSaysWhereTheLoginIsKept: --path prints the file login writes
// and every command reads, QUADIT_CONFIG when it is set, so whoever backs it
// up need not know how the tool picks it.
func TestLoginPathSaysWhereTheLoginIsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codex.json")
	t.Setenv("QUADIT_CONFIG", path)
	var out, errs bytes.Buffer
	if code := login(context.Background(), []string{"--path"}, strings.NewReader(""), &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if out.String() != path+"\n" {
		t.Fatalf("printed %q", out.String())
	}
}

// loginAs runs quadit login with the server's address and its token on
// standard input.
func loginAs(t *testing.T, s *workspaceServer) (int, string) {
	t.Helper()
	var out, errs bytes.Buffer
	code := login(context.Background(), []string{s.url, "-"}, strings.NewReader(s.token), &out, &errs)
	return code, out.String() + errs.String()
}

// savedIn is the login a file holds.
func savedIn(t *testing.T, path string) savedConfig {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var sc savedConfig
	if err := json.Unmarshal(raw, &sc); err != nil {
		t.Fatal(err)
	}
	return sc
}

func TestLoginInAnotherWorkspaceAddsAConnection(t *testing.T) {
	t.Run("the first login is the tool's own file, with no index", func(t *testing.T) {
		w := newToolWorld(t)
		a := newWorkspaceServer(t, personal, "qd_a")
		if code, said := loginAs(t, a); code != 0 {
			t.Fatal(said)
		}
		if savedIn(t, w.base).Token != "qd_a" {
			t.Fatal("the login is not in the tool's file")
		}
		if _, err := os.Stat(indexFile(w.dir)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("one login made an index: %v", err)
		}
	})
	t.Run("a login in another workspace goes beside it, and both are known by their own /me", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.login(w.base, a)
		code, said := loginAs(t, b)
		if code != 0 || !strings.Contains(said, "saved to "+filepath.Join(w.dir, "claude-acme.json")) || !strings.Contains(said, "This tool now works in 2 workspaces:") {
			t.Fatalf("login: %d %s", code, said)
		}
		if savedIn(t, w.base).Token != "qd_a" || savedIn(t, filepath.Join(w.dir, "claude-acme.json")).Token != "qd_b" {
			t.Fatal("the logins are not each in their own file")
		}
		if readableByOthers(t, filepath.Join(w.dir, "claude-acme.json")) || readableByOthers(t, indexFile(w.dir)) {
			t.Fatal("a new file may be read by others")
		}
		idx, err := readIndex(w.dir)
		if err != nil || len(idx.Connections) != 2 {
			t.Fatalf("index %+v %v", idx, err)
		}
		first, second := idx.Connections[0], idx.Connections[1]
		if first.Login != w.base || first.Tool != w.base || first.WorkspaceID != personal.ID || first.Server != a.url || first.Agent != "@claude" ||
			second.Login != filepath.Join(w.dir, "claude-acme.json") || second.Tool != w.base || second.WorkspaceID != acme.ID || second.WorkspaceName != "Acme" {
			t.Fatalf("the connections are %+v", idx.Connections)
		}
		if !slices.Contains(a.sent(), "GET /api/v1/w/-/me") {
			t.Fatal("the first login's workspace was not asked of its own server")
		}
	})
	t.Run("the same workspace again replaces its token", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		b.takes("qd_b2", "")
		if code, said := loginAs(t, b); code != 0 {
			t.Fatal(said)
		}
		if savedIn(t, filepath.Join(w.dir, "claude-acme.json")).Token != "qd_b2" {
			t.Fatal("the token was not replaced")
		}
		if idx, _ := readIndex(w.dir); len(idx.Connections) != 2 {
			t.Fatalf("a connection was added: %+v", idx.Connections)
		}
		a.takes("qd_a2", "")
		if code, said := loginAs(t, a); code != 0 || savedIn(t, w.base).Token != "qd_a2" {
			t.Fatal(said)
		}
	})
	t.Run("the same workspace reached at another address replaces its login", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		moved := newWorkspaceServer(t, acme, "qd_b2")
		if code, said := loginAs(t, moved); code != 0 {
			t.Fatal(said)
		}
		idx, _ := readIndex(w.dir)
		if saved := savedIn(t, filepath.Join(w.dir, "claude-acme.json")); saved.URL != moved.url || len(idx.Connections) != 2 || idx.Connections[1].Server != moved.url {
			t.Fatalf("saved %+v, the connections %+v", saved, idx.Connections)
		}
	})
	t.Run("a new token in the workspace of a tool's one login replaces it, with no index", func(t *testing.T) {
		w := newToolWorld(t)
		a := newWorkspaceServer(t, personal, "qd_a")
		w.login(w.base, a)
		a.takes("qd_a2", "qd_a")
		if code, said := loginAs(t, a); code != 0 {
			t.Fatal(said)
		}
		if savedIn(t, w.base).Token != "qd_a2" {
			t.Fatal("the token was not replaced")
		}
		if _, err := os.Stat(indexFile(w.dir)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("logging in again made an index")
		}
	})
	t.Run("a first login that cannot be read changes nothing", func(t *testing.T) {
		w := newToolWorld(t)
		if err := os.WriteFile(w.base, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		code, said := loginAs(t, newWorkspaceServer(t, acme, "qd_b"))
		if code != 1 || !strings.Contains(said, "this tool's login cannot be read, so nothing was changed") {
			t.Fatalf("login: %d %s", code, said)
		}
		if raw, _ := os.ReadFile(w.base); string(raw) != "{not json" {
			t.Fatal("the unreadable login was overwritten")
		}
	})
	t.Run("a relative QUADIT_CONFIG is the same tool as its absolute spelling", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		t.Chdir(w.dir)
		t.Setenv("QUADIT_CONFIG", "claude.json")
		for _, s := range []*workspaceServer{a, b} {
			if code, said := loginAs(t, s); code != 0 {
				t.Fatal(said)
			}
		}
		t.Setenv("QUADIT_CONFIG", w.base)
		t.Chdir(w.work)
		if _, err := choose(t, workspaceAsk{}); !errors.As(err, new(errSeveral)) {
			t.Fatalf("the absolute spelling of the tool's file chose by itself: %v", err)
		}
	})
	t.Run("a first login that cannot say its workspace changes nothing", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.login(w.base, a)
		a.down()
		code, said := loginAs(t, b)
		if code != 1 || !strings.Contains(said, "could not be asked which workspace it is in, so nothing was changed") {
			t.Fatalf("login: %d %s", code, said)
		}
		if savedIn(t, w.base).Token != "qd_a" {
			t.Fatal("the first login was changed")
		}
		for _, path := range []string{indexFile(w.dir), filepath.Join(w.dir, "claude-acme.json")} {
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("%s was written", path)
			}
		}
	})
	t.Run("a file name taken gets a number", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.login(w.base, a)
		if err := os.WriteFile(filepath.Join(w.dir, "claude-acme.json"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if code, said := loginAs(t, b); code != 0 || !strings.Contains(said, "saved to "+filepath.Join(w.dir, "claude-acme-2.json")) {
			t.Fatalf("login: %d %s", code, said)
		}
	})
}

func TestLogoutTakesAwayOneConnection(t *testing.T) {
	logoutRun := func(t *testing.T, args ...string) (int, string) {
		t.Helper()
		code, out, errs := runCLI(t, append([]string{"logout"}, args...)...)
		return code, out + errs
	}
	t.Run("it revokes the token with itself, removes its file and its connection, and leaves the folder ties", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		w.tie(filepath.Join(w.work, "site"), acme, "WEB")
		w.tie(filepath.Join(w.work, "game"), personal, "SVA")
		const token = "0199eeee-0000-7000-8000-000000000001"
		code, said := logoutRun(t, "--workspace=acme", "--revoke="+token)
		if code != 0 || !strings.HasPrefix(said, "Logged out of Acme: ") {
			t.Fatalf("logout: %d %s", code, said)
		}
		if !slices.Contains(b.sent(), "DELETE /api/v1/w/-/tokens/"+token) || len(a.sent()) != 0 {
			t.Fatalf("revoked with %v and %v", b.sent(), a.sent())
		}
		if _, err := os.Stat(filepath.Join(w.dir, "claude-acme.json")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the login file is still there")
		}
		idx, _ := readIndex(w.dir)
		if len(idx.Connections) != 1 || idx.Connections[0].WorkspaceID != personal.ID || len(idx.Folders) != 2 {
			t.Fatalf("the index is %+v", idx)
		}
		c, err := choose(t, workspaceAsk{})
		is(t, c, err, a)
		// The site folder is still Acme's, which other tools may work in: here its commands are refused, naming it.
		t.Chdir(filepath.Join(w.work, "site"))
		if _, err := choose(t, workspaceAsk{}); err == nil || !strings.HasPrefix(err.Error(), "this folder is tied to Acme, where this tool is not connected") {
			t.Fatalf("a command in the folder of the workspace logged out of: %v", err)
		}
	})
	t.Run("a dry run says what it would take away, and revokes and removes nothing", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		code, said := logoutRun(t, "--dry-run", "--workspace=acme", "--revoke=0199eeee-0000-7000-8000-000000000001")
		if code != 0 || !strings.HasPrefix(said, "would be accepted: Logged out of Acme: ") || len(b.sent()) != 0 {
			t.Fatalf("logout --dry-run: %d %s, sent %v", code, said, b.sent())
		}
		if idx, _ := readIndex(w.dir); len(idx.Connections) != 2 {
			t.Fatal("a dry run took the connection away")
		}
		if _, err := os.Stat(filepath.Join(w.dir, "claude-acme.json")); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a revocation that fails takes nothing away", func(t *testing.T) {
		w := newToolWorld(t)
		a, b := newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b")
		w.connected(a, b)
		b.down()
		code, said := logoutRun(t, "--workspace=acme", "--revoke=0199eeee-0000-7000-8000-000000000001")
		if code != 1 || !strings.Contains(said, "the token could not be revoked, so nothing was taken away") {
			t.Fatalf("logout: %d %s", code, said)
		}
		if idx, _ := readIndex(w.dir); len(idx.Connections) != 2 {
			t.Fatal("the connection was taken away")
		}
		if _, err := os.Stat(filepath.Join(w.dir, "claude-acme.json")); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("among several it must be told which, never by the folder", func(t *testing.T) {
		w := newToolWorld(t)
		w.connected(newWorkspaceServer(t, personal, "qd_a"), newWorkspaceServer(t, acme, "qd_b"))
		w.tie(w.work, acme, "")
		if code, said := logoutRun(t); code != 1 || !strings.HasPrefix(said, "This tool works in 2 Quadit workspaces:") {
			t.Fatalf("logout: %d %s", code, said)
		}
	})
	t.Run("a tool's one login is taken away as it is", func(t *testing.T) {
		w := newToolWorld(t)
		w.login(w.base, newWorkspaceServer(t, personal, "qd_a"))
		if code, said := logoutRun(t); code != 0 {
			t.Fatal(said)
		}
		if _, err := os.Stat(w.base); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the login is still there")
		}
		if code, said := logoutRun(t); code != 0 || said != "This tool has no login to take away.\n" {
			t.Fatalf("logout again: %d %s", code, said)
		}
	})
}
