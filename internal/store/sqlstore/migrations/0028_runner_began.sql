-- Where Quadit's runner began to serve an agent's listener of a project:
-- the feed's position when the listener gained a runner where it had none.
-- An item from before it starts a run only if it still waits on the agent.
-- Zero for a listener with no runner, or one marked before this was kept.
ALTER TABLE listeners ADD COLUMN runner_began_seq {{BIGINT}} NOT NULL DEFAULT 0;
