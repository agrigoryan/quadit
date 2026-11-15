package importer

import (
	"fmt"
	"strings"
)

// Source reads one kind of export or service into a Plan. Each source is
// in its own file; adding one means writing that file and naming it in
// sources below.
type Source interface {
	// Kind is the name the source is asked for by: "linear", "orbit".
	Kind() string
	// Read turns what is at source (a file, a folder, an address) into a plan.
	Read(source string, opts Options) (Plan, error)
}

// Options carries what a source needs beyond its path or address: a token,
// a workspace.
type Options map[string]string

var sources = []Source{
	linear{},
	trello{},
	asana{},
	github{},
	folder{kind: "markdown"},
	folder{kind: "obsidian"},
	notion{},
	orbit{},
}

// Kinds lists what can be imported.
var Kinds = func() []string {
	var out []string
	for _, s := range sources {
		out = append(out, s.Kind())
	}
	return out
}()

// Read turns a source into a plan. A read that fails leaves nothing behind:
// what it had copied to this machine is removed, so only a plan read
// without an error needs closing.
func Read(kind, source string, opts map[string]string) (Plan, error) {
	for _, s := range sources {
		if s.Kind() == kind {
			plan, err := s.Read(source, opts)
			if err != nil {
				plan.Close()
				return Plan{}, err
			}
			return plan, nil
		}
	}
	return Plan{}, fmt.Errorf("unknown source %q; sources are: %s", kind, strings.Join(Kinds, ", "))
}
