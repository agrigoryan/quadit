// The render command: a picture of a task or a page.

package cli

import (
	"fmt"
	"net/http"
	"os"
)

// render saves a picture of a task or a page as a person sees it, in
// render.png or the file named with out=FILE.
func (r *runner) render(in input) error {
	q := readFilters(in.f)
	out := "render.png"
	if o := in.f["out"]; len(o) > 0 {
		out = o[0]
		q.Del("out")
	}
	if len(in.pos) > 0 {
		q.Set("task", in.pos[0])
	}
	png, err := r.c.workspaceRequest(r.ctx, apiRequest{method: http.MethodGet, path: "/render", query: q, accept: "image/png"})
	if err != nil {
		return err
	}
	if err := os.WriteFile(out, png, 0o644); err != nil {
		return err
	}
	fmt.Fprintln(r.out, out)
	if r.c.Note != "" {
		fmt.Fprintln(os.Stderr, "note: "+r.c.Note)
	}
	return nil
}
