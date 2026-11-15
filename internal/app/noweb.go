//go:build !web

package app

import "net/http"

// WebHandler is nil: this binary was built without the web app (the web
// build tag, web.go).
func WebHandler() http.Handler { return nil }
