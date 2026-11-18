// Full-text search, the part every database shares; each one's
// own index is in search_sqlite.go and search_postgres.go.

package sqlstore

import (
	"context"
	"fmt"
	"strings"

	"github.com/agrigoryan/quadit/internal/store"
)

// searcher is one database's full-text index. The checks every database
// shares (a workspace-bound DB, ids that look like ids, the limit and the
// kind, project and audience filters) are done once in Index, Unindex and
// Search.
type searcher interface {
	// index stores d for c's workspace, replacing what d.EntityID had.
	index(ctx context.Context, c conn, d store.SearchDoc) error
	// unindex removes entityID, if it was indexed.
	unindex(ctx context.Context, c conn, entityID string) error
	// match adds the full-text condition on terms and the workspace to w,
	// and returns the query up to its WHERE.
	match(w *clause, terms []string, ws string) string
	// rank returns the ORDER BY that follows the WHERE, best first; it is
	// asked last, as it may add to w's arguments.
	rank(w *clause) string
}

// The number of hits a search returns when it asks for none, or for more
// than the most it may have; and the most words of its text it looks for.
const (
	defaultSearchLimit = 20
	maxSearchLimit     = 100
	maxSearchTerms     = 12
)

// searchTerms cuts free text into lowercase words safe to hand to either
// database: letters a-z, digits and anything beyond ASCII. Only the first
// maxSearchTerms count.
func searchTerms(text string) []string {
	var out []string
	for _, word := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !isWordRune(r) }) {
		if len(out) == maxSearchTerms {
			break
		}
		out = append(out, word)
	}
	return out
}

// isWordRune tells whether r can be part of a search term.
func isWordRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r > 127
}

// Index puts one searchable thing in the workspace's index, replacing any
// earlier entry for the same entity.
func (c conn) Index(ctx context.Context, d store.SearchDoc) error {
	if c.workspaceID == "" {
		return fmt.Errorf("store: Index needs a workspace-bound DB")
	}
	return c.dialect.search.index(ctx, c, d)
}

// Unindex removes an entity from the index; one that is not there, or is
// not an id, is no error.
func (c conn) Unindex(ctx context.Context, entityID string) error {
	if !looksUUID(entityID) {
		return nil
	}
	return c.dialect.search.unindex(ctx, c, entityID)
}

// Search finds the entries of the workspace that hold every word of the
// text, best first. A DB bound to no workspace, or text with no words,
// finds nothing.
func (c conn) Search(ctx context.Context, sq store.SearchQuery) ([]store.SearchHit, error) {
	terms := searchTerms(sq.Text)
	if len(terms) == 0 || c.workspaceID == "" {
		return nil, nil
	}
	where := &clause{}
	query := c.dialect.search.match(where, terms, c.workspaceID)
	if len(sq.Kinds) > 0 {
		where.in(`kind`, sq.Kinds)
	}
	// What the viewer may open, as a page and a task are opened: of its
	// projects or of none; and everyone's, the viewer's own private pages,
	// or private pages shared with the viewer (as the feed's filter says).
	// An entry for everyone has the audience "" on SQLite, NULL on
	// Postgres; so has an entry of no project.
	if ids := onlyIDs(sq.ProjectIDs); len(sq.ProjectIDs) > 0 {
		cond := `COALESCE(CAST(project_id AS TEXT), '') = ''`
		if len(ids) > 0 {
			list, args := placeholdersFor(ids)
			where.add(`(project_id IN (`+list+`) OR `+cond+`)`, args...)
		} else {
			where.add(cond)
		}
	}
	viewer := idOrNone(sq.Viewer)
	where.add(`(COALESCE(CAST(audience_id AS TEXT), '') = '' OR audience_id = ? OR (scope_type = 'doc' AND scope_id IN
		(SELECT d.id FROM docs d WHERE d.workspace_id = ? AND CAST(d.shared_with AS TEXT) LIKE ?)))`,
		viewer, c.workspaceID, `%"`+viewer+`"%`)
	order := c.dialect.search.rank(where)
	query += where.sql() + order
	rows, err := c.query(ctx, query+fmt.Sprintf(" LIMIT %d", limitOr(sq.Limit, defaultSearchLimit, maxSearchLimit)), where.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close() // rows.Err below reports what went wrong while reading
	var out []store.SearchHit
	for rows.Next() {
		var hit store.SearchHit
		if err := rows.Scan(&hit.Kind, &hit.EntityID, &hit.ScopeType, &hit.ScopeID, &hit.ProjectID, &hit.Title, &hit.Snippet); err != nil {
			return nil, err
		}
		out = append(out, hit)
	}
	return out, rows.Err()
}
