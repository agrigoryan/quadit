package cli

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// write writes a page from stdin: a new one under the title given
// (write new TITLE), or the one named by its id.
func (r *runner) write(in input) error {
	raw, _ := io.ReadAll(os.Stdin)
	if in.pos[0] == "new" {
		a := argsFrom(in.f)
		a["title"], a["markdown"] = strings.Join(in.pos[1:], " "), string(raw)
		_, err := r.change("doc.create", a, in.approval)
		return err
	}
	a := argsFrom(in.f)
	a["doc"], a["markdown"] = in.pos[0], string(raw)
	_, err := r.change("doc.write", a, in.approval)
	return err
}

// remember saves a note from stdin to the caller's memory.
func (r *runner) remember(in input) error {
	raw, _ := io.ReadAll(os.Stdin)
	body := map[string]any{"title": strings.Join(in.pos, " "), "markdown": string(raw)}
	if m := in.f["mode"]; len(m) > 0 {
		body["mode"] = m[0]
	}
	out, err := r.send("POST", "/memory", nil, body, "")
	if err == nil {
		fmt.Fprintln(r.out, "ok remembered", strings.TrimSpace(string(out)))
	}
	return err
}

// row adds a row to a database: its title, and a value for each property
// named. true and false are taken as a yes or no, a number as a number.
func (r *runner) row(in input) error {
	props := map[string]any{}
	for k, vs := range in.f {
		v := vs[len(vs)-1]
		switch {
		case v == "true" || v == "false":
			props[k] = v == "true"
		default:
			if n, err := strconv.ParseFloat(v, 64); err == nil {
				props[k] = n
			} else {
				props[k] = v
			}
		}
	}
	_, err := r.change("doc.create", map[string]any{"parent": in.pos[0], "title": strings.Join(in.pos[1:], " "), "props": props}, in.approval)
	return err
}
