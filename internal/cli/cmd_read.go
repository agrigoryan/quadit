package cli

import (
	"fmt"
	"net/url"
	"strings"
)

// Most of orient and find, and the reads of the other groups, are one
// address of the API printed as it answers. Those commands are made here
// from their address alone.

// reads makes a command that prints one address. A %s in the address
// stands for the command's first argument.
func reads(path string) func(*runner, input) error {
	return func(r *runner, in input) error {
		return r.get(address(path, in), nil)
	}
}

// readsWithFilters makes a command that prints one address, with the
// field=value arguments sent along as filters.
func readsWithFilters(path string) func(*runner, input) error {
	return func(r *runner, in input) error {
		return r.get(address(path, in), query(in.f))
	}
}

func address(path string, in input) string {
	if !strings.Contains(path, "%s") {
		return path
	}
	return fmt.Sprintf(path, url.PathEscape(in.pos[0]))
}

// search looks for the words given, all of them as one text.
func (r *runner) search(in input) error {
	q := query(in.f)
	q.Set("q", strings.Join(in.pos, " "))
	return r.get("/search", q)
}
