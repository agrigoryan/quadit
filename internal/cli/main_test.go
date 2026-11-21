package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestMain keeps every test of the command away from the login of whoever
// runs them: what the command reads or writes beside a login (the
// listener's lease, the mark of the app's server) goes to a folder of the
// run's own, whatever QUADIT_CONFIG, QUADIT_URL or QUADIT_TOKEN the shell
// running the tests has.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "quadit-cli-test")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, v := range []string{"QUADIT_URL", "QUADIT_TOKEN"} {
		if err := os.Unsetenv(v); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	if err := os.Setenv("QUADIT_CONFIG", filepath.Join(dir, "config.json")); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir) // a temporary folder of this run alone
	os.Exit(code)
}
