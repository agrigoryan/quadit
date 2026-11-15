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

// gzipPool keeps gzip writers for reuse: making one costs more than the
// answers it usually compresses.
var gzipPool = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed) //nolint:errcheck // cannot fail: BestSpeed is a valid level
	return w
}}

// gzipWriter compresses an answer when, at its first write, the answer
// turns out to be worth it (decide).
type gzipWriter struct {
	http.ResponseWriter
	gz      *gzip.Writer // nil while undecided, and when not compressing
	decided bool         // whether to compress has been settled
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

// decide settles, from the status and headers about to be sent, whether to
// compress the answer: a body worth compressing, of a kind that shrinks,
// not already encoded, and not known to be under 1 KB.
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

// Write decides on the first write, telling the content's type from the
// bytes when the handler did not set one.
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

// Flush sends what was compressed so far, for answers that stream.
func (g *gzipWriter) Flush() {
	if g.gz != nil {
		_ = g.gz.Flush() //nolint:errcheck // Flush cannot report it; the next Write fails the same way
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
