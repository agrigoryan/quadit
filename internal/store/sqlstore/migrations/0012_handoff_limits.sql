-- Quadit no longer keeps what agents spend. Agents run in harnesses Quadit
-- does not start, so the cost, tokens and minutes they reported could not
-- be checked; the money, time and token budgets built on them go, and with
-- them the record of usage. A session stays as the log of a run: what it
-- was asked, what it did, what it produced, when it started and ended.
ALTER TABLE agent_sessions DROP COLUMN cost_micros;
ALTER TABLE agent_sessions DROP COLUMN tokens_in;
ALTER TABLE agent_sessions DROP COLUMN tokens_out;
-- The warnings that an agent or a task had used most of its budget leave
-- the inbox, and their events leave the feed.
DELETE FROM events WHERE entity_type = 'notification'
    AND entity_id IN (SELECT id FROM notifications WHERE type = 'budget');
DELETE FROM notifications WHERE type = 'budget';
