// Command webtypes writes the web app's types that are generated from the
// server, from the repository root:
//
//   - web/src/types/changes.gen.ts, the changes the engine accepts, from the
//     Go structs each change reads its arguments into (changes.go);
//   - web/src/types/rows.gen.ts, the rows the server sends as stored, from
//     the row structs of package core (rows.go). The app does not use it:
//     web/src/types/rows.check.ts holds the hand-written wire types to it.
//
// Run it after changing a change's arguments or a row:
//
//	make generate
//
// A test in this package fails while a checked-in file differs.
package main

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
)

// files are the files written, from the repository root, with what each
// holds.
var files = map[string]func() string{
	"web/src/types/changes.gen.ts": changesSource,
	"web/src/types/rows.gen.ts":    rowsSource,
}

func main() {
	for target, source := range files {
		if err := os.WriteFile(target, []byte(source()), 0o644); err != nil { //nolint:gosec // a source file, read by everyone
			fmt.Fprintln(os.Stderr, "webtypes:", err)
			os.Exit(1)
		}
	}
}

// writer turns Go types into TypeScript, remembering the named structs it
// met so that each is written once (and a block that holds blocks can be).
//
// It writes a struct one of two ways. As a change's arguments, the JSON the
// server reads: a field may be left out unless the change requires it, and
// a pointer or an engine.Opt may be null. As a row (rows), the JSON the
// server writes: a field is left out only when encoding/json leaves it out
// (omitempty, on what is not a struct) or it is a pointer; a pointer,
// slice or map that is not left out may be null.
type writer struct {
	named map[string]reflect.Type
	rows  bool
}

// writeNamed writes each named struct met so far once, in name order, as
// an exported interface. Writing one may meet more, so it goes on until
// none is left.
func (w *writer) writeNamed(b *strings.Builder) {
	bodies := map[string]string{}
	for len(bodies) < len(w.named) {
		for _, name := range slices.Sorted(maps.Keys(w.named)) {
			if _, ok := bodies[name]; !ok {
				bodies[name] = w.object(w.named[name], 0, false)
			}
		}
	}
	for _, name := range slices.Sorted(maps.Keys(bodies)) {
		fmt.Fprintf(b, "\nexport interface %s %s\n", name, bodies[name])
	}
}

var rawJSON = reflect.TypeFor[json.RawMessage]()

// object is a struct's fields as a TypeScript object type, at an indent of
// depth. At the top of a change's arguments (top) a priority may be a name.
func (w *writer) object(t reflect.Type, depth int, top bool) string {
	fields := w.fields(t, depth, top)
	if len(fields) == 0 {
		return "Record<string, never>"
	}
	pad := strings.Repeat("  ", depth)
	return "{\n" + strings.Join(fields, "") + pad + "}"
}

// fields are a struct's fields as encoding/json reads them: by their json
// name, or their Go name when untagged, with an embedded struct's fields
// taken in as its own.
func (w *writer) fields(t reflect.Type, depth int, top bool) []string {
	var out []string
	pad := strings.Repeat("  ", depth+1)
	for f := range t.Fields() {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "-" || !f.IsExported() && !f.Anonymous {
			continue
		}
		if f.Anonymous && name == "" && deref(f.Type).Kind() == reflect.Struct {
			out = append(out, w.fields(deref(f.Type), depth, top)...)
			continue
		}
		if name == "" {
			name = f.Name
		}
		if w.rows {
			out = append(out, w.rowField(f, name, pad, depth))
			continue
		}
		typ := w.typeOf(f.Type, depth+1)
		if top && name == "priority" && isPriority(f.Type) {
			typ = strings.Replace(typ, "number", "number | PriorityName", 1)
		}
		// Required holds only for a change's own arguments: the same struct
		// inside another (a template's preset decision) is filled in later.
		optional := "?"
		if top && engine.Required(f) {
			optional = ""
		}
		out = append(out, fmt.Sprintf("%s%s%s: %s;\n", pad, key(name), optional, typ))
	}
	return out
}

// rowField is one field of a row as encoding/json writes it.
func (w *writer) rowField(f reflect.StructField, name, pad string, depth int) string {
	omitEmpty := slices.Contains(strings.Split(f.Tag.Get("json"), ",")[1:], "omitempty")
	t, optional := f.Type, ""
	if t.Kind() == reflect.Pointer || omitEmpty && t.Kind() != reflect.Struct {
		optional = "?"
	}
	typ := w.typeOf(t, depth+1)
	switch {
	case t.Kind() == reflect.Pointer && omitEmpty:
		typ = w.typeOf(t.Elem(), depth+1) // a nil one is left out, never null
	case !omitEmpty && (t.Kind() == reflect.Map || t.Kind() == reflect.Slice && t != rawJSON):
		typ = nullable(typ) // a nil one is written as null
	}
	return fmt.Sprintf("%s%s%s: %s;\n", pad, key(name), optional, typ)
}

// typeOf names a Go type the way the server reads and writes its JSON.
func (w *writer) typeOf(t reflect.Type, depth int) string {
	if inner, ok := optional(t); ok {
		return nullable(w.typeOf(inner, depth))
	}
	if t == rawJSON {
		return "unknown"
	}
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Interface:
		return "unknown"
	case reflect.Pointer:
		return nullable(w.typeOf(t.Elem(), depth))
	case reflect.Slice, reflect.Array:
		if t.Elem().Kind() == reflect.Uint8 {
			return "string" // bytes travel as base64
		}
		elem := w.typeOf(t.Elem(), depth)
		if strings.Contains(elem, " | ") && !strings.HasPrefix(elem, "{") {
			elem = "(" + elem + ")"
		}
		return elem + "[]"
	case reflect.Map:
		if t.Key().Kind() != reflect.String {
			panic("webtypes: a map with keys that are not strings: " + t.String())
		}
		return "Record<string, " + w.typeOf(t.Elem(), depth) + ">"
	case reflect.Struct:
		if t.Name() == "" {
			return w.object(t, depth, false)
		}
		name := exported(t.Name())
		if seen, ok := w.named[name]; ok && seen != t {
			panic("webtypes: two types are both named " + name + ": " + seen.String() + " and " + t.String())
		}
		w.named[name] = t
		return name
	}
	panic("webtypes: no TypeScript for the type " + t.String())
}

// optional reports whether t is the engine's Opt[T] (absent, null, or a
// value), and its T.
func optional(t reflect.Type) (reflect.Type, bool) {
	if t.Kind() != reflect.Struct || t.PkgPath() != reflect.TypeFor[engine.Opt[int]]().PkgPath() ||
		!strings.HasPrefix(t.Name(), "Opt[") {
		return nil, false
	}
	f, _ := t.FieldByName("V")
	return f.Type, true
}

// isPriority reports whether t holds a number, which the engine also takes
// as a priority's name (see engine.PriorityNames).
func isPriority(t reflect.Type) bool {
	if inner, ok := optional(t); ok {
		t = inner
	}
	switch deref(t).Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return true
	}
	return false
}

func deref(t reflect.Type) reflect.Type {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

// nullable adds null to a type, unless it already takes anything.
func nullable(ts string) string {
	if ts == "unknown" || strings.HasSuffix(ts, " | null") {
		return ts
	}
	return ts + " | null"
}

// key quotes a property name only where TypeScript needs it, as Prettier does.
func key(name string) string {
	if bareName.MatchString(name) {
		return name
	}
	return fmt.Sprintf("%q", name)
}

var bareName = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

func exported(name string) string {
	return strings.ToUpper(name[:1]) + name[1:]
}
