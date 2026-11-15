package engine

import (
	"reflect"
	"sort"

	"github.com/agrigoryan/quadit/internal/core"
)

// handler is one kind of change.
type handler struct {
	min  core.Role    // the least role that may send it
	args reflect.Type // the struct its arguments are read into
	fn   func(*cx) error
	doc  string
}

var handlers = map[string]handler{}

// register adds a kind of change. Its arguments are read into an A before
// fn runs, and the catalog describes the change by A's fields.
func register[A any](name string, min core.Role, fn func(c *cx, a A) error) {
	handlers[name] = handler{min: min, args: reflect.TypeFor[A](), fn: func(c *cx) error {
		var a A
		if err := c.args(&a); err != nil {
			return err
		}
		return fn(c, a)
	}}
}

// ChangeTypes lists the changes the engine accepts.
func ChangeTypes() []string {
	out := make([]string, 0, len(handlers))
	for k := range handlers {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// MinRole returns the least role that may send a change type.
func MinRole(changeType string) (core.Role, bool) {
	h, ok := handlers[changeType]
	return h.min, ok
}
