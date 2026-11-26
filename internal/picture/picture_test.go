package picture

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestAPictureIsTakenAtTheSizeAsked: with a browser on the machine, a page
// is drawn at exactly the width and height asked, as a PNG; the browser is
// driven over its debugging pipe, which each system hands it its own way.
// A browser that cannot run here at all, as the server runs it but without
// the pipe (browserRuns), is no browser for this test: it says why and
// stops; one that runs and gives no picture is a failure.
func TestAPictureIsTakenAtTheSizeAsked(t *testing.T) {
	chrome := findChrome()
	if chrome == "" {
		t.Skip("no Chrome or Chromium on this machine")
	}
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `<!doctype html><title>t</title><body style="background:#123456">A page</body>`)
	}))
	t.Cleanup(page.Close)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	shot, _, err := Take(ctx, Request{Target: page.URL, Width: 800, Height: 600})
	if err != nil {
		if why := browserRuns(t, chrome); why != nil {
			t.Skipf("no usable browser here: %s does not run headless (%v); taking the picture said: %v", chrome, why, err)
		}
		t.Fatalf("%s runs here, and gave no picture: %v", chrome, err)
	}
	img, err := png.Decode(bytes.NewReader(shot))
	if err != nil {
		t.Fatalf("the picture is not a PNG: %v", err)
	}
	if size := img.Bounds().Size(); size.X != 800 || size.Y != 600 {
		t.Fatalf("the picture is %dx%d, want 800x600", size.X, size.Y)
	}
	if r, g, b, _ := img.At(400, 300).RGBA(); r>>8 != 0x12 || g>>8 != 0x34 || b>>8 != 0x56 {
		t.Fatalf("the page's color is not in the picture: %x %x %x", r>>8, g>>8, b>>8)
	}
}

// browserRuns says why the browser at chrome cannot draw a page here,
// started with the server's own switches but no debugging pipe, or nil
// when it can.
func browserRuns(t *testing.T, chrome string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	args := append([]string{"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
		"--user-data-dir=" + filepath.Join(t.TempDir(), "profile")}, chromeSwitches()...)
	cmd := exec.CommandContext(ctx, chrome, append(args, "--dump-dom", "about:blank")...)
	cmd.WaitDelay = time.Second // its helpers may hold its output open
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
