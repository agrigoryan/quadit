package reposync

// The source's pages: reading them for reconcile, and carrying out what it
// decided about them. A page's file and what both sides agreed on last are
// kept in the page's source_path and source_hash, which only a sync writes.

import (
	"cmp"
	"context"
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/md"
	"github.com/agrigoryan/quadit/internal/store"
)

// loadPages reads the source's pages, those in the trash too, with the
// text of each live one that stands for a file.
func loadPages(ctx context.Context, db store.DB, src core.DocSource) ([]syncedPage, error) {
	var docs []core.Doc
	if err := db.List(ctx, &docs, store.Where(store.Eq("source_id", src.ID))); err != nil {
		return nil, err
	}
	pages := make([]syncedPage, len(docs))
	for i, d := range docs {
		pages[i].Doc = d
		if d.DeletedAt != 0 || d.ID == src.RootDocID || strings.HasSuffix(d.SourcePath, "/") {
			continue
		}
		text, err := pageMarkdown(ctx, db, d.ID)
		if err != nil {
			return nil, err
		}
		pages[i].Markdown = text
	}
	return pages, nil
}

// pageMarkdown renders a page as Markdown; inside a write, as the write
// has left it.
func pageMarkdown(ctx context.Context, db store.DB, docID string) (string, error) {
	var blocks []core.Block
	if err := db.List(ctx, &blocks, store.Q{Where: []store.Cond{store.Eq("doc_id", docID), store.Live}, Order: "rank"}); err != nil {
		return "", err
	}
	return md.Render(engine.BlockTree(blocks)), nil
}

// applyToPages makes the changes to pages in one write, as the source's
// creator. A page made or changed from a file is stored with what both
// sides agree on now: the file, and the page as the engine keeps it.
func (s *Syncer) applyToPages(ctx context.Context, src core.DocSource, changes []pageChange) error {
	return s.Engine.System(ctx, src.WorkspaceID, src.CreatedBy, func(sys *engine.Sys) error {
		tx := sys.Tx()
		set := func(docID string, cols map[string]any) error {
			_, err := tx.Update(ctx, "docs", cols, store.Eq("id", docID))
			return err
		}
		// agreedNow is what a page and its file agree on after the page
		// took the file's text.
		agreedNow := func(docID, file string) (string, error) {
			var d core.Doc
			if err := tx.Get(ctx, &d, store.Eq("id", docID)); err != nil {
				return "", err
			}
			body, err := pageMarkdown(ctx, tx, docID)
			if err != nil {
				return "", err
			}
			return agreed(file, pageSide(d.Title, file, body)), nil
		}
		folders := map[string]string{} // folder path -> the page made for it here
		parent := func(p parentRef) string { return cmp.Or(p.ID, folders[p.Folder]) }

		for _, change := range changes {
			switch c := change.(type) {
			case newFolderPage:
				if err := sys.Do("doc.create", map[string]any{"parent": parent(c.Parent), "title": c.Title}); err != nil {
					return err
				}
				folders[c.Path] = sys.Ref()
				if err := set(sys.Ref(), map[string]any{"source_id": src.ID, "source_path": c.Path}); err != nil {
					return err
				}
			case newPage:
				if err := sys.Do("doc.create", map[string]any{"parent": parent(c.Parent), "title": c.Title, "markdown": c.Markdown}); err != nil {
					return err
				}
				id := sys.Ref()
				both, err := agreedNow(id, c.File)
				if err != nil {
					return err
				}
				if err := set(id, map[string]any{"source_id": src.ID, "source_path": c.Path, "source_hash": both}); err != nil {
					return err
				}
			case fileIntoPage:
				if c.Retitle {
					if err := sys.Do("doc.update", map[string]any{"id": c.ID, "title": c.Title}); err != nil {
						return err
					}
				}
				if err := sys.Do("doc.write", map[string]any{"doc": c.ID, "markdown": c.Markdown}); err != nil {
					return err
				}
				both, err := agreedNow(c.ID, c.File)
				if err != nil {
					return err
				}
				if err := set(c.ID, map[string]any{"source_hash": both}); err != nil {
					return err
				}
			case trashPage:
				if err := sys.Do("doc.delete", map[string]any{"id": c.ID}); err != nil {
					return err
				}
				if err := set(c.ID, map[string]any{"source_path": "", "source_hash": ""}); err != nil {
					return err
				}
			case bindPage:
				cols := map[string]any{"source_id": src.ID, "source_path": c.Path}
				if c.Agreed != "" {
					cols["source_hash"] = c.Agreed
				}
				if err := set(c.ID, cols); err != nil {
					return err
				}
			case unbindPage:
				if err := set(c.ID, map[string]any{"source_path": "", "source_hash": ""}); err != nil {
					return err
				}
			default:
				return fmt.Errorf("repository sync: no way to make a %T", change)
			}
		}
		return nil
	})
}

// rememberWritten stores, once the push went through, what both sides of
// each written page now agree on, and that each removed file's page has
// none.
func rememberWritten(ctx context.Context, db store.DB, src core.DocSource, written []fileWrite, removed []fileRemoval) error {
	for _, w := range written {
		file := shortHash(w.Text)
		if src.WriteMode == core.WritePropose {
			// The branch still has the old file until the proposal is merged.
			file = w.LastFile
		}
		if _, err := db.Update(ctx, "docs", map[string]any{"source_hash": file + ":" + w.PageHash}, store.Eq("id", w.PageID)); err != nil {
			return fmt.Errorf("remembering what was synced: %w", err)
		}
	}
	for _, r := range removed {
		if _, err := db.Update(ctx, "docs", map[string]any{"source_hash": "", "source_path": ""}, store.Eq("id", r.PageID)); err != nil {
			return fmt.Errorf("remembering what was synced: %w", err)
		}
	}
	return nil
}
