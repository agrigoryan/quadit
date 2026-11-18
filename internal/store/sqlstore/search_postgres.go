// Postgres's full-text index.

package sqlstore

import (
	"context"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// tsvSearch is Postgres's full-text index: one table whose tsv column the
// database generates from title and body.
type tsvSearch struct{}

// index writes d's entry, replacing the one d.EntityID had.
func (tsvSearch) index(ctx context.Context, c conn, d store.SearchDoc) error {
	_, err := c.exec(ctx, `INSERT INTO search_index (workspace_id, kind, entity_id, scope_type, scope_id, project_id, audience_id, title, body)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (entity_id) DO UPDATE SET kind = excluded.kind, scope_type = excluded.scope_type, scope_id = excluded.scope_id,
			project_id = excluded.project_id, audience_id = excluded.audience_id, title = excluded.title, body = excluded.body`,
		c.workspaceID, d.Kind, d.EntityID, d.ScopeType, d.ScopeID, nullIfEmpty(d.ProjectID), nullIfEmpty(d.AudienceID), d.Title, d.Body)
	return err
}

// nullIfEmpty is NULL for "", which the index's id columns need, else s.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// unindex removes an entity's entry, if it has one.
func (tsvSearch) unindex(ctx context.Context, c conn, entityID string) error {
	_, err := c.exec(ctx, `DELETE FROM search_index WHERE entity_id = ?`, entityID)
	return err
}

// match puts the tsquery first in the arguments: the headline in the select
// list uses it, and rank reuses it for the ORDER BY.
func (tsvSearch) match(w *clause, terms []string, ws string) string {
	for i := range terms {
		terms[i] += ":*"
	}
	tsQuery := strings.Join(terms, " & ")
	w.add(`tsv @@ to_tsquery('simple', ?)`, tsQuery)
	w.add(`workspace_id = ?`, ws)
	w.args = append([]any{tsQuery}, w.args...)
	return `SELECT kind, entity_id, scope_type, scope_id, COALESCE(CAST(project_id AS TEXT), ''), title,
			ts_headline('simple', body, to_tsquery('simple', ?), 'MaxWords=18, MinWords=6, StartSel=**, StopSel=**')
			FROM search_index WHERE `
}

// rank orders by how well each entry matches; it passes the tsquery again
// for the ORDER BY.
func (tsvSearch) rank(w *clause) string {
	w.args = append(w.args, w.args[0])
	return ` ORDER BY ts_rank(tsv, to_tsquery('simple', ?)) DESC`
}
