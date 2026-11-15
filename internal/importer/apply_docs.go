package importer

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	wikiLink   = regexp.MustCompile(`(!?)\[\[([^\]\n]+)\]\]`)
	localImage = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)\)`)
)

func (a *applier) makeDocs() error {
	a.docs, a.docDone, a.titleID = map[string]Doc{}, map[string]bool{}, map[string]string{}
	for _, d := range a.plan.Docs {
		a.docs[d.Ext] = d
		a.titleID[strings.ToLower(d.Title)] = a.uid("doc", d.Ext)
	}
	for _, d := range a.plan.Docs {
		if err := a.makeDoc(d, 0); err != nil {
			return err
		}
	}
	return nil
}

// makeDoc makes one page, after the page it is under.
func (a *applier) makeDoc(d Doc, depth int) error {
	if a.docDone[d.Ext] {
		return nil
	}
	a.docDone[d.Ext] = true
	args := map[string]any{"id": a.uid("doc", d.Ext), "title": orStr(d.Title, "Untitled")}
	if p, ok := a.docs[d.ParentExt]; ok && depth < 30 {
		if err := a.makeDoc(p, depth+1); err != nil {
			return err
		}
		args["parent"] = a.uid("doc", p.Ext)
	}
	args["markdown"] = a.localImages(d, a.wikiLinks(a.here(d.Markdown)))
	if err := a.change("doc.create", args); err != nil {
		return fmt.Errorf("page %q: %w", d.Title, err)
	}
	if a.fresh {
		a.sum.Docs++
	}
	return nil
}

// wikiLinks turns [[Page]] and [[Page|label]] into links between the
// plan's pages, and ![[file]] into a picture.
func (a *applier) wikiLinks(text string) string {
	return wikiLink.ReplaceAllStringFunc(text, func(m string) string {
		sub := wikiLink.FindStringSubmatch(m)
		target, label, _ := strings.Cut(sub[2], "|")
		target = strings.TrimSpace(strings.SplitN(target, "#", 2)[0])
		if sub[1] == "!" { // an embedded file
			return "![" + target + "](" + target + ")"
		}
		if did, ok := a.titleID[strings.ToLower(filepath.Base(target))]; ok {
			return "[" + orStr(label, target) + "](doc:" + did + ")"
		}
		return orStr(label, target)
	})
}

// localImages uploads the pictures a page of a folder points at beside
// itself, and points the page at the copies.
func (a *applier) localImages(d Doc, text string) string {
	if d.Dir == "" {
		return text
	}
	return localImage.ReplaceAllStringFunc(text, func(m string) string {
		sub := localImage.FindStringSubmatch(m)
		ref, _ := url.PathUnescape(sub[2])
		if strings.Contains(ref, "://") {
			return m
		}
		for _, p := range []string{filepath.Join(d.Dir, ref), filepath.Join(d.Dir, filepath.Base(ref))} {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				if u, err := a.sink.Upload(p); err == nil {
					a.sum.Files++
					return "![" + sub[1] + "](" + u + ")"
				}
			}
		}
		return m
	})
}

func (a *applier) makeTables() error {
	for _, tb := range a.plan.Tables {
		if err := a.makeTable(tb); err != nil {
			return err
		}
	}
	return nil
}

// makeTable makes a database with a text column for each column of the
// table, and a row for each row. The first column is the row's title.
func (a *applier) makeTable(tb Table) error {
	dbID := a.uid("db", tb.Ext)
	args := map[string]any{"id": dbID, "title": orStr(tb.Title, "Untitled"), "kind": "database"}
	if _, ok := a.docs[tb.ParentExt]; ok {
		args["parent"] = a.uid("doc", tb.ParentExt)
	}
	if err := a.change("doc.create", args); err != nil {
		return fmt.Errorf("database %q: %w", tb.Title, err)
	}
	if a.fresh {
		a.sum.Docs++
	}
	cols := tb.Columns
	if len(cols) > 0 {
		cols = cols[1:]
	}
	prop := func(col string) string { return a.uid("prop", tb.Ext+"/"+col) }
	for i, c := range cols {
		if err := a.change("property.create", map[string]any{"id": prop(c), "database": dbID, "name": orStr(c, fmt.Sprintf("Column %d", i+2)), "type": "text"}); err != nil {
			return fmt.Errorf("column %q: %w", c, err)
		}
	}
	for i, r := range tb.Rows {
		props := map[string]any{}
		for j, c := range cols {
			if j+1 < len(r) && r[j+1] != "" {
				props[prop(c)] = r[j+1]
			}
		}
		title := ""
		if len(r) > 0 {
			title = r[0]
		}
		if err := a.change("doc.create", map[string]any{"id": a.uid("row", fmt.Sprintf("%s/%d", tb.Ext, i)), "parent": dbID, "title": title, "props": props}); err != nil {
			return fmt.Errorf("row %d of %q: %w", i+1, tb.Title, err)
		}
		if a.fresh {
			a.sum.Rows++
		}
	}
	return nil
}
