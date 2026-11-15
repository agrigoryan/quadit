// The login command: saving the server's address and a token.

package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// login checks a server address and a token by asking who they are, and
// saves them where NewClient reads them.
func login(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 {
		fmt.Fprintln(stderr, "usage: quadit login URL TOKEN")
		return 2
	}
	c := &Client{URL: strings.TrimRight(args[0], "/"), Token: args[1], HTTP: &http.Client{Timeout: requestTimeout}}
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
	raw, _ := json.MarshalIndent(savedConfig{URL: c.URL, Token: c.Token}, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "saved to %s\n%s", path, me)
	return 0
}
