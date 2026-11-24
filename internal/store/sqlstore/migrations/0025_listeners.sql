-- What listens as an agent: a listener of one project, or the listener of
-- everything else (no project), each with the lease of the one session
-- that holds it. A project's row stays when its session stops, so that the
-- project keeps waiting for its next listener.
CREATE TABLE listeners (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    agent_id      {{ID}} NOT NULL REFERENCES users (id),
    project_id    {{ID}} REFERENCES projects (id),
    lease         TEXT NOT NULL,
    lease_until   {{TS}} NOT NULL,
    heard_at      {{TS}} NOT NULL,
    held_by       TEXT NOT NULL
);
CREATE INDEX listeners_agent ON listeners (workspace_id, agent_id);
-- The lease a member's row held is the listener of everything's. The
-- member's columns stay, empty: a restore runs this INSERT again on the
-- newest schema, which must still have them to read.
INSERT INTO listeners (workspace_id, agent_id, lease, lease_until, heard_at, held_by)
SELECT workspace_id, user_id, listen_lease, COALESCE(listening_until, 0), COALESCE(listen_heard_at, 0), COALESCE(listen_by, '')
FROM members WHERE listen_lease IS NOT NULL;
UPDATE members SET listen_lease = NULL, listen_heard_at = NULL, listen_by = NULL;
