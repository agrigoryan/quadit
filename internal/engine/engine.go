// Package engine applies changes. Every write to a workspace, from a person
// in the browser or an agent on the API, is a named change with an id made by
// the caller. The engine checks it, writes the rows and the events in one
// transaction, and remembers the id so the same change sent twice is applied
// once.
//
// How the package is laid out:
//
//	engine.go       the Engine and its constructor
//	apply.go        Apply and Batch: a change, its result, the transaction,
//	                a resent id, approvals
//	actor.go        who sends a change, and the person an agent works for
//	register.go     the table of change types and register, which adds one
//	args.go         reading a change's arguments, strictly
//	opt.go          Opt, an argument that tells absent from null
//	errors.go       Error, the refusal codes, and saying in a caller's words
//	                what was wrong
//	cx.go           cx, what a handler works with; events and where they go
//	patch.go        an update's changed fields; save and trash
//	resolve.go      finding rows by what people call them (SVA-12, @ann)
//	notify.go       the inbox, watchers, mentions and the search index
//	memo.go         a transaction that remembers small rows it read
//	sys.go          writes the engine makes itself (rules, roll-overs)
//	maintain.go     reindexing and purging, run in the background
//	catalog.go      the list of change types and their arguments, for callers
//	ch_<what>.go    the changes to one kind of thing (ch_labels.go: label.*),
//	                registered in the file's init, with what only they use
//	ch_task*.go     task.*: create, update, move, take; saving a task, the
//	                checks on it, and its fields
//	ch_doc*.go      doc.*: create and update, edit and write, versions; a
//	                page's blocks, and its project
//	ch_budgets.go   what agents spend, and the warnings
//	ch_bootstrap.go a new workspace and its owner
//	ch_shared.go    what the handlers of several files use
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
