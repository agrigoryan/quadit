package server

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// reconcile settles every file against its page, then every page that has
// no file, in one write. Pages are made, rewritten and trashed here; what
// has to change in the repository is noted for the steps that follow.
func (r *syncRun) reconcile() error {
	r.toWrite, r.written, r.editors = map[string]string{}, map[string]string{}, map[string]int64{}
	return r.s.eng.System(r.ctx, r.src.WorkspaceID, r.src.CreatedBy, func(sys *engine.Sys) error {
		paths := make([]string, 0, len(r.files))
		for p := range r.files {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, path := range paths {
			if err := r.fromFile(sys, path); err != nil {
				return err
			}
		}
		// Pages with no file: new here, or their file was deleted there.
		for _, page := range r.pages {
			if err := r.fromPage(sys, page); err != nil {
				return err
			}
		}
		return nil
	})
}

// fromFile settles one file of the repository against its page.
func (r *syncRun) fromFile(sys *engine.Sys, path string) error {
	text := r.files[path]
	page, known := r.byPath[path]
	if !known || page.DeletedAt != 0 && page.SourceHash == "" {
		return r.newFile(sys, path, text)
	}
	if page.DeletedAt != 0 {
		r.fileOfTrashedPage(path, text, page)
		return nil
	}
	return r.reconcilePage(sys, path, text, page)
}

// dirPage finds or makes the page for a directory.
func (r *syncRun) dirPage(sys *engine.Sys, d string) (string, error) {
	if d == "." || d == "" {
		return r.src.RootDocID, nil
	}
	if p, ok := r.byPath[d+"/"]; ok && p.DeletedAt == 0 {
		return p.ID, nil
	}
	parent, err := r.dirPage(sys, filepath.ToSlash(filepath.Dir(d)))
	if err != nil {
		return "", err
	}
	if err := sys.Do("doc.create", map[string]any{"parent": parent, "title": filepath.Base(d)}); err != nil {
		return "", err
	}
	pid := sys.Ref()
	if _, err := sys.Tx().Update(r.ctx, "docs", map[string]any{"source_id": r.src.ID, "source_path": d + "/"}, store.Eq("id", pid)); err != nil {
		return "", err
	}
	r.byPath[d+"/"] = core.Doc{ID: pid, SourcePath: d + "/"}
	return pid, nil
}

// newFile makes the page of a file that has none yet.
func (r *syncRun) newFile(sys *engine.Sys, path, text string) error {
	parent, err := r.dirPage(sys, filepath.ToSlash(filepath.Dir(path)))
	if err != nil {
		return err
	}
	// Called by its opening heading, or else by its name.
	title, markdown := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)), text
	if heading, rest, ok := titleOfFile(text); ok {
		title, markdown = heading, rest
	}
	if err := sys.Do("doc.create", map[string]any{"parent": parent, "title": title, "markdown": markdown}); err != nil {
		return err
	}
	pid := sys.Ref()
	side, err := pageSideInTx(r.ctx, sys.Tx(), pid, text)
	if err != nil {
		return err
	}
	if _, err := sys.Tx().Update(r.ctx, "docs", map[string]any{"source_id": r.src.ID, "source_path": path, "source_hash": shortHash(text) + ":" + shortHash(side)}, store.Eq("id", pid)); err != nil {
		return err
	}
	r.res.PagesCreated++
	return nil
}

// fileOfTrashedPage decides what becomes of a file whose page is in the
// trash.
func (r *syncRun) fileOfTrashedPage(path, text string, page core.Doc) {
	lastFile, _ := splitHashes(page.SourceHash)
	// The page went to the trash here: the file goes too, unless
	// the file changed since and the repository has the say.
	if shortHash(text) == lastFile || r.src.Authority == "pages" {
		r.toRemove = append(r.toRemove, path)
		return
	}
	// Kept, and said: the file now has no page to follow it.
	r.renamed = append(r.renamed, fmt.Sprintf("%s changed in the repository after its page %q was deleted here; the file was kept, and restoring the page takes up its text", path, firstNonEmpty(page.Title, "untitled")))
}

// reconcilePage brings a file and its page in line when either changed since the
// last sync: the file's text goes into the page, or the page's is noted to
// be written to the file.
func (r *syncRun) reconcilePage(sys *engine.Sys, path, text string, page core.Doc) error {
	fileHash := shortHash(text)
	lastFile, lastPage := splitHashes(page.SourceHash)
	body, err := r.pageMarkdown(page.ID)
	if err != nil {
		return err
	}
	// The page is as it was if its text, with or without its title as the
	// heading, is what was synced last: the file's heading may have come or
	// gone since.
	pageChanged := shortHash(body) != lastPage && shortHash(withHeading(page.Title, body)) != lastPage
	fileChanged := fileHash != lastFile
	switch {
	case fileChanged && (!pageChanged || r.src.Authority == "repo"):
		if err := r.pageFromFile(sys, page, text); err != nil {
			return err
		}
		side, err := pageSideInTx(r.ctx, sys.Tx(), page.ID, text)
		if err != nil {
			return err
		}
		if _, err := sys.Tx().Update(r.ctx, "docs", map[string]any{"source_hash": fileHash + ":" + shortHash(side)}, store.Eq("id", page.ID)); err != nil {
			return err
		}
		r.res.PagesUpdated++
	case pageChanged:
		r.queue(path, page.ID, pageSide(page.Title, text, body))
		r.editedBy(page)
	}
	return nil
}

// pageFromFile writes a file's text into its page. A file that opens with a
// heading gives the page its title, and the rest its text.
func (r *syncRun) pageFromFile(sys *engine.Sys, page core.Doc, text string) error {
	heading, rest, ok := titleOfFile(text)
	if !ok {
		return sys.Do("doc.write", map[string]any{"doc": page.ID, "markdown": text})
	}
	if heading != page.Title {
		if err := sys.Do("doc.update", map[string]any{"id": page.ID, "title": heading}); err != nil {
			return err
		}
	}
	return sys.Do("doc.write", map[string]any{"doc": page.ID, "markdown": rest})
}

// fromPage settles one page against the repository. Only a page with no
// file there is of concern: one made in the app, or one whose file was
// deleted.
func (r *syncRun) fromPage(sys *engine.Sys, page core.Doc) error {
	if page.DeletedAt != 0 || page.ID == r.src.RootDocID || strings.HasSuffix(page.SourcePath, "/") {
		return nil
	}
	if _, has := r.files[page.SourcePath]; has && page.SourcePath != "" {
		return nil
	}
	if page.SourcePath != "" && page.SourceHash != "" {
		return r.trashPage(sys, page)
	}
	return r.newPage(sys, page)
}

// trashPage sends a page to the trash because its file is gone from the
// repository.
func (r *syncRun) trashPage(sys *engine.Sys, page core.Doc) error {
	if err := sys.Do("doc.delete", map[string]any{"id": page.ID}); err != nil {
		return err
	}
	// It went to the trash because the repository dropped its
	// file, not because someone here threw it away: it lets go
	// of the file's name. Should the file come back there (a
	// reverted commit), it is a file like any new one and gets
	// its page, instead of being deleted again on this page's
	// behalf.
	if _, err := sys.Tx().Update(r.ctx, "docs", map[string]any{"source_path": "", "source_hash": ""}, store.Eq("id", page.ID)); err != nil {
		return err
	}
	r.res.PagesTrashed++
	return nil
}

// newPage gives a file to a page that has none.
func (r *syncRun) newPage(sys *engine.Sys, page core.Doc) error {
	// A page made in the app: give it a file beside its parent's.
	dirOf := ""
	if parent, ok := r.byID[page.ParentID]; ok && strings.HasSuffix(parent.SourcePath, "/") {
		dirOf = parent.SourcePath
	}
	path := dirOf + slugFrom(firstNonEmpty(page.Title, "untitled")) + ".md"
	// The file by its name is about to be removed, because the page
	// that had it went to the trash: this page takes the file over
	// instead, so the repository never sees it go and come back.
	if at := indexOf(r.toRemove, path); at >= 0 {
		return r.takeOver(sys, page, path, at)
	}
	// A name no file has, and that no link in the repository stands
	// on (a link is not a page, and is not written through).
	natural := path
	for n := 2; r.pathTaken(path); n++ {
		path = fmt.Sprintf("%s%s-%d.md", dirOf, slugFrom(page.Title), n)
	}
	body, err := r.pageMarkdown(page.ID)
	if err != nil {
		return err
	}
	if path != natural {
		// Said in the answer: someone who made or restored a page
		// should learn that the name was taken, and when the two
		// say the same thing, that one of them is one too many.
		if text, ok := r.files[natural]; ok && strings.TrimSpace(text) == strings.TrimSpace(body) {
			// A second page saying exactly what that file says (a page
			// brought back from the trash after its file returned):
			// no second file is made of it while it says nothing new.
			r.renamed = append(r.renamed, fmt.Sprintf("%q was not written: %s already says the same, and has its own page; one of the two pages can go", firstNonEmpty(page.Title, "untitled"), natural))
			return nil
		}
		r.renamed = append(r.renamed, fmt.Sprintf("%q was written as %s (%s is taken)", firstNonEmpty(page.Title, "untitled"), path, natural))
	}
	if _, err := sys.Tx().Update(r.ctx, "docs", map[string]any{"source_path": path}, store.Eq("id", page.ID)); err != nil {
		return err
	}
	r.queue(path, page.ID, body)
	r.editedBy(page)
	return nil
}

// takeOver hands a page the file its trashed twin had: the file at
// toRemove[at] is not removed after all, and is written only if the page
// says something else than it does.
func (r *syncRun) takeOver(sys *engine.Sys, page core.Doc, path string, at int) error {
	body, err := r.pageMarkdown(page.ID)
	if err != nil {
		return err
	}
	r.toRemove = append(r.toRemove[:at], r.toRemove[at+1:]...)
	if owner, ok := r.byPath[path]; ok && owner.ID != page.ID {
		if _, err := sys.Tx().Update(r.ctx, "docs", map[string]any{"source_path": "", "source_hash": ""}, store.Eq("id", owner.ID)); err != nil {
			return err
		}
	}
	set := map[string]any{"source_id": r.src.ID, "source_path": path}
	side := pageSide(page.Title, r.files[path], body)
	if strings.TrimSpace(r.files[path]) == strings.TrimSpace(side) {
		set["source_hash"] = shortHash(r.files[path]) + ":" + shortHash(side) // already the same: nothing to write
	} else {
		r.queue(path, page.ID, side)
	}
	_, err = sys.Tx().Update(r.ctx, "docs", set, store.Eq("id", page.ID))
	return err
}

func indexOf(list []string, v string) int {
	for i, x := range list {
		if x == v {
			return i
		}
	}
	return -1
}
