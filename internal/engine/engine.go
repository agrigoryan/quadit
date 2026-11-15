// Package engine applies changes. Every write to a workspace, from a person
// in the browser or an agent on the API, is a named change with an id made by
// the caller. The engine checks it, writes the rows and the events in one
// transaction, and remembers the id so the same change sent twice is applied
// once.
//
// How the changes are laid out:
//
//	engine.go      a change, its result and its refusals; register, which
//	               adds a kind of change, and Batch, which applies them
//	catalog.go     the list of change types and their arguments, for callers
//	ch_<what>.go   the changes to one kind of thing (ch_labels.go: label.*),
//	               registered in the file's init, with what only they use;
//	               a large kind takes several files (ch_task*.go, ch_doc*.go)
//	ch_shared.go   what the handlers of several files use
//
// A handler is a func(c *cx, a Args) error. Its arguments arrive read, with
// unknown fields refused, and the catalog describes the change by the
// fields of Args.
package engine

import (
	"time"

	"github.com/agrigoryan/quadit/internal/store"
)

// Engine applies changes to one store.
type Engine struct {
	st  store.Store
	now func() time.Time
	// OnCommit, when set, is called after a write commits with the
	// workspace and its new position in the feed.
	OnCommit func(workspaceID string, seq int64)
}

// New returns an engine over st.
func New(st store.Store) *Engine {
	return &Engine{st: st, now: time.Now}
}

// Store returns the store, for reads.
func (e *Engine) Store() store.Store { return e.st }

// Now returns the engine's clock in Unix milliseconds.
func (e *Engine) Now() int64 { return e.now().UnixMilli() }
