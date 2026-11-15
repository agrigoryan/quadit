// Package plainjson encodes plain values as JSON without an error to
// handle: the program's own structs, maps and slices of strings, numbers
// and bools, and what was decoded from JSON (a map[string]any of a
// request, a json.RawMessage the decoder checked). Such values always
// encode, so json.Marshal's error has nothing to report for them. A value
// of a type the program does not own (a library's) is encoded with
// json.Marshal and its error checked.
package plainjson

import (
	"encoding/json"
	"fmt"
)

// Marshal is v as JSON. A v that does not encode (a channel, a function, a
// NaN, a json.RawMessage that is not JSON) is a mistake in the caller, and
// Marshal panics with the reason instead of returning nothing: nothing
// would be stored or sent as if it were the value, and the mistake would
// go unseen.
func Marshal(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("plainjson: a %T does not encode: %v", v, err))
	}
	return raw
}
