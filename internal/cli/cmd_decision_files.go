// Questions with files: uploading them and opening the decision with them
// in one batch.

package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"github.com/agrigoryan/quadit/internal/id"
)

// askFile is a picture or clip given with a question, and what it is shown
// on: the question itself (option 0) or an option, counted from 1.
type askFile struct {
	path   string
	option int
}

// on says what a file is shown on, in words.
func (f askFile) on() string {
	if f.option == 0 {
		return "the question"
	}
	return "option " + strconv.Itoa(f.option)
}

// questionParts reads the options and files of a question in the order they
// were typed: a file after an option belongs to that option, a file before
// the first option to the question.
func questionParts(fields []field) (labels []string, files []askFile) {
	for _, f := range fields {
		switch f.key {
		case "option":
			labels = append(labels, f.value)
		case "file":
			files = append(files, askFile{path: f.value, option: len(labels)})
		}
	}
	return labels, files
}

// readable says whether every file can be read, so that nothing is sent
// when one of them cannot.
func readable(files []askFile) error {
	for _, f := range files {
		h, err := os.Open(f.path)
		if err != nil {
			return fmt.Errorf("file %s: %w", f.path, err)
		}
		st, err := h.Stat()
		h.Close()
		if err != nil {
			return fmt.Errorf("file %s: %w", f.path, err)
		}
		if st.IsDir() {
			return fmt.Errorf("file %s is a folder", f.path)
		}
	}
	return nil
}

// askIDs makes the ids of a question with files. Given --id, they all come
// from it, so the same command sent again uploads and attaches nothing twice.
type askIDs struct{ base string }

// make is the id of one part of the question: a new one, or, given --id,
// the same one each time the same command is sent.
func (k askIDs) make(parts ...string) string {
	if k.base == "" {
		return id.New()
	}
	return id.From(append([]string{k.base}, parts...)...)
}

// uploadName is a file's id for its upload; empty lets the server make one.
func (k askIDs) uploadName(i int) string {
	if k.base == "" {
		return ""
	}
	return k.make("file", strconv.Itoa(i))
}

// askWithFiles uploads a question's files, then opens the decision with them
// attached in one batch, so that it is never seen without its pictures.
func (r *runner) askWithFiles(a map[string]any, files []askFile, approval string) error {
	if err := readable(files); err != nil {
		return err
	}
	opts, _ := a["options"].([]map[string]any)
	for _, f := range files {
		if f.option > len(opts) {
			return fmt.Errorf("file %s is given for option %d, which does not exist", f.path, f.option)
		}
	}
	if r.dry {
		return r.askDry(a, files, approval)
	}
	ids := askIDs{base: r.c.ChangeID}
	r.c.ChangeID = ""
	if _, given := a["id"]; !given {
		a["id"] = ids.make("decision")
	}
	open := BatchChange{ID: ids.make("change", "decision.open"), Type: "decision.open", Args: a, Approval: approval}
	if ids.base != "" {
		open.ID = ids.base
	}
	changes := []BatchChange{open}
	var sent []map[string]string
	for i, f := range files {
		fid, furl, err := r.c.UploadAs(r.ctx, ids.uploadName(i), f.path)
		if err != nil {
			return fmt.Errorf("file %s: %w", f.path, err)
		}
		sent = append(sent, map[string]string{"path": f.path, "id": fid, "url": furl, "on": f.on()})
		att := map[string]any{"id": ids.make("attachment", strconv.Itoa(i)), "file": fid}
		if f.option > 0 {
			o := opts[f.option-1]
			list, _ := o["attachments"].([]map[string]any)
			o["attachments"] = append(list, att)
			continue
		}
		att["decision"] = a["id"]
		changes = append(changes, BatchChange{ID: ids.make("change", "attach", strconv.Itoa(i)), Type: "attachment.add", Args: att})
	}
	res, err := r.c.Batch(r.ctx, changes)
	if err != nil {
		return err
	}
	return r.printAsked(res[0], sent)
}

// askDry checks the question without its files, uploads nothing, and says
// what would be attached where.
func (r *runner) askDry(a map[string]any, files []askFile, approval string) error {
	res, err := r.c.Change(r.ctx, "decision.open", a, ChangeOptions{Approval: approval, DryRun: true})
	if err != nil {
		return err
	}
	var would []map[string]string
	for _, f := range files {
		would = append(would, map[string]string{"path": f.path, "on": f.on()})
	}
	if r.json {
		raw, _ := json.Marshal(map[string]any{"decision": res, "files": would, "dry_run": true})
		fmt.Fprintln(r.out, string(raw))
		return nil
	}
	fmt.Fprintf(r.out, "would be accepted: decision.open %s\n", res.Key)
	for _, f := range would {
		fmt.Fprintf(r.out, "would attach %s to %s\n", f["path"], f["on"])
	}
	return nil
}

// printAsked says what a question with files became: the decision, and
// each file with its id and what it is shown on.
func (r *runner) printAsked(res Result, files []map[string]string) error {
	if r.json {
		raw, _ := json.Marshal(map[string]any{"decision": res, "files": files})
		fmt.Fprintln(r.out, string(raw))
		return nil
	}
	fmt.Fprintf(r.out, "ok decision.open %s id=%s seq=%d\n", res.Key, res.Ref, res.Seq)
	for _, f := range files {
		fmt.Fprintf(r.out, "attached %s to %s id=%s\n", f["path"], f["on"], f["id"])
	}
	return nil
}
