package server

import (
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Text answers are sent compressed to anyone who can read them that way:
// the workspace's starting copy and the app's own script shrink about ten
// times, which is most of what a slow link has to carry. Files are left
// alone (they are compressed already, and are read in ranges), and so is
// the live stream.

var gzipPool = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed); return w }}

type gzipWriter struct {
	http.ResponseWriter
	gz      *gzip.Writer
	decided bool
}

// compressible reports whether a kind of content shrinks.
func compressible(contentType string) bool {
	ct := strings.ToLower(contentType)
	if strings.HasPrefix(ct, "text/event-stream") {
		return false
	}
	return strings.HasPrefix(ct, "text/") || strings.Contains(ct, "json") || strings.Contains(ct, "javascript") ||
		strings.Contains(ct, "xml") || strings.Contains(ct, "wasm")
}

func (g *gzipWriter) decide(status int) {
	if g.decided {
		return
	}
	g.decided = true
	h := g.Header()
	if status == http.StatusNoContent || status == http.StatusNotModified || status == http.StatusPartialContent || status < 200 ||
		h.Get("Content-Encoding") != "" || !compressible(h.Get("Content-Type")) {
		return
	}
	if n, err := strconv.Atoi(h.Get("Content-Length")); err == nil && n < 1024 {
		return // not worth it
	}
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	h.Add("Vary", "Accept-Encoding")
	g.gz = gzipPool.Get().(*gzip.Writer)
	g.gz.Reset(g.ResponseWriter)
}

func (g *gzipWriter) WriteHeader(status int) {
	g.decide(status)
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipWriter) Write(b []byte) (int, error) {
	if !g.decided {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.decide(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipWriter) Flush() {
	if g.gz != nil {
		g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

// finish ends the compressed body.
func (g *gzipWriter) finish() {
	if g.gz != nil {
		g.gz.Close()
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}

// compressed wraps w when the caller reads gzip and the answer may be text.
func compressed(w http.ResponseWriter, r *http.Request) (http.ResponseWriter, func()) {
	if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Header.Get("Range") != "" ||
		strings.HasPrefix(r.URL.Path, "/f/") || r.Method == http.MethodHead {
		return w, func() {}
	}
	g := &gzipWriter{ResponseWriter: w}
	return g, g.finish
}
