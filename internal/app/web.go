//go:build web

package app

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/agrigoryan/quadit/web"
)

func init() {
	WebHandler = func() http.Handler {
		dist, err := fs.Sub(web.Dist, "dist")
		if err != nil {
			return nil
		}
		files := http.FileServerFS(dist)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
			if name == "" {
				name = "index.html"
			}
			if _, err := fs.Stat(dist, name); err != nil || name == "index.html" {
				// Not a file: a page of the app. The app's own router shows it.
				w.Header().Set("Cache-Control", "no-cache")
				// The app runs only its own code and talks only to its own
				// server; pictures in Markdown may come from elsewhere.
				w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
					"img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self'; "+
					"worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
				http.ServeFileFS(w, r, dist, "index.html")
				return
			}
			if strings.HasPrefix(name, "assets/") {
				// Built files carry a hash in their name, so they never change.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
		})
	}
}
