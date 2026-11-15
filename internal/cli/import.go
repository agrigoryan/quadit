// The import command: bringing work in from other tools.

package cli

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/agrigoryan/quadit/internal/importer"
	"github.com/agrigoryan/quadit/internal/plainjson"
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
	if err != nil {
		return err
	}
	defer plan.Close()
	if r.json && r.dry {
		raw := plainjson.Marshal(map[string]any{"dry_run": true, "read": map[string]int{"tasks": len(plan.Tasks), "pages": len(plan.Docs), "databases": len(plan.Tables)}})
		fmt.Fprintln(r.out, string(raw))
		return nil
	}
	if !r.json {
		fmt.Fprintf(r.out, "read %d tasks, %d pages, %d databases from %s\n", len(plan.Tasks), len(plan.Docs), len(plan.Tables), kind)
	}
	if r.dry {
		return nil
	}
	sum, err := importer.Apply(importer.NewSink(importAPI{ctx: r.ctx, c: r.c}, r.importLog), plan, opts["project"])
	if r.json {
		raw := plainjson.Marshal(map[string]any{"made": map[string]int{"tasks": sum.Tasks, "comments": sum.Comments, "pages": sum.Docs, "rows": sum.Rows, "files": sum.Files},
			"already_there": sum.Already, "unmatched_people": sum.Unmatched})
		fmt.Fprintln(r.out, string(raw))
		return err
	}
	fmt.Fprintln(r.out, sum)
	return err
}

// importAPI is the API as an import writes through it: as the caller,
// over the network. It serves one import run, so it holds the run's
// context.
type importAPI struct {
	ctx context.Context
	c   *Client
}

// Call sends one request of the import, with its JSON body if it has one.
func (a importAPI) Call(method, path string, q url.Values, body []byte) ([]byte, error) {
	req := apiRequest{method: method, path: path, query: q, accept: "application/json"}
	if body != nil {
		req.body, req.contentType = bytes.NewReader(body), "application/json"
	}
	return a.c.workspaceRequest(a.ctx, req)
}

// SendFile uploads one file of the import, under the import's id for it.
func (a importAPI) SendFile(fileID, path string) (string, error) {
	_, u, err := a.c.UploadAs(a.ctx, fileID, path)
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
