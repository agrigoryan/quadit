-- Where Quadit's runner began to serve an agent's listener of a project:
-- the feed's position when the listener gained a runner where it had none.
-- An item from before it starts a run only if it still waits on the agent.
-- Zero for a listener with no runner, or one marked before this was kept.
ALTER TABLE listeners ADD COLUMN runner_began_seq {{BIGINT}} NOT NULL DEFAULT 0;
-- An inbox item made before version 27 reads as not addressed to its
-- member. The types below are made only for the member itself: it was
-- assigned, mentioned, handed the task, asked, answered, found unclear or
-- replied to. Only a comment, a result or a status is heard as a follower.
UPDATE notifications SET addressed = TRUE
WHERE addressed = FALSE AND type IN ('assigned', 'mentioned', 'waiting_on', 'decision_asked', 'picked', 'unclear', 'replied');
