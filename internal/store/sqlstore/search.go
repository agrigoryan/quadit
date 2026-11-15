package sqlstore

import (
	"context"

	"github.com/agrigoryan/quadit/internal/store"
)

// searcher is one database's full-text index. The checks every database
// shares (a workspace-bound DB, ids that look like ids, the limit and the
// kind and project filters) are done once in Index, Unindex and Search.
type searcher interface {
	// index stores d for c's workspace, replacing what d.EntityID had.
	index(ctx context.Context, c conn, d store.SearchDoc) error
	// unindex removes entityID, if it was indexed.
	unindex(ctx context.Context, c conn, entityID string) error
	// match adds the full-text condition on terms and the workspace to w,
	// and returns the query up to its WHERE.
	match(w *clause, terms []string, ws string) string
	// rank adds the audience condition for viewer to w, and returns the
	// ORDER BY that follows the WHERE.
	rank(w *clause, viewer string) string
}
