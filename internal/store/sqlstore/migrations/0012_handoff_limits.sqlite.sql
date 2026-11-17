-- What stays of an agent's or a task's budget is the one limit the server
-- counts itself: how many times work may pass from agent to agent. It
-- becomes a number of its own, handoff_limit, made from the budget's
-- "handoffs"; a budget without one is no limit. SQLite cannot change a
-- column's type in place, so the number is a new column, filled before the
-- budget goes. It is filled with REPLACE, not UPDATE: a restore, which runs
-- again only the statements that change rows (UpgradeLoaded: UPDATE,
-- INSERT, DELETE, WITH) on the newest schema, has no budget to read.
ALTER TABLE members ADD COLUMN handoff_limit INTEGER;
REPLACE INTO members (workspace_id, user_id, role, handle, kind, name, avatar, title, scope, last_seen_at, last_action,
    listening_until, created_at, updated_seq, suspended_at, delegated_by, delegated_task, removed_at, handoff_limit)
SELECT workspace_id, user_id, role, handle, kind, name, avatar, title, scope, last_seen_at, last_action,
    listening_until, created_at, updated_seq, suspended_at, delegated_by, delegated_task, removed_at,
    json_extract(budget, '$.handoffs')
FROM members WHERE json_extract(budget, '$.handoffs') > 0;
ALTER TABLE members DROP COLUMN budget;
ALTER TABLE tasks ADD COLUMN handoff_limit INTEGER;
REPLACE INTO tasks (id, workspace_id, project_id, number, key, title, description, status_id, priority, assignee_id,
    waiting_on_id, asked_by, waiting_outside, waiting_on_note, parent_id, epic_id, milestone_id, cycle_id, estimate,
    label_ids, lease_holder_id, lease_until, rank, due_on, created_by, created_at, updated_at, started_at,
    completed_at, canceled_at, created_seq, updated_seq, activity_seq, archived_at, deleted_at, deleted_by, handoff_limit)
SELECT id, workspace_id, project_id, number, key, title, description, status_id, priority, assignee_id,
    waiting_on_id, asked_by, waiting_outside, waiting_on_note, parent_id, epic_id, milestone_id, cycle_id, estimate,
    label_ids, lease_holder_id, lease_until, rank, due_on, created_by, created_at, updated_at, started_at,
    completed_at, canceled_at, created_seq, updated_seq, activity_seq, archived_at, deleted_at, deleted_by,
    json_extract(budget, '$.handoffs')
FROM tasks WHERE json_extract(budget, '$.handoffs') > 0;
ALTER TABLE tasks DROP COLUMN budget;
-- The feed says the same of what happened before: a change of a budget's
-- hand-offs is a change of the hand-off limit, a row that had a budget has
-- its limit, and the rest of a budget, and what a session cost, is taken
-- out. An event that said nothing else says nothing now, and goes.
UPDATE events SET data = json_set(json_remove(data, '$.changes.budget'), '$.changes.handoff_limit', json_object(
        'from', COALESCE(json_extract(data, '$.changes.budget.from.handoffs'), 0),
        'to', COALESCE(json_extract(data, '$.changes.budget.to.handoffs'), 0)))
WHERE json_extract(data, '$.changes.budget') IS NOT NULL
    AND COALESCE(json_extract(data, '$.changes.budget.from.handoffs'), 0)
        <> COALESCE(json_extract(data, '$.changes.budget.to.handoffs'), 0);
UPDATE events SET data = json_remove(data, '$.changes.budget') WHERE json_extract(data, '$.changes.budget') IS NOT NULL;
UPDATE events SET data = json_set(data, '$.row.handoff_limit', json_extract(data, '$.row.budget.handoffs'))
WHERE json_extract(data, '$.row.budget.handoffs') IS NOT NULL;
UPDATE events SET data = json_remove(data, '$.row.budget') WHERE json_extract(data, '$.row.budget') IS NOT NULL;
UPDATE events SET data = json_remove(data, '$.changes.cost_micros', '$.changes.tokens_in', '$.changes.tokens_out',
    '$.row.cost_micros', '$.row.tokens_in', '$.row.tokens_out')
WHERE entity_type = 'session';
DELETE FROM events WHERE json_extract(data, '$.changes') = '{}';
