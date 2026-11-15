package cli

import (
	"encoding/json"
	"fmt"
	"strings"
)

// do sends any change by its type: its arguments as a JSON object, as
// field=value, or both, where a field=value wins.
func (r *runner) do(in input) error {
	a := map[string]any{}
	if len(in.pos) > 1 {
		if err := json.Unmarshal([]byte(strings.Join(in.pos[1:], " ")), &a); err != nil {
			return fmt.Errorf("the arguments must be a JSON object, like '{\"id\":\"SVA-12\",\"title\":\"New title\"}'; what was given is not one")
		}
	}
	for k, v := range argsFrom(in.f) {
		a[k] = v
	}
	_, err := r.change(in.pos[0], a, in.approval)
	return err
}
