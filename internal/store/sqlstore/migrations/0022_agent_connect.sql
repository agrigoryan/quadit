-- When an agent first proved it reached Quadit from inside its tool: a
-- connect code given back, a change made with its own credential, or its
-- listener's first lease. An agent that has made a change has proven it:
-- its first change, found in one pass over the changes.
ALTER TABLE members ADD COLUMN connected_at {{TS}};
UPDATE members SET connected_at = firsts.at
FROM (SELECT workspace_id, actor_id, MIN(created_at) AS at FROM changes GROUP BY workspace_id, actor_id) AS firsts
WHERE members.kind = 'agent' AND firsts.workspace_id = members.workspace_id AND firsts.actor_id = members.user_id;
-- The lease of a member's listener: the one session that delivers its inbox
-- from the cursor "listen". listening_until is when the lease ends; what it
-- held before, a mark left by any wait on the feed, is not a lease.
ALTER TABLE members ADD COLUMN listen_lease TEXT;
ALTER TABLE members ADD COLUMN listen_heard_at {{TS}};
UPDATE members SET listening_until = NULL;
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
