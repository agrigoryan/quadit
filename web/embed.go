//go:build web

// Package web holds the built web app so it can be compiled into the binary.
// Build it first: cd web && pnpm build
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
