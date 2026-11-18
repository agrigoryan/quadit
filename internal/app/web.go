//go:build web

// The built-in web app, served from the files embedded at build time.

package app

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/agrigoryan/quadit/web"
)

// WebHandler serves the embedded app: its built files as they are, and its
// index page for every other path, which the app's own router then shows.
// Built without the web tag, the binary has no app and WebHandler (in
// noweb.go) is nil.
func WebHandler() http.Handler {
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
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
			// server; pictures in Markdown may come from elsewhere. Its forms
			// post only to its own server, and one of them, Continue on the
			// page that signs the desktop app in (/desktop/connect), is
			// answered with a redirect to the app, quadit://connect: a browser
			// holds a form's redirect to form-action too. Every page allows
			// it, because the app moves between its pages without loading
			// one: coming back from the sign-in page, the policy in force is
			// the one /login was loaded with.
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self'; "+
				"worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' quadit:")
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
