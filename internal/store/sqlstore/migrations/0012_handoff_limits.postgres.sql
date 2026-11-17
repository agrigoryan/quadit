-- What stays of an agent's or a task's budget is the one limit the server
-- counts itself: how many times work may pass from agent to agent. It
-- becomes a number of its own, handoff_limit, made from the budget's
-- "handoffs" in place; a budget without one is no limit.
ALTER TABLE members RENAME COLUMN budget TO handoff_limit;
ALTER TABLE members ALTER COLUMN handoff_limit TYPE INTEGER USING (handoff_limit->>'handoffs')::INTEGER;
ALTER TABLE tasks RENAME COLUMN budget TO handoff_limit;
ALTER TABLE tasks ALTER COLUMN handoff_limit TYPE INTEGER USING (handoff_limit->>'handoffs')::INTEGER;
-- The feed says the same of what happened before: a change of a budget's
-- hand-offs is a change of the hand-off limit, a row that had a budget has
-- its limit, and the rest of a budget, and what a session cost, is taken
-- out. An event that said nothing else says nothing now, and goes.
UPDATE events SET data = jsonb_set(data, '{changes,handoff_limit}', jsonb_build_object(
        'from', COALESCE((data->'changes'->'budget'->'from'->>'handoffs')::INTEGER, 0),
        'to', COALESCE((data->'changes'->'budget'->'to'->>'handoffs')::INTEGER, 0)))
WHERE data->'changes'->'budget' IS NOT NULL
    AND COALESCE((data->'changes'->'budget'->'from'->>'handoffs')::INTEGER, 0)
        <> COALESCE((data->'changes'->'budget'->'to'->>'handoffs')::INTEGER, 0);
UPDATE events SET data = data #- '{changes,budget}' WHERE data->'changes'->'budget' IS NOT NULL;
UPDATE events SET data = jsonb_set(data, '{row,handoff_limit}', data->'row'->'budget'->'handoffs')
WHERE data->'row'->'budget'->'handoffs' IS NOT NULL;
UPDATE events SET data = data #- '{row,budget}' WHERE data->'row'->'budget' IS NOT NULL;
UPDATE events SET data = data #- '{changes,cost_micros}' #- '{changes,tokens_in}' #- '{changes,tokens_out}'
    #- '{row,cost_micros}' #- '{row,tokens_in}' #- '{row,tokens_out}'
WHERE entity_type = 'session';
DELETE FROM events WHERE data->'changes' = '{}'::JSONB;
-- A restore of an archive made before this version loads its rows into the
-- newest schema, where a budget has no column: the limits are read back
-- from the feed instead, as it says them now. The last thing the feed says
-- of a member or a task wins (a row in full, or a change of the limit); a
-- limit of 0 is none. An upgrade has filled the limits from the budgets
-- already, and the feed agrees with them.
UPDATE members SET handoff_limit = (
    SELECT NULLIF(COALESCE((e.data->'changes'->'handoff_limit'->>'to')::INTEGER, (e.data->'row'->>'handoff_limit')::INTEGER, 0), 0)
    FROM events e
    WHERE e.workspace_id = members.workspace_id AND e.entity_type = 'member' AND e.entity_id = members.user_id
        AND (e.data->'changes'->'handoff_limit' IS NOT NULL OR e.data->'row' IS NOT NULL)
    ORDER BY e.seq DESC LIMIT 1)
WHERE handoff_limit IS NULL;
UPDATE tasks SET handoff_limit = (
    SELECT NULLIF(COALESCE((e.data->'changes'->'handoff_limit'->>'to')::INTEGER, (e.data->'row'->>'handoff_limit')::INTEGER, 0), 0)
    FROM events e
    WHERE e.workspace_id = tasks.workspace_id AND e.entity_type = 'task' AND e.entity_id = tasks.id
        AND (e.data->'changes'->'handoff_limit' IS NOT NULL OR e.data->'row' IS NOT NULL)
    ORDER BY e.seq DESC LIMIT 1)
WHERE handoff_limit IS NULL;
