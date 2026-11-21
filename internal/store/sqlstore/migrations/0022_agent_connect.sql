-- When an agent first proved it reached Quadit from inside its tool: a
-- connect code given back, a change made with its own credential, or its
-- listener's first lease. An agent that has made a change has proven it.
ALTER TABLE members ADD COLUMN connected_at {{TS}};
UPDATE members SET connected_at = (
    SELECT MIN(changes.created_at) FROM changes
    WHERE changes.workspace_id = members.workspace_id AND changes.actor_id = members.user_id
) WHERE kind = 'agent';
-- The lease of a member's listener: the one session that delivers its inbox
-- from the cursor "listen". listening_until is when the lease ends.
ALTER TABLE members ADD COLUMN listen_lease TEXT;
ALTER TABLE members ADD COLUMN listen_heard_at {{TS}};
-- A code a person makes for one agent and one tool, which the agent gives
-- back from inside that tool. Only its SHA-256 is kept.
CREATE TABLE connect_codes (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    agent_id      {{ID}} NOT NULL REFERENCES users (id),
    tool          TEXT NOT NULL,
    code_hash     TEXT NOT NULL,
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    expires_at    {{TS}} NOT NULL,
    used_at       {{TS}}
);
CREATE INDEX connect_codes_agent ON connect_codes (workspace_id, agent_id);
