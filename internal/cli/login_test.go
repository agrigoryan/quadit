package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
		if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
			t.Fatalf("saved with mode %v", info.Mode().Perm())
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
