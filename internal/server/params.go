package server

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
)

// Parameters that are whole numbers, and ones that are yes or no, wherever
// they appear. A value of another kind is refused: reading "after=abc" as
// "from the start" would hand a caller the whole feed for a typing mistake.
var (
	numberParams = []string{"after", "before", "wait", "limit", "offset", "since", "max_chars", "width", "height", "seq",
		"changed_since", "updated_since", "base_seq"}
	yesNoParams = []string{"count", "raw", "full", "trash", "archived", "mine", "others", "watching", "top_level",
		"has_open_decision", "dry_run", "events", "open"}
)

func checkParams(v url.Values) error {
	for _, name := range numberParams {
		if !v.Has(name) || v.Get(name) == "" {
			continue
		}
		n, err := strconv.ParseInt(v.Get(name), 10, 64)
		if err != nil {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " takes a whole number, and was given " + strconv.Quote(v.Get(name))}
		}
		if n < 0 && name != "since" && name != "after" {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: name + " cannot be less than 0"}
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
