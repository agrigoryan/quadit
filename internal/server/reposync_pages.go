package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

func shortHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

// hashes are what was the same on both sides at the last sync, stored as
// "file:page". The file's text and the page's Markdown differ in spelling
// (spacing, list markers), so each is compared with its own hash.
func splitHashes(h string) (file, page string) {
	file, page, _ = strings.Cut(h, ":")
	return
}

// loadPages reads the source's pages, those in the trash too, and lists
// them by their file's path and by their id.
func (r *syncRun) loadPages() error {
	if err := r.db.List(r.ctx, &r.pages, store.Where(store.Eq("source_id", r.src.ID))); err != nil {
		return err
	}
	r.byPath, r.byID = map[string]core.Doc{}, map[string]core.Doc{}
	for _, p := range r.pages {
		r.byID[p.ID] = p
		if p.SourcePath != "" && (p.DeletedAt == 0 || r.byPath[p.SourcePath].ID == "") {
			r.byPath[p.SourcePath] = p
		}
	}
	return nil
}

// pageMarkdown renders a page as Markdown.
func (r *syncRun) pageMarkdown(docID string) (string, error) {
	var blocks []core.Block
	if err := r.db.List(r.ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", docID), store.Live}, Order: "rank"}); err != nil {
		return "", err
	}
	return md.Render(engine.BlockTree(blocks)), nil
}

// pageMarkdownInTx renders a page inside a write, seeing what the write just did.
func pageMarkdownInTx(ctx context.Context, tx store.Tx, docID string) (string, error) {
	var blocks []core.Block
	if err := tx.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", docID), store.Live}, Order: "rank"}); err != nil {
		return "", err
	}
	return md.Render(engine.BlockTree(blocks)), nil
}

// pageSideInTx is what a page says as its file would say it, inside a
// write, seeing what the write just did (see pageSide).
func pageSideInTx(ctx context.Context, tx store.Tx, docID, file string) (string, error) {
	var d core.Doc
	if err := tx.Get(ctx, &d, store.Eq("id", docID)); err != nil {
		return "", err
	}
	body, err := pageMarkdownInTx(ctx, tx, docID)
	if err != nil {
		return "", err
	}
	return pageSide(d.Title, file, body), nil
}

// queue notes that a page's text is to be written to a file. The file
// keeps its own front matter while the page says the same (see
// keepFrontMatter); the page is remembered by its own text.
func (r *syncRun) queue(path, docID, body string) {
	r.toWrite[path] = keepFrontMatter(r.files[path], body)
	r.written[docID] = shortHash(body)
}

// editedBy notes who changed a page that is being written, for the commit.
func (r *syncRun) editedBy(page core.Doc) {
	if page.UpdatedBy != "" && page.UpdatedAt >= r.editors[page.UpdatedBy] {
		r.editors[page.UpdatedBy] = page.UpdatedAt
	}
}

// recordHashes stores, once the push went through, what the two sides now
// agree on.
func (r *syncRun) recordHashes() error {
	// What was pushed is now the common ground for those pages.
	for docID, pageHash := range r.written {
		var d core.Doc
		if r.db.Get(r.ctx, &d, store.Eq("id", docID)) != nil || r.blocked[d.SourcePath] {
			continue
		}
		fileHash := pageHash
		if text, ok := r.toWrite[d.SourcePath]; ok {
			fileHash = shortHash(text)
		}
		if r.src.WriteMode == "propose" {
			// The branch still has the old file until the proposal is merged.
			old, _ := splitHashes(d.SourceHash)
			fileHash = old
		}
		r.db.Update(r.ctx, "docs", map[string]any{"source_hash": fileHash + ":" + pageHash}, store.Eq("id", docID))
	}
	for _, path := range r.toRemove {
		if p, ok := r.byPath[path]; ok {
			r.db.Update(r.ctx, "docs", map[string]any{"source_hash": "", "source_path": ""}, store.Eq("id", p.ID))
		}
	}
	return nil
}
