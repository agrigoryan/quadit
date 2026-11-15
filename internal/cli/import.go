package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"github.com/agrigoryan/quadit/internal/importer"
)

// importFrom reads a source of another tool into a plan and makes what is
// in it. With --dry-run it stops at saying what was read.
func (r *runner) importFrom(in input) error {
	kind, source := in.pos[0], in.pos[1]
	opts := map[string]string{}
	for k, v := range in.f {
		opts[k] = v[len(v)-1]
	}
	plan, err := importer.Read(kind, source, opts)
	defer plan.Close()
	if err != nil {
		return err
	}
	if r.json && r.dry {
		raw, _ := json.Marshal(map[string]any{"dry_run": true, "read": map[string]int{"tasks": len(plan.Tasks), "pages": len(plan.Docs), "databases": len(plan.Tables)}})
		fmt.Fprintln(r.out, string(raw))
		return nil
	}
	if !r.json {
		fmt.Fprintf(r.out, "read %d tasks, %d pages, %d databases from %s\n", len(plan.Tasks), len(plan.Docs), len(plan.Tables), kind)
	}
	if r.dry {
		return nil
	}
	sum, err := importer.Apply(importer.NewSink(importAPI{r.c}, r.importLog), plan, opts["project"])
	if r.json {
		raw, _ := json.Marshal(map[string]any{"made": map[string]int{"tasks": sum.Tasks, "comments": sum.Comments, "pages": sum.Docs, "rows": sum.Rows, "files": sum.Files},
			"already_there": sum.Already, "unmatched_people": sum.Unmatched})
		fmt.Fprintln(r.out, string(raw))
		return err
	}
	fmt.Fprintln(r.out, sum)
	return err
}

// importAPI is the API as an import writes through it: as the caller,
// over the network.
type importAPI struct{ c *Client }

func (a importAPI) Call(method, path string, q url.Values, body []byte) ([]byte, error) {
	if body == nil {
		return a.c.do(method, path, q, nil, "", "application/json")
	}
	return a.c.do(method, path, q, bytes.NewReader(body), "application/json", "application/json")
}

func (a importAPI) SendFile(fileID, path string) (string, error) {
	_, u, err := a.c.UploadAs(fileID, path)
	return u, err
}

// importLog prints an import's notes and progress.
func (r *runner) importLog(format string, a ...any) {
	if r.json {
		fmt.Fprintf(os.Stderr, format+"\n", a...) // --json keeps standard output to the one JSON answer
		return
	}
	fmt.Fprintf(r.out, format+"\n", a...)
}
