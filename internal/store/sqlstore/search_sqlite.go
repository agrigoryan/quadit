package sqlstore

import (
	"context"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// ftsSearch is SQLite's full-text index: an FTS5 virtual table, plus a
// search_map table from entity id to the virtual table's rowid.
type ftsSearch struct{}

func (ftsSearch) index(ctx context.Context, c conn, d store.SearchDoc) error {
	if err := c.Unindex(ctx, d.EntityID); err != nil {
		return err
	}
	res, err := c.exec(ctx, `INSERT INTO search_index (title, body, workspace_id, kind, entity_id, scope_type, scope_id, project_id, audience_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.Title, d.Body, c.ws, d.Kind, d.EntityID, d.ScopeType, d.ScopeID, d.ProjectID, d.AudienceID)
	if err != nil {
		return err
	}
	rid, err := res.LastInsertId()
	if err != nil {
		return err
	}
	_, err = c.exec(ctx, `INSERT INTO search_map (entity_id, rid) VALUES (?, ?)`, d.EntityID, rid)
	return err
}

func (ftsSearch) unindex(ctx context.Context, c conn, entityID string) error {
	var rid int64
	if err := c.row(ctx, `SELECT rid FROM search_map WHERE entity_id = ?`, entityID).Scan(&rid); err != nil {
		return nil // not indexed
	}
	if _, err := c.exec(ctx, `DELETE FROM search_index WHERE rowid = ?`, rid); err != nil {
		return err
	}
	_, err := c.exec(ctx, `DELETE FROM search_map WHERE entity_id = ?`, entityID)
	return err
}

func (ftsSearch) match(w *clause, terms []string, ws string) string {
	for i := range terms {
		terms[i] = `"` + terms[i] + `"*`
	}
	w.add(`search_index MATCH ?`, strings.Join(terms, " "))
	w.add(`workspace_id = ?`, ws)
	return `SELECT kind, entity_id, scope_type, scope_id, COALESCE(project_id, ''), title,
			snippet(search_index, 1, '**', '**', '…', 18) FROM search_index WHERE `
}

func (ftsSearch) rank(w *clause, viewer string) string {
	w.add(`(audience_id = '' OR audience_id = ?)`, viewer)
	return ` ORDER BY rank`
}
