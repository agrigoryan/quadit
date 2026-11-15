package sqlstore

import (
	"context"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// tsvSearch is Postgres's full-text index: one table whose tsv column the
// database generates from title and body.
type tsvSearch struct{}

func (tsvSearch) index(ctx context.Context, c conn, d store.SearchDoc) error {
	_, err := c.exec(ctx, `INSERT INTO search_index (workspace_id, kind, entity_id, scope_type, scope_id, project_id, audience_id, title, body)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (entity_id) DO UPDATE SET kind = excluded.kind, scope_type = excluded.scope_type, scope_id = excluded.scope_id,
			project_id = excluded.project_id, audience_id = excluded.audience_id, title = excluded.title, body = excluded.body`,
		c.ws, d.Kind, d.EntityID, d.ScopeType, d.ScopeID, nz(d.ProjectID), nz(d.AudienceID), d.Title, d.Body)
	return err
}

func nz(s string) any {
	if s == "" {
		return nil
	}
	return s
}

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
	tsq := strings.Join(terms, " & ")
	w.add(`tsv @@ to_tsquery('simple', ?)`, tsq)
	w.add(`workspace_id = ?`, ws)
	w.args = append([]any{tsq}, w.args...)
	return `SELECT kind, entity_id, scope_type, scope_id, COALESCE(CAST(project_id AS TEXT), ''), title,
			ts_headline('simple', body, to_tsquery('simple', ?), 'MaxWords=18, MinWords=6, StartSel=**, StopSel=**')
			FROM search_index WHERE `
}

func (tsvSearch) rank(w *clause, viewer string) string {
	w.add(`(audience_id IS NULL OR audience_id = ?)`, idOrNone(viewer))
	w.args = append(w.args, w.args[0])
	return ` ORDER BY ts_rank(tsv, to_tsquery('simple', ?)) DESC`
}
