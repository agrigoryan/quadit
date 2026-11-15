package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// login checks a server address and a token by asking who they are, and
// saves them where NewClient reads them.
func login(args []string, stdout, stderr io.Writer) int {
	if len(args) != 2 {
		fmt.Fprintln(stderr, "usage: quadit login URL TOKEN")
		return 2
	}
	c := &Client{URL: strings.TrimRight(args[0], "/"), Token: args[1], HTTP: &httpClient}
	me, err := c.Text("/me", nil)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	path := configPath()
	os.MkdirAll(filepath.Dir(path), 0o700)
	raw, _ := json.MarshalIndent(savedConfig{URL: c.URL, Token: c.Token}, "", "  ")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "saved to %s\n%s", path, me)
	return 0
}
