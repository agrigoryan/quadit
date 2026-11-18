// The files of an Orbit task, fetched with a signed-in session.

package importer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// orbitAttachment is a file on a task or on one of its comments, as the
// routes of Orbit's own web app list it.
type orbitAttachment struct {
	ID        string
	Name      string `json:"display_name"`
	CommentID string `json:"comment_id"`
	Deleted   bool
}

// files fetches the task's attached files with the signed-in session, and
// hangs each on the task or on the comment it was attached to. Text there
// points at a file by its download address; the plan keeps that address,
// so that the text can point at the copy here.
func (r *orbitReader) files(ot orbitTask, t *Task, commentAt map[string]int) error {
	inner := "/api/v1/workspaces/" + url.PathEscape(r.workspace) + "/tasks/" + url.PathEscape(ot.ID) + "/attachments"
	list, err := r.attachments(inner)
	if err != nil {
		return fmt.Errorf("the files of %s: %w (session must be a signed-in Orbit session, not an API token)", ot.Identifier, err)
	}
	for _, a := range list {
		if a.Deleted || a.ID == "" {
			continue
		}
		link := inner + "/" + a.ID + "/download"
		path, err := r.fetch(a, link)
		if err != nil {
			r.plan.Notes = append(r.plan.Notes, fmt.Sprintf("the file %s of %s could not be fetched: %v", a.Name, ot.Identifier, err))
			continue
		}
		r.plan.Files = append(r.plan.Files, File{Ext: a.ID, Path: path, Links: []string{r.origin + link, link}})
		if i, ok := commentAt[a.CommentID]; ok && a.CommentID != "" {
			t.Comments[i].Files = append(t.Comments[i].Files, a.ID)
		} else {
			t.Files = append(t.Files, a.ID)
		}
	}
	return nil
}

// attachments lists a task's files. Orbit has answered with a bare list
// and with one wrapped in "items"; both are read.
func (r *orbitReader) attachments(inner string) ([]orbitAttachment, error) {
	var raw json.RawMessage
	if err := getJSON(r.hc, r.origin+inner, r.session, &raw); err != nil {
		return nil, err
	}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("[")) {
		var list []orbitAttachment
		err := json.Unmarshal(raw, &list)
		return list, err
	}
	var wrapped orbitList[orbitAttachment]
	err := json.Unmarshal(raw, &wrapped)
	return wrapped.Items, err
}

// fetch copies one file into the plan's temporary folder, under its id so
// that two files of one name do not meet.
func (r *orbitReader) fetch(a orbitAttachment, link string) (string, error) {
	if r.plan.Tmp == "" {
		dir, err := os.MkdirTemp("", "quadit-orbit-*")
		if err != nil {
			return "", err
		}
		r.plan.Tmp = dir
	}
	name := filepath.Base(strings.ReplaceAll(a.Name, "\\", "/"))
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	path := filepath.Join(r.plan.Tmp, a.ID, name)
	return path, getFile(r.hc, r.origin+link, r.session, path)
}
