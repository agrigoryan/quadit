package cli

import (
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// switches are what every command takes beside its own arguments.
type switches struct {
	json     bool   // --json: the full data
	dry      bool   // --dry-run: check a write without making it
	changeID string // --id=UUID: the id the change is sent with
	actFor   string // --for=@WHO: the member the change is made for
}

// takeSwitches splits the switches from everything else that was typed.
func takeSwitches(args []string) (sw switches, rest []string) {
	for i, a := range args {
		// After "--" (run --secret X -- command) everything is the command's.
		if a == "--" {
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

func readInput(name string, rest []string) input {
	pos, f := kv(rest)
	approval := ""
	if a := f["approval"]; len(a) > 0 {
		approval = a[0]
		delete(f, "approval")
	}
	return input{name: name, rest: rest, pos: pos, f: f, approval: approval}
}

var priorities = map[string]int{"none": 0, "urgent": 1, "high": 2, "medium": 3, "low": 4}
var listKeys = map[string]bool{"labels": true, "add_labels": true, "remove_labels": true, "event_types": true}
var intKeys = map[string]bool{"priority": true, "estimate": true, "base_seq": true, "minutes": true, "recommended": true}
var boolKeys = map[string]bool{"archived": true, "resolved": true, "active": true, "shared": true}

// kv splits "field=value" arguments from positional ones.
func kv(args []string) (pos []string, fields map[string][]string) {
	fields = map[string][]string{}
	for _, a := range args {
		if i := strings.Index(a, "="); i > 0 && !strings.ContainsAny(a[:i], " \t\n/:") {
			fields[a[:i]] = append(fields[a[:i]], a[i+1:])
			continue
		}
		pos = append(pos, a)
	}
	return
}

// value turns a command-line value into what the API takes.
func value(key, v string) any {
	switch {
	case v == "null":
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
// leaving out the fields a command reads itself.
func argsFrom(fields map[string][]string, skip ...string) map[string]any {
	out := map[string]any{}
	for k, vs := range fields {
		skipIt := false
		for _, s := range skip {
			skipIt = skipIt || s == k
		}
		if skipIt {
			continue
		}
		v := vs[len(vs)-1]
		if v == "-" && (k == "description" || k == "body") {
			raw, _ := io.ReadAll(os.Stdin)
			v = string(raw)
		}
		out[k] = value(k, v)
	}
	return out
}

// query turns the field=value arguments into the filters of a read.
func query(fields map[string][]string) url.Values {
	q := url.Values{}
	for k, vs := range fields {
		q.Set(k, strings.Join(vs, ","))
	}
	return q
}

// first is the first value given for a field, or nothing.
func first(vals []string) string {
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}
