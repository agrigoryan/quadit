// The WHERE builder the generic operations and the task, event
// and search reads share, and the placeholder helpers.

package sqlstore

import "strings"

// clause collects the conditions of a WHERE, joined with AND, and the
// values of their placeholders, in the order they appear.
type clause struct {
	parts []string
	args  []any
}

// add appends one condition and the values of its placeholders.
func (w *clause) add(cond string, args ...any) {
	w.parts = append(w.parts, cond)
	w.args = append(w.args, args...)
}

// sql is the conditions joined with AND; "1 = 1" when there are none.
func (w *clause) sql() string {
	if len(w.parts) == 0 {
		return "1 = 1"
	}
	return strings.Join(w.parts, " AND ")
}

// in adds "col IN (...)". An empty list selects nothing: "1 = 0".
func (w *clause) in(col string, vals []string) {
	if len(vals) == 0 {
		w.add("1 = 0")
		return
	}
	list, args := placeholdersFor(vals)
	w.add(col+" IN ("+list+")", args...)
}

// inIDs is in for an id column: values that are not ids are left out, as no
// row can hold them and Postgres refuses to compare them with a UUID.
func (w *clause) inIDs(col string, vals []string) { w.in(col, onlyIDs(vals)) }

// notIn adds "col NOT IN (...)". An empty list leaves everything in, so it
// adds nothing.
func (w *clause) notIn(col string, vals []string) {
	if len(vals) == 0 {
		return
	}
	list, args := placeholdersFor(vals)
	w.add(col+" NOT IN ("+list+")", args...)
}

// inOrNone is inIDs, joined with "or has none" when none is asked as well: a
// list filter of "nobody, or one of these" means either. With neither, it
// adds nothing.
func (w *clause) inOrNone(col string, vals []string, none bool) {
	keep := onlyIDs(vals)
	switch {
	case none && len(keep) == 0:
		w.add(col + " IS NULL")
	case none:
		list, args := placeholdersFor(keep)
		w.add("("+col+" IS NULL OR "+col+" IN ("+list+"))", args...)
	case len(vals) > 0:
		w.inIDs(col, vals)
	}
}

// onlyIDs keeps the values that look like ids.
func onlyIDs(vals []string) []string {
	var keep []string
	for _, v := range vals {
		if looksUUID(v) {
			keep = append(keep, v)
		}
	}
	return keep
}

// noID is a well-formed id that no row has.
const noID = "00000000-0000-0000-0000-000000000000"

// idOrNone returns v if it is an id, else an id no row has, so a bad
// reference selects nothing instead of failing on Postgres.
func idOrNone(v string) string {
	if looksUUID(v) {
		return v
	}
	return noID
}

// placeholders returns "?, ?, ?" for n values.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

// placeholdersFor returns "?, ?, ?" for the values, and the values as
// arguments.
func placeholdersFor(vals []string) (string, []any) {
	args := make([]any, len(vals))
	for i, v := range vals {
		args[i] = v
	}
	return placeholders(len(vals)), args
}
