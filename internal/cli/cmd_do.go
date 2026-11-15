// The do command: any change by its type.

package cli

import (
	"encoding/json"
	"errors"
	"maps"
	"strings"
)

// do sends any change by its type: its arguments as a JSON object, as
// field=value, or both, where a field=value wins.
func (r *runner) do(in input) error {
	a := map[string]any{}
	if len(in.pos) > 1 {
		if err := json.Unmarshal([]byte(strings.Join(in.pos[1:], " ")), &a); err != nil {
			return errors.New("the arguments must be a JSON object, like '{\"id\":\"SVA-12\",\"title\":\"New title\"}'; what was given is not one")
		}
	}
	fields, err := argsFrom(in.f)
	if err != nil {
		return err
	}
	maps.Copy(a, fields)
	return r.change(in.pos[0], a, in.approval)
}
