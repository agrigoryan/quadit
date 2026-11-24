//go:build !unix

package cli

import (
	"bytes"
	"context"
	"testing"
)

func TestRunRefusesToServeWithoutLocksAndGroups(t *testing.T) {
	var out, errs bytes.Buffer
	if code := runnerForm(context.Background(), []string{"registry=" + t.TempDir() + "/runner.json"}, switches{}, &out, &errs); code != 1 ||
		errs.String() != "quadit run serves agents on macOS and Linux only\n" {
		t.Fatalf("exit %d, said %q", code, errs.String())
	}
}

// serveForTest is never asked for where quadit run cannot serve.
func serveForTest(string) int { return 1 }
