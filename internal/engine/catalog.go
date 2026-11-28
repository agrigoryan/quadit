// The catalog of change types and their arguments, for callers.

package engine

import (
	"reflect"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// ArgInfo describes one argument of a change.
type ArgInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Required bool   `json:"required,omitempty"` // the change is always refused without it
}

// ChangeInfo describes one change type.
type ChangeInfo struct {
	Type string    `json:"type"`
	Role core.Role `json:"role"` // the least role that may send it
	Args []ArgInfo `json:"args"`
}

// Surface is the version of what agents are built against: the change
// types and their arguments, the API's paths, the MCP tools and the
// command-line tool's commands. Within a major version things are only
// added; anything removed or renamed, a value an argument took among them,
// raises the major version. A test holds the names to this (see
// testdata/surface.txt); a value is held to it by whoever removes it.
const Surface = "3.0"

// Catalog lists every change the engine accepts with its arguments. The
// OpenAPI document, the MCP tool list and the command help are made from it.
// The arguments are those of the struct each change was registered with.
func Catalog() []ChangeInfo {
	out := make([]ChangeInfo, 0, len(handlers))
	for name, h := range handlers {
		out = append(out, ChangeInfo{Type: name, Role: h.min, Args: argsOf(h.args)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

func argsOf(t reflect.Type) []ArgInfo { return argsAt(t, 0) }

func argsAt(t reflect.Type, depth int) []ArgInfo {
	var out []ArgInfo
	for f := range t.Fields() {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		out = append(out, ArgInfo{Name: name, Type: typeAt(f.Type, depth), Required: Required(f)})
	}
	return out
}

// typeAt names a Go type the way a caller writes its JSON. A type that
// holds itself (a block with nested blocks) is named, not unfolded forever.
func typeAt(t reflect.Type, depth int) string {
	if strings.HasPrefix(t.Name(), "Opt[") {
		return typeAt(t.Field(2).Type, depth) + "|null"
	}
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int64, reflect.Int32:
		return "integer"
	case reflect.Float64:
		return "number"
	case reflect.Pointer:
		return typeAt(t.Elem(), depth)
	case reflect.Slice:
		if t.Elem().Kind() == reflect.Uint8 {
			return "json"
		}
		return "[" + typeAt(t.Elem(), depth) + "]"
	case reflect.Struct:
		if depth >= 2 {
			return "{" + strings.ToLower(t.Name()) + "}"
		}
		var parts []string
		for _, a := range argsAt(t, depth+1) {
			parts = append(parts, a.Name+": "+a.Type)
		}
		return "{" + strings.Join(parts, ", ") + "}"
	case reflect.Interface:
		return "any"
	}
	return t.Kind().String()
}
