// The page commands: write, remember and row.

package cli

import (
	"fmt"
	"strconv"
	"strings"
)

// linkWords escapes what would end a Markdown link's words early.
var linkWords = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`)

// write writes a page from stdin: a new one under the title given
// (write new TITLE), or the one named by its id.
func (r *runner) write(in input) error {
	markdown, err := readStdin()
	if err != nil {
		return err
	}
	a, err := argsFrom(in.f)
	if err != nil {
		return err
	}
	if in.pos[0] == "new" {
		title := strings.TrimSpace(strings.Join(in.pos[1:], " "))
		a["title"], a["markdown"] = title, markdown
		res, err := r.changed("doc.create", a, in.approval)
		if err == nil && !r.dry && !r.json {
			// What points a person at the page, ready to paste into a
			// comment or a result: they see its title, and open it.
			fmt.Fprintf(r.out, "link: [%s](doc:%s)\n", linkWords.Replace(title), res.Ref)
		}
		return err
	}
	a["doc"], a["markdown"] = in.pos[0], markdown
	return r.change("doc.write", a, in.approval)
}

// remember saves a note from stdin to the caller's memory.
func (r *runner) remember(in input) error {
	markdown, err := readStdin()
	if err != nil {
		return err
	}
	body := map[string]any{"title": strings.Join(in.pos, " "), "markdown": markdown}
	if m := in.f["mode"]; len(m) > 0 {
		body["mode"] = m[0]
	}
	out, err := r.send("POST", "/memory", nil, body, "")
	if err != nil {
		return err
	}
	said := "ok remembered"
	if r.dry {
		said = "would be accepted: remember"
	}
	fmt.Fprintln(r.out, said, strings.TrimSpace(string(out)))
	return nil
}

// row adds a row to a database: its title, and a value for each property
// named. true and false are taken as a yes or no, a number as a number.
func (r *runner) row(in input) error {
	props := map[string]any{}
	for k, vs := range in.f {
		v := vs[len(vs)-1]
		switch v {
		case "true", "false":
			props[k] = v == "true"
		default:
			if n, err := strconv.ParseFloat(v, 64); err == nil {
				props[k] = n
			} else {
				props[k] = v
			}
		}
	}
	return r.change("doc.create", map[string]any{"parent": in.pos[0], "title": strings.Join(in.pos[1:], " "), "props": props}, in.approval)
}
