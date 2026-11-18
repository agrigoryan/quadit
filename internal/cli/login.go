// The login command: saving the server's address and a token.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// login checks a server address and a token by asking who they are, and
// saves them where NewClient reads them. A token of "-" is read from stdin,
// so that it is not in the list of running processes. "login --path" prints
// where the login is kept.
func login(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "--path" {
		fmt.Fprintln(stdout, configPath())
		return 0
	}
	if len(args) != 2 {
		fmt.Fprintln(stderr, "usage: quadit login URL TOKEN|-  or  quadit login --path")
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
	path := configPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	// WriteFile sets the mode only on a file it creates: a login file that
	// is already there is made private before the token goes into it.
	if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintln(stderr, err)
		return 1
	}
	raw, _ := json.MarshalIndent(savedConfig{URL: c.URL, Token: c.Token}, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "saved to %s\n%s", path, me)
	return 0
}
