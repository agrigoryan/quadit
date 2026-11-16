// The dashboard's health part: what is failing behind the scenes.

package server

import (
	"context"
	"log/slog"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// health fills in what is failing behind the scenes: webhooks, their
// deliveries, the last backup, and pages synced from a repository. It is
// for those who run the whole workspace: an admin not limited to some
// projects. For anyone else it is left out (machinery stays nil), since
// the numbers are the workspace's, whatever the dashboard was asked for.
func (d *dashboard) health() error {
	who, ctx := d.who, d.ctx
	if who.admin() != nil || who.limited() {
		return nil
	}
	health := map[string]any{}
	var err error
	if health["webhooks_failing"], err = who.db.Count(ctx, "webhooks", store.Live, store.Gt("failures", 0)); err != nil {
		return err
	}
	if health["deliveries_dead"], err = countLiveDeliveries(ctx, who.db, store.Eq("state", core.DeliveryDead)); err != nil {
		return err
	}
	if health["deliveries_pending"], err = countLiveDeliveries(ctx, who.db, store.Eq("state", core.DeliveryPending), store.Gt("attempts", 0)); err != nil {
		return err
	}
	var backups []core.Backup
	if err := who.st.List(ctx, &backups, store.Q{Order: "-started_at", Limit: 1}); err != nil {
		return err
	}
	if len(backups) > 0 {
		health["last_backup"] = formatTime(backups[0].FinishedAt)
		health["last_backup_ok"] = backups[0].Error == "" && backups[0].FinishedAt != 0
	}
	var sources []core.DocSource
	if err := who.db.List(ctx, &sources, store.Where(store.Live)); err != nil {
		return err
	}
	failing := 0
	for _, source := range sources {
		if source.LastError != "" {
			failing++
		}
	}
	health["sources_failing"] = failing
	d.machinery = health
	return nil
}

// liveDeliveries is countLiveDeliveries for a caller that shows a number
// whatever happens (the metrics, the install's health): a count that cannot
// be read is logged and shown as 0.
func liveDeliveries(ctx context.Context, db store.DB, conds ...store.Cond) int {
	n, err := countLiveDeliveries(ctx, db, conds...)
	if err != nil {
		slog.Warn("webhook deliveries not counted", "err", err)
	}
	return n
}

// countLiveDeliveries counts deliveries of webhooks that still exist: what
// a deleted webhook left behind can no longer be sent again, so it is not
// something to act on.
func countLiveDeliveries(ctx context.Context, db store.DB, conds ...store.Cond) (int, error) {
	var hooks []core.Webhook
	if err := db.List(ctx, &hooks, store.Where(store.Live)); err != nil || len(hooks) == 0 {
		return 0, err
	}
	ids := make([]string, len(hooks))
	for i, hook := range hooks {
		ids[i] = hook.ID
	}
	// A press of "Test" is in the log, and is not a delivery that was lost.
	return db.Count(ctx, "webhook_deliveries", append(conds, store.In("webhook_id", ids), store.Ne("event_type", "webhook.test"))...)
}
