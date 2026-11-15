// SQLite's full-text index.

package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// ftsSearch is SQLite's full-text index: an FTS5 virtual table, plus a
// search_map table from entity id to the virtual table's rowid.
type ftsSearch struct{}

// index writes d's entry: the old one goes first, as FTS5 has no upsert.
func (ftsSearch) index(ctx context.Context, c conn, d store.SearchDoc) error {
	if err := c.Unindex(ctx, d.EntityID); err != nil {
		return err
	}
	res, err := c.exec(ctx, `INSERT INTO search_index (title, body, workspace_id, kind, entity_id, scope_type, scope_id, project_id, audience_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, d.Title, d.Body, c.workspaceID, d.Kind, d.EntityID, d.ScopeType, d.ScopeID, d.ProjectID, d.AudienceID)
	if err != nil {
		return err
	}
	rowID, err := res.LastInsertId()
	if err != nil {
		return err
	}
	_, err = c.exec(ctx, `INSERT INTO search_map (entity_id, rid) VALUES (?, ?)`, d.EntityID, rowID)
	return err
}

// unindex removes an entity's entry and its rowid, if it has one.
func (ftsSearch) unindex(ctx context.Context, c conn, entityID string) error {
	var rowID int64
	err := c.row(ctx, `SELECT rid FROM search_map WHERE entity_id = ?`, entityID).Scan(&rowID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // not indexed
	}
	if err != nil {
		return err
	}
	if _, err := c.exec(ctx, `DELETE FROM search_index WHERE rowid = ?`, rowID); err != nil {
		return err
	}
	_, err = c.exec(ctx, `DELETE FROM search_map WHERE entity_id = ?`, entityID)
	return err
}

// match asks for every term as a prefix, in the workspace.
func (ftsSearch) match(w *clause, terms []string, ws string) string {
	for i := range terms {
		terms[i] = `"` + terms[i] + `"*`
	}
	w.add(`search_index MATCH ?`, strings.Join(terms, " "))
	w.add(`workspace_id = ?`, ws)
	return `SELECT kind, entity_id, scope_type, scope_id, COALESCE(project_id, ''), title,
			snippet(search_index, 1, '**', '**', '…', 18) FROM search_index WHERE `
}

// rank orders by FTS5's own rank. An entry for everyone has the audience
// "" here, where Postgres has NULL: index writes the SearchDoc as it is.
func (ftsSearch) rank(w *clause, viewer string) string {
	w.add(`(audience_id = '' OR audience_id = ?)`, viewer)
	return ` ORDER BY rank`
}
