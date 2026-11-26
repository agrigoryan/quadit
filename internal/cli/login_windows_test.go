package cli

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"
)

// TestTheLoginIsKeptInAppDataOnWindows: without QUADIT_CONFIG, `quadit
// login --path` answers quadit\config.json in the person's roaming
// application data (APPDATA), where the desktop app looks for it.
func TestTheLoginIsKeptInAppDataOnWindows(t *testing.T) {
	appData := t.TempDir()
	t.Setenv("QUADIT_CONFIG", "")
	t.Setenv("APPDATA", appData)
	var out, errs bytes.Buffer
	if code := Run([]string{"login", "--path"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	if got, want := strings.TrimSpace(out.String()), filepath.Join(appData, "quadit", "config.json"); got != want {
		t.Fatalf("login --path = %s, want %s", got, want)
	}
}
