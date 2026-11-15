// The table of change types, and register, which adds one.

package engine

import (
	"maps"
	"reflect"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
)

// handler is one kind of change.
type handler struct {
	min  core.Role    // the least role that may send it
	args reflect.Type // the struct its arguments are read into
	fn   func(*cx) error
}

var handlers = map[string]handler{}

// register adds a kind of change. Its arguments are read into an A before
// fn runs, and the catalog describes the change by A's fields.
func register[A any](name string, least core.Role, fn func(c *cx, a A) error) {
	handlers[name] = handler{min: least, args: reflect.TypeFor[A](), fn: func(c *cx) error {
		var a A
		if err := c.args(&a); err != nil {
			return err
		}
		return fn(c, a)
	}}
}

// ChangeTypes lists the changes the engine accepts.
func ChangeTypes() []string {
	return slices.Sorted(maps.Keys(handlers))
}

// MinRole returns the least role that may send a change type.
func MinRole(changeType string) (core.Role, bool) {
	h, ok := handlers[changeType]
	return h.min, ok
}
