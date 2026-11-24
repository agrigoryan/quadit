-- A question answered, or taken back, asks nothing of anyone any more:
-- from this version its items are read when that happens. Those of before
-- are read now, at the answer's time when there is one, else at this
-- upgrade's. Nothing else of before is marked.
UPDATE notifications SET read_at = COALESCE(
    (SELECT d.decided_at FROM decisions d WHERE d.id = notifications.entity_id AND d.decided_at > 0),
    (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT)
WHERE read_at IS NULL AND entity_type = 'decision' AND type IN ('decision_asked', 'unclear')
    AND entity_id IN (SELECT id FROM decisions WHERE state <> 'open' OR deleted_at IS NOT NULL);
