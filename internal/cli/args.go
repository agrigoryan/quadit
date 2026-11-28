// The arguments of a command: switches, field=value arguments and the
// values the API takes for them.

package cli

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
)

// switches are what every command takes beside its own arguments.
type switches struct {
	json     bool   // --json: the full data
	dry      bool   // --dry-run: check a write without making it
	changeID string // --id=UUID: the id the change is sent with
	actFor   string // --for=@WHO: the member the change is made for
	// workspace is --workspace=W: the workspace the command works in, of
	// those the tool is connected to (login_choice.go).
	workspace string
}

// takeSwitches splits the switches from everything else that was typed.
func takeSwitches(args []string) (sw switches, rest []string) {
	for i, a := range args {
		// After "--" (run --secret X -- command) or "--exec" (listen --exec
		// command) everything is the command's, its own switches too.
		if a == "--" || a == "--exec" {
			rest = append(rest, args[i:]...)
			break
		}
		switch {
		case a == "--json":
			sw.json = true
		case a == "--dry-run":
			sw.dry = true
		case strings.HasPrefix(a, "--id="):
			sw.changeID = strings.TrimPrefix(a, "--id=")
		case strings.HasPrefix(a, "--for="):
			sw.actFor = strings.TrimPrefix(a, "--for=")
		case strings.HasPrefix(a, "--workspace="):
			sw.workspace = strings.TrimPrefix(a, "--workspace=")
		default:
			rest = append(rest, a)
		}
	}
	return
}

// input is one command as it was typed.
type input struct {
	name string              // the name it was called by; an alias stays as typed
	rest []string            // everything after the name, as given
	pos  []string            // the arguments that are not field=value
	f    map[string][]string // the field=value arguments
	// approval is the decision a change is sent under (approval=ID). It is
	// not one of the fields.
	approval string
}

// readInput reads what was typed after a command's name.
func readInput(name string, rest []string) input {
	pos, f := splitFields(rest)
	approval := ""
	if a := f["approval"]; len(a) > 0 {
		approval = a[0]
		delete(f, "approval")
	}
	return input{name: name, rest: rest, pos: pos, f: f, approval: approval}
}

// priorities are the priority names a command takes, and the number the
// API takes for each.
var priorities = map[string]int{"none": 0, "urgent": 1, "high": 2, "medium": 3, "low": 4}

// listKeys, intKeys and boolKeys are the fields whose value is sent as a
// list (written a,b,c), a number or a yes or no; any other is sent as text.
var (
	listKeys = map[string]bool{"labels": true, "add_labels": true, "remove_labels": true, "event_types": true}
	intKeys  = map[string]bool{"priority": true, "estimate": true, "base_seq": true, "minutes": true, "recommended": true,
		"occurrence": true, "start": true, "end": true}
	boolKeys = map[string]bool{"archived": true, "resolved": true, "active": true, "shared": true}
)

// splitFields splits "field=value" arguments from positional ones.
func splitFields(args []string) (pos []string, fields map[string][]string) {
	fields = map[string][]string{}
	for _, a := range args {
		if k, v, ok := asField(a); ok {
			fields[k] = append(fields[k], v)
			continue
		}
		pos = append(pos, a)
	}
	return
}

// asField reads one argument as field=value; ok is false for a positional
// one (a path or a URL with = in it is positional).
func asField(a string) (key, value string, ok bool) {
	if i := strings.Index(a, "="); i > 0 && !strings.ContainsAny(a[:i], " \t\n/:") {
		return a[:i], a[i+1:], true
	}
	return "", "", false
}

// field is one field=value argument.
type field struct{ key, value string }

// fieldsInOrder gives the field=value arguments in the order they were
// typed, for a command where that order says what belongs to what.
func fieldsInOrder(args []string) []field {
	var out []field
	for _, a := range args {
		if k, v, ok := asField(a); ok {
			out = append(out, field{k, v})
		}
	}
	return out
}

// nobody are the words that name no member, where a member is asked for,
// and no estimate.
var nobody = map[string]bool{"": true, "none": true, "nobody": true, "-": true}

// apiValue turns a command-line value into what the API takes.
func apiValue(key, v string) any {
	switch {
	case v == "null":
		return nil
	case (key == "assignee" || key == "estimate") && nobody[strings.ToLower(v)]:
		return nil
	case key == "priority":
		if n, ok := priorities[strings.ToLower(v)]; ok {
			return n
		}
	case listKeys[key]:
		if v == "" {
			return []string{}
		}
		return strings.Split(v, ",")
	case boolKeys[key]:
		switch strings.ToLower(v) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
		return v // neither: the server says what the field takes
	}
	if intKeys[key] {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return v
}

// argsFrom turns the field=value arguments into a change's arguments,
// leaving out the fields a command reads itself. Of a field given twice,
// the last value counts; description=- and body=- are read from stdin.
func argsFrom(fields map[string][]string, skip ...string) (map[string]any, error) {
	out := map[string]any{}
	for k, vs := range fields {
		if slices.Contains(skip, k) {
			continue
		}
		v := vs[len(vs)-1]
		if v == "-" && (k == "description" || k == "body") {
			var err error
			if v, err = readStdin(); err != nil {
				return nil, fmt.Errorf("%s=-: %w", k, err)
			}
		}
		out[k] = apiValue(k, v)
	}
	return out, nil
}

// readStdin reads all of standard input, for a value given as "-" or a
// command that takes its text from there.
func readStdin() (string, error) {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", fmt.Errorf("reading standard input: %w", err)
	}
	return string(raw), nil
}

// readFilters turns the field=value arguments into the filters of a read.
func readFilters(fields map[string][]string) url.Values {
	q := url.Values{}
	for k, vs := range fields {
		q.Set(k, strings.Join(vs, ","))
	}
	return q
}

// firstValue is the first value given for a field, or nothing.
func firstValue(vals []string) string {
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}
