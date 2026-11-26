//go:build unix

package cli

import (
	"strings"
	"testing"
)

func TestTheGuardIsForWindowsOnly(t *testing.T) {
	var out, errs strings.Builder
	if code := Run([]string{"guard", "true", "--json"}, &out, &errs); code != exitFailed || !strings.HasPrefix(errs.String(), "quadit guard is for Windows only") {
		t.Fatalf("exit %d, said %q", code, errs.String())
	}
}
