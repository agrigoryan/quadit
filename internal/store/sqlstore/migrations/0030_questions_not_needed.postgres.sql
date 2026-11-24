-- A question can be settled without an answer: no longer needed
-- (decision.close, a task closing, an asker moving on from an answer sent
-- back). The state's check, unnamed in 0001, is the one Postgres named
-- decisions_state_check.
ALTER TABLE decisions DROP CONSTRAINT decisions_state_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_state_check CHECK (state IN ('open', 'picked', 'sent_back', 'not_needed'));
-- Questions open or sent back on a task done or canceled ask nothing of
-- anyone: they are no longer needed, settled now by nobody, with no answer;
-- what an answer that sent one back said stays as the reason. Such a task
-- waits on nobody.
UPDATE decisions SET state = 'not_needed', outcome = NULL, decided_by = NULL, decided_at = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
    updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
WHERE state IN ('open', 'sent_back')
    AND task_id IN (SELECT t.id FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE s.category IN ('done', 'canceled'));
-- The items that asked them of someone are read, as closing reads them.
UPDATE notifications SET read_at = (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
WHERE read_at IS NULL AND entity_type = 'decision' AND type IN ('decision_asked', 'unclear')
    AND entity_id IN (SELECT id FROM decisions WHERE state = 'not_needed');
UPDATE tasks SET waiting_on_id = NULL, waiting_on_note = '', waiting_outside = FALSE
WHERE (waiting_on_id IS NOT NULL OR waiting_outside OR waiting_on_note <> '')
    AND status_id IN (SELECT id FROM statuses WHERE category IN ('done', 'canceled'));
