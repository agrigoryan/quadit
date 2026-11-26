package picture

import (
	"bytes"
	"context"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestAPictureIsTakenAtTheSizeAsked: with a browser on the machine, a page
// is drawn at exactly the width and height asked, as a PNG; the browser is
// driven over its debugging pipe, which each system hands it its own way.
func TestAPictureIsTakenAtTheSizeAsked(t *testing.T) {
	if findChrome() == "" {
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
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(shot))
	if err != nil {
		t.Fatalf("the picture is not a PNG: %v", err)
	}
	if size := img.Bounds().Size(); size.X != 800 || size.Y != 600 {
		t.Fatalf("the picture is %dx%d, want 800x600", size.X, size.Y)
	}
	if r, g, b, _ := img.At(400, 300).RGBA(); r>>8 != 0x12 || g>>8 != 0x34 || b>>8 != 0x56 {
		t.Fatalf("the page's colour is not in the picture: %x %x %x", r>>8, g>>8, b>>8)
	}
}
