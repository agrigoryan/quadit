package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/agrigoryan/quadit/internal/fakeagent"
)

// TestMain keeps every test of the command away from the login of whoever
// runs them: what the command reads or writes beside a login (the
// listener's lease, the mark of the app's server) goes to a folder of the
// run's own, whatever QUADIT_CONFIG, QUADIT_URL or QUADIT_TOKEN the shell
// running the tests has, and the programs' own folders are never the
// person's (CLAUDE_CONFIG_DIR and CODEX_HOME are unset; a test gives a
// home of its own). First of all, the test binary started as a stand-in
// agent program by quadit run's tests (FAKEAGENT) is that program, one
// started as quadit run by a test that kills it (QUADIT_TEST_SERVE) is that,
// and one started as a listen test's command (listenCommand) is that.
func TestMain(m *testing.M) {
	if fakeagent.Main() {
		return
	}
	if spec := os.Getenv("QUADIT_TEST_SERVE"); spec != "" {
		os.Exit(serveForTest(spec))
	}
	if len(os.Args) > 2 && os.Args[1] == testCommandMark {
		os.Exit(testCommand(os.Args[2], os.Args[3:]))
	}
	dir, err := os.MkdirTemp("", "quadit-cli-test")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, v := range []string{"QUADIT_URL", "QUADIT_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"} {
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
