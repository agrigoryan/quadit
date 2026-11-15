// Telling every server that shares the database that a feed
// moved.

package sqlstore

import (
	"context"
	"strconv"
)

// notifier tells every server sharing the database that a feed moved. A
// database only one server uses has none.
type notifier interface {
	// poke wakes every server's waiters with no news in the feed.
	poke(ctx context.Context, db querier) error
	// feedMoved says workspaceID's feed is now at seq. It runs inside the
	// write's transaction, so the database delivers it when, and only if,
	// that write commits.
	feedMoved(ctx context.Context, r runner, workspaceID string, seq int64) error
}

// pgNotify notifies through Postgres's pg_notify on FeedChannel.
type pgNotify struct{}

func (pgNotify) poke(ctx context.Context, db querier) error {
	_, err := db.ExecContext(ctx, `SELECT pg_notify('`+FeedChannel+`', 'poke')`)
	return err
}

func (pgNotify) feedMoved(ctx context.Context, r runner, workspaceID string, seq int64) error {
	_, err := r.exec(ctx, `SELECT pg_notify('`+FeedChannel+`', ?)`, workspaceID+":"+strconv.FormatInt(seq, 10))
	return err
}
