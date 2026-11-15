package server

import (
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/engine"
)

// Parameters that are whole numbers, and ones that are yes or no, wherever
// they appear. A value of another kind is refused: reading "after=abc" as
// "from the start" would hand a caller the whole feed for a typing mistake.
var (
	numberParams = []string{"after", "before", "wait", "limit", "offset", "since", "max_chars", "width", "height", "seq",
		"changed_since", "updated_since", "base_seq"}
	yesNoParams = []string{"count", "raw", "full", "trash", "archived", "mine", "others", "watching", "top_level",
		"has_open_decision", "dry_run", "events", "open", "all", "compact", "inbox"}
	dateParams = []string{"due_before", "due_after"}
)

// checkParams refuses a URL whose number, yes/no or date parameters do not
// read as one: a number must be a whole number of 0 or more, a yes/no one
// of 1, 0, true, false, yes, no (or empty), and a date YYYY-MM-DD. Every
// workspace route runs it (workspaceMember).
func checkParams(v url.Values) error {
	for _, name := range numberParams {
		if !v.Has(name) || v.Get(name) == "" {
			continue
		}
		n, err := strconv.ParseInt(v.Get(name), 10, 64)
		if err != nil {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " takes a whole number, and was given " + strconv.Quote(v.Get(name))}
		}
		if n < 0 {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " cannot be less than 0"}
		}
	}
	for _, name := range dateParams {
		if v.Get(name) == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", v.Get(name)); err != nil {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " takes a date like 2026-03-31, and was given " + strconv.Quote(v.Get(name))}
		}
	}
	for _, name := range yesNoParams {
		if !v.Has(name) {
			continue
		}
		switch strings.ToLower(v.Get(name)) {
		case "", "1", "0", "true", "false", "yes", "no":
		default:
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " takes 1 or 0 (or true, false), and was given " + strconv.Quote(v.Get(name))}
		}
	}
	return nil
}
