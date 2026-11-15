// Bringing the plan's files over, and pointing text at the copies.

package importer

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// fileSet is the plan's files on their way here. Each is sent once, the
// first time something needs it.
type fileSet struct {
	byExt map[string]File
	sent  map[string]string // ext -> its address here ("" when it could not be sent)
	links []fileLink        // how text at the source points at them, longest first
}

type fileLink struct{ text, ext string }

func (a *applier) indexFiles() error {
	a.files = fileSet{byExt: map[string]File{}, sent: map[string]string{}}
	for _, f := range a.plan.Files {
		a.files.byExt[f.Ext] = f
		for _, l := range f.Links {
			if l != "" {
				a.files.links = append(a.files.links, fileLink{l, f.Ext})
			}
		}
	}
	// Longest first: an address with the server's name before the same one
	// without it.
	sort.SliceStable(a.files.links, func(i, j int) bool { return len(a.files.links[i].text) > len(a.files.links[j].text) })
	return nil
}

// send uploads one of the plan's files unless it was sent before, in this
// run or an earlier one, and gives its address here: without the server's
// name, so that it still holds when the install moves to another one.
func (a *applier) send(ext string) string {
	if u, ok := a.files.sent[ext]; ok {
		return u
	}
	f, isNew := a.files.byExt[ext], true
	var u string
	var err error
	if up, ok := a.sink.(FileUploader); ok {
		u, isNew, err = up.UploadAs(a.uid("file", ext), f.Path)
	} else {
		u, err = a.sink.Upload(f.Path)
	}
	switch {
	case err != nil:
		a.sink.Logf("note: the file %s did not come over: %v", filepath.Base(f.Path), err)
		u = ""
	case isNew:
		a.sum.Files++
	}
	if i := strings.Index(u, "/f/"); i > 0 {
		u = u[i:]
	}
	a.files.sent[ext] = u
	return u
}

// here makes text that pointed at files at the source point at their
// copies here.
func (a *applier) here(text string) string {
	for _, l := range a.files.links {
		if strings.Contains(text, l.text) {
			if u := a.send(l.ext); u != "" {
				text = strings.ReplaceAll(text, l.text, u)
			}
		}
	}
	return text
}

// attach shows files on a task or a comment (on), as they were there. was
// is what the task or comment was at the source.
func (a *applier) attach(exts []string, on, subject, was string) error {
	for _, ext := range exts {
		f, ok := a.files.byExt[ext]
		if !ok || a.send(ext) == "" {
			continue
		}
		if err := a.change("attachment.add", map[string]any{"id": a.uid("attachment", was+"/"+ext), "file": a.uid("file", ext), on: subject}); err != nil {
			return fmt.Errorf("file %s: %w", filepath.Base(f.Path), err)
		}
	}
	return nil
}
