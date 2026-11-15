package server

import (
	"context"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// health fills in what is failing behind the scenes.
func (d *dashboard) health() error {
	x, ctx := d.x, d.x.ctx()
	health := map[string]any{}
	health["webhooks_failing"], _ = x.db.Count(ctx, "webhooks", store.Live, store.Gt("failures", 0))
	health["deliveries_dead"] = liveDeliveries(ctx, x.db, store.Eq("state", "dead"))
	health["deliveries_pending"] = liveDeliveries(ctx, x.db, store.Eq("state", "pending"), store.Gt("attempts", 0))
	var backups []core.Backup
	if err := x.s.st.List(ctx, &backups, store.Q{Order: "-started_at", Limit: 1}); err == nil && len(backups) > 0 {
		health["last_backup"] = when(backups[0].FinishedAt)
		health["last_backup_ok"] = backups[0].Error == "" && backups[0].FinishedAt != 0
	}
	var sources []core.DocSource
	if err := x.db.List(ctx, &sources, store.Where(store.Live)); err == nil {
		n := 0
		for _, src := range sources {
			if src.LastError != "" {
				n++
			}
		}
		health["sources_failing"] = n
	}
	d.machinery = health
	return nil
}

// liveDeliveries counts deliveries of webhooks that still exist: what a
// deleted webhook left behind can no longer be sent again, so it is not
// something to act on.
func liveDeliveries(ctx context.Context, db store.DB, conds ...store.Cond) int {
	var hooks []core.Webhook
	if err := db.List(ctx, &hooks, store.Where(store.Live)); err != nil || len(hooks) == 0 {
		return 0
	}
	ids := make([]string, len(hooks))
	for i, h := range hooks {
		ids[i] = h.ID
	}
	// A press of "Test" is in the log, and is not a delivery that was lost.
	n, _ := db.Count(ctx, "webhook_deliveries", append(conds, store.In("webhook_id", ids), store.Ne("event_type", "webhook.test"))...)
	return n
}
