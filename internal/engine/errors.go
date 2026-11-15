package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// Error codes. Every refusal has one, so a caller can branch without reading
// the message.
const (
	CodeInvalid       = "invalid"        // the change itself is wrong; fix it and resend
	CodeForbidden     = "forbidden"      // the actor may not do this
	CodeNotFound      = "not_found"      // something the change refers to does not exist
	CodeConflict      = "conflict"       // it collides with what is there (a taken key, an answered decision)
	CodeStale         = "stale"          // it was based on an older version than the current one
	CodeNeedsApproval = "needs_approval" // allowed only with an approved decision
	CodeBudget        = "budget_exceeded"
)

// Error is a refusal that tells the caller how to fix the change.
type Error struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Field   string   `json:"field,omitempty"`
	Allowed []string `json:"allowed,omitempty"` // the values that would have been accepted
	Nearest string   `json:"nearest,omitempty"` // the allowed value closest to what was sent
	// Index is the position of the refused change in a batch.
	Index int `json:"index,omitempty"`
	// cause is the store's error behind the refusal, so that a caller who
	// knows better what was taken can still say so.
	cause error
}

func (e *Error) Unwrap() error { return e.cause }

func (e *Error) Error() string {
	msg := e.Code + ": " + e.Message
	if e.Nearest != "" {
		msg += " (did you mean " + e.Nearest + "?)"
	} else if len(e.Allowed) > 0 {
		msg += " (allowed: " + strings.Join(e.Allowed, ", ") + ")"
	}
	return msg
}

func invalid(field, format string, a ...any) *Error {
	return &Error{Code: CodeInvalid, Field: field, Message: fmt.Sprintf(format, a...)}
}

func forbidden(format string, a ...any) *Error {
	return &Error{Code: CodeForbidden, Message: fmt.Sprintf(format, a...)}
}

func conflictErr(format string, a ...any) *Error {
	return &Error{Code: CodeConflict, Message: fmt.Sprintf(format, a...)}
}

func notFound(what, ref string) *Error {
	return &Error{Code: CodeNotFound, Message: fmt.Sprintf("%s %q does not exist in this workspace", what, ref)}
}

// oneOf refuses a value that is not in a fixed set, naming the set and the
// nearest match.
func oneOf(field, what, got string, allowed []string) *Error {
	return &Error{Code: CodeInvalid, Field: field, Message: fmt.Sprintf("unknown %s %q", what, got),
		Allowed: allowed, Nearest: nearest(got, allowed)}
}

// missing turns a store "not found" into a refusal naming what was missing.
func missing(err error, what, ref string) error {
	if errors.Is(err, store.ErrNotFound) {
		return notFound(what, ref)
	}
	return err
}

// found answers "is the row there?" from the error of a store read: false
// for not found, and any other error returned, so that a read that failed
// is never taken for a row that is absent.
func found(err error) (bool, error) {
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}

// isRefusal reports whether err is a refusal: the answer that a reference
// names nothing usable, as opposed to a failure to read.
func isRefusal(err error) bool {
	var e *Error
	return errors.As(err, &e)
}

// alreadyInUse turns a broken uniqueness rule into a refusal naming what was
// asked for. The refusal still is the store's conflict underneath, so a
// handler around a generic write (save names only the row) can name the
// value instead.
func alreadyInUse(err error, what, value string) error {
	if errors.Is(err, store.ErrConflict) {
		e := conflictErr("%s %q is already in use", what, value)
		e.cause = err
		return e
	}
	return err
}

func withIndex(i int, e *Error) *Error {
	cp := *e
	cp.Index = i
	return &cp
}

// PlainJSON says what was wrong with a JSON body in a caller's words, with
// none of the decoder's own vocabulary.
func PlainJSON(err error) string {
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) {
		field := te.Field
		if i := strings.LastIndex(field, "."); i >= 0 && !strings.Contains(field, "[") {
			field = field[i+1:]
		}
		if field == "" {
			return fmt.Sprintf("it takes %s, and was given %s", jsonTakes(te), jsonGiven(te.Value))
		}
		return fmt.Sprintf("%s takes %s, and was given %s", field, jsonTakes(te), jsonGiven(te.Value))
	}
	msg := strings.TrimPrefix(err.Error(), "json: ")
	if name, ok := strings.CutPrefix(msg, "unknown field "); ok {
		return "there is no field " + name
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "the JSON is empty or cut short"
	}
	return "this is not JSON that can be read: " + msg
}

// jsonKind says, in a caller's words, what a field takes.
func jsonKind(t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.String:
		return "text"
	case reflect.Bool:
		return "true or false"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.Slice, reflect.Array:
		return "a list ([…])"
	case reflect.Map, reflect.Struct:
		return "an object ({…})"
	}
	return "another kind of value"
}

// jsonTakes is jsonKind, exact about whole numbers when a fraction was sent.
func jsonTakes(te *json.UnmarshalTypeError) string {
	t := te.Type
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if k := t.Kind(); k >= reflect.Int && k <= reflect.Uint64 && strings.HasPrefix(te.Value, "number") {
		return "a whole number"
	}
	return jsonKind(te.Type)
}

func jsonGiven(v string) string {
	if n, ok := strings.CutPrefix(v, "number "); ok {
		return n
	}
	switch v {
	case "string":
		return "text"
	case "number":
		return "a number"
	case "bool":
		return "true or false"
	case "array":
		return "a list"
	case "object":
		return "an object"
	}
	return v
}
