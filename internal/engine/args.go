// Reading a change's arguments strictly, with priorities by name.

package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strconv"
	"strings"
)

// idArgs are the arguments of a change that names one row by its id.
type idArgs struct {
	ID string `json:"id" quadit:"required,handler"`
}

// args decodes the change's arguments into v, a pointer to the change's
// argument struct. Unknown fields are refused, so a misspelled field is an
// error and not a silent no-op; so is a required argument left out (see
// Required).
func (c *cx) args(v any) error {
	raw := c.change.Args
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	raw, err := namedPriority(raw)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return c.argsRefusal(v, err)
	}
	s := reflect.ValueOf(v).Elem()
	for i := range s.NumField() {
		f := s.Type().Field(i)
		if required, byHandler := requiredTag(f); required && !byHandler && s.Field(i).IsZero() {
			name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			return invalid(name, "%s is required", name)
		}
	}
	return nil
}

// Required reports whether a change's argument must be sent: whether a
// change without it is always refused. Its struct field is tagged
// quadit:"required", and the engine then refuses the change before its
// handler runs, with "<name> is required". A field tagged
// quadit:"required,handler" is just as required, but its handler refuses it
// itself: in words of its own ("a label needs a name"), or after checks that
// come first, whose order callers see. An argument needed only sometimes
// (one of two, or only with another) is not tagged.
func Required(f reflect.StructField) bool {
	required, _ := requiredTag(f)
	return required
}

func requiredTag(f reflect.StructField) (required, byHandler bool) {
	opts := strings.Split(f.Tag.Get("quadit"), ",")
	return opts[0] == "required", slices.Contains(opts[1:], "handler")
}

// argsRefusal says in a caller's words what was wrong with the arguments:
// a field the change does not have, or a value of the wrong kind.
func (c *cx) argsRefusal(v any, err error) error {
	if name, ok := strings.CutPrefix(err.Error(), "json: unknown field "); ok {
		name = strings.Trim(name, `"`)
		allowed := jsonFields(v)
		return &Error{Code: CodeInvalid, Field: name, Message: fmt.Sprintf("%s has no field %q", c.change.Type, name),
			Allowed: allowed, Nearest: nearest(name, allowed)}
	}
	te, ok := errors.AsType[*json.UnmarshalTypeError](err)
	if !ok {
		return invalid("args", "%s: %v", c.change.Type, err)
	}
	field := te.Field
	if i := strings.LastIndex(field, "."); i >= 0 && !strings.Contains(field, "[") {
		field = field[i+1:]
	}
	field = strings.TrimSuffix(strings.TrimSuffix(field, ".V"), ".Value")
	if field == "" || field == "V" || field == "Value" {
		return &Error{Code: CodeInvalid, Field: "args", Message: fmt.Sprintf("%s: its arguments are %s, and %s was given", c.change.Type, jsonKind(te.Type), jsonGiven(te.Value)),
			Allowed: jsonFields(v)}
	}
	return &Error{Code: CodeInvalid, Field: field, Message: fmt.Sprintf("%s: %s takes %s, and was given %s", c.change.Type, field, jsonTakes(te), jsonGiven(te.Value)),
		Allowed: jsonFields(v)}
}

// PriorityNames are a priority's names, by its number.
var PriorityNames = []string{"none", "urgent", "high", "medium", "low"}

// namedPriority lets a priority be written by name ("high") as well as by
// number, and says what the names are when one is misspelled.
func namedPriority(raw json.RawMessage) (json.RawMessage, error) {
	if !bytes.Contains(raw, []byte(`"priority"`)) {
		return raw, nil
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(raw, &args); err != nil {
		return raw, nil //nolint:nilerr // not an object: the strict decoder after this refuses it in a caller's words
	}
	var name string
	if err := json.Unmarshal(args["priority"], &name); err != nil {
		return raw, nil //nolint:nilerr // a number, or null: as it is
	}
	for n, known := range PriorityNames {
		if strings.EqualFold(strings.TrimSpace(name), known) {
			args["priority"] = json.RawMessage(strconv.Itoa(n))
			return json.Marshal(args)
		}
	}
	return nil, &Error{Code: CodeInvalid, Field: "priority", Message: fmt.Sprintf("unknown priority %q", name),
		Allowed: PriorityNames, Nearest: nearest(name, PriorityNames)}
}
