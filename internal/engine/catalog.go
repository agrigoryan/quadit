package engine

import (
	"reflect"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
)

// ArgInfo describes one argument of a change.
type ArgInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// ChangeInfo describes one change type.
type ChangeInfo struct {
	Type string    `json:"type"`
	Role core.Role `json:"role"` // the least role that may send it
	Args []ArgInfo `json:"args"`
}

// Catalog lists every change the engine accepts with its arguments. The
// OpenAPI document, the MCP tool list and the command help are made from it.
func Catalog() []ChangeInfo {
	out := make([]ChangeInfo, 0, len(handlers))
	for name, h := range handlers {
		ci := ChangeInfo{Type: name, Role: h.min}
		if proto, ok := argTypes[name]; ok {
			ci.Args = argsOf(reflect.TypeOf(proto))
		}
		out = append(out, ci)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

func argsOf(t reflect.Type) []ArgInfo { return argsAt(t, 0) }

func argsAt(t reflect.Type, depth int) []ArgInfo {
	var out []ArgInfo
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name := strings.Split(f.Tag.Get("json"), ",")[0]
		if name == "" || name == "-" {
			continue
		}
		out = append(out, ArgInfo{Name: name, Type: typeAt(f.Type, depth)})
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
