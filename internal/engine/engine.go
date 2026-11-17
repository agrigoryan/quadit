// Package engine applies changes. Every write to a workspace, from a person
// in the browser or an agent on the API, is a named change with an id made by
// the caller. The engine checks it, writes the rows and the events in one
// transaction, and remembers the id so the same change sent twice is applied
// once. Callers name a change and its arguments (Apply, Batch); the engine
// hides the transaction, the rules each change keeps, the events, inbox,
// watchers and search entries a change brings, and the record of ids
// already applied.
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
//	ranks.go        a row's place in its list: a new row's rank, a rank
//	                given
//	resolve.go      finding rows by what people call them (SVA-12, @ann)
//	notify.go       the inbox, watchers, mentions and the search index
//	memo.go         a transaction that remembers small rows it read
//	sys.go          writes the engine makes itself (rules, roll-overs)
//	maintain.go     reindexing and purging, run in the background
//	catalog.go      the list of change types and their arguments, for callers
//	task_query.go   a task query made into the store's filter, every name
//	                resolved
//	ch_<what>.go    the changes to one kind of thing (ch_labels.go: label.*),
//	                registered in the file's init, with what only they use
//	ch_task*.go     task.*: create, update, move, take; saving a task, the
//	                checks on it, and its fields
//	ch_doc*.go      doc.*: create and update, edit and write, versions; a
//	                page's blocks, its project, and who may see it and the
//	                pages under it (ch_doc_private.go)
//	ch_bootstrap.go a new workspace and its owner
//
// A handler is a func(c *cx, a Args) error. Its arguments arrive read, with
// unknown fields refused, and the catalog describes the change by the
// fields of Args.
package engine

import (
	"errors"
	"time"

	"github.com/agrigoryan/quadit/internal/store"
)

// Engine applies changes to one store.
type Engine struct {
	st  store.Store
	now func() time.Time
	// seal encrypts a secret before it is stored; nil keeps none.
	seal func(plain string) (string, error)
	// OnCommit, when set, is called after a write commits with the
	// workspace and its new position in the feed. It runs on the goroutine
	// that made the write, before Apply, Batch or System returns, so it
	// must not block; it is not called for a dry run or a write that failed.
	OnCommit func(workspaceID string, seq int64)
}

// New returns an engine over st. seal encrypts a secret (a workspace
// secret, an integration's token) before it is stored; an engine made with
// a nil seal refuses every change that would store one, rather than store it
// as sent.
func New(st store.Store, seal func(plain string) (string, error)) *Engine {
	return &Engine{st: st, now: time.Now, seal: seal}
}

// errNoSealer refuses a secret to an engine made without a way to seal it.
var errNoSealer = errors.New("this engine was made without a way to encrypt secrets, so it keeps none")

// sealSecret encrypts a secret before it is stored.
func (e *Engine) sealSecret(plain string) (string, error) {
	if e.seal == nil {
		return "", errNoSealer
	}
	return e.seal(plain)
}

// Store returns the store, for reads.
func (e *Engine) Store() store.Store { return e.st }

// Now returns the engine's clock in Unix milliseconds.
func (e *Engine) Now() int64 { return e.now().UnixMilli() }
