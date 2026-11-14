-- Wake-ups, background jobs, agent oversight and integrations.

CREATE TABLE webhooks (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    name          TEXT NOT NULL,
    url           TEXT NOT NULL,
    secret        TEXT NOT NULL DEFAULT '',
    -- Event types to send; empty = all.
    event_types   {{JSON}},
    project_id    {{ID}},
    -- Set = only what concerns this member (its inbox).
    user_id       {{ID}} REFERENCES users (id),
    active        {{BOOL}} NOT NULL DEFAULT TRUE,
    failures      {{INT}} NOT NULL DEFAULT 0,
    last_status   TEXT NOT NULL DEFAULT '',
    last_at       {{TS}},
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);

CREATE TABLE webhook_deliveries (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    webhook_id    {{ID}} NOT NULL REFERENCES webhooks (id),
    seq           {{BIGINT}} NOT NULL,
    event_type    TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('pending', 'ok', 'failed', 'dead')),
    attempts      {{INT}} NOT NULL DEFAULT 0,
    status_code   {{INT}},
    error         TEXT NOT NULL DEFAULT '',
    duration_ms   {{INT}},
    created_at    {{TS}} NOT NULL,
    next_at       {{TS}},
    done_at       {{TS}}
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);
-- One delivery per webhook and event, however often the dispatcher runs.
CREATE UNIQUE INDEX webhook_deliveries_once ON webhook_deliveries (webhook_id, seq);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (state, next_at);

-- "When this happens, do that": the rules set in the interface.
CREATE TABLE rules (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    name          TEXT NOT NULL,
    active        {{BOOL}} NOT NULL DEFAULT TRUE,
    match_on      {{JSON}},
    action        {{JSON}},
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);

-- Background work. A job is claimed for a while, so several servers can
-- share the queue and a job whose worker died is picked up again.
CREATE TABLE jobs (
    id            {{ID}} PRIMARY KEY,
    kind          TEXT NOT NULL,
    workspace_id  {{ID}},
    -- Set = at most one waiting job with this name.
    dedupe        TEXT,
    payload       {{JSON}},
    run_at        {{TS}} NOT NULL,
    attempts      {{INT}} NOT NULL DEFAULT 0,
    claimed_by    TEXT NOT NULL DEFAULT '',
    claimed_until {{TS}},
    created_at    {{TS}} NOT NULL,
    done_at       {{TS}},
    error         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX jobs_due ON jobs (done_at, run_at);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe) WHERE dedupe IS NOT NULL AND done_at IS NULL;

-- What an agent did in one run, attached to a task.
CREATE TABLE agent_sessions (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    agent_id      {{ID}} NOT NULL REFERENCES users (id),
    task_id       {{ID}},
    title         TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT 'running',
    summary       TEXT NOT NULL DEFAULT '',
    instructions  TEXT NOT NULL DEFAULT '',
    steps         {{JSON}},
    links         {{JSON}},
    cost_micros   {{BIGINT}} NOT NULL DEFAULT 0,
    tokens_in     {{BIGINT}} NOT NULL DEFAULT 0,
    tokens_out    {{BIGINT}} NOT NULL DEFAULT 0,
    started_at    {{TS}} NOT NULL,
    ended_at      {{TS}},
    updated_seq   {{BIGINT}} NOT NULL
);
CREATE INDEX agent_sessions_agent ON agent_sessions (workspace_id, agent_id, started_at);
CREATE INDEX agent_sessions_task ON agent_sessions (task_id);

-- A shared thing only one can use at a time: a build machine, a test device.
CREATE TABLE resources (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE UNIQUE INDEX resources_name ON resources (workspace_id, name) WHERE deleted_at IS NULL;

CREATE TABLE resource_claims (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    resource_id   {{ID}} NOT NULL REFERENCES resources (id),
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    task_id       {{ID}},
    note          TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL CHECK (state IN ('waiting', 'holding', 'released')),
    requested_at  {{TS}} NOT NULL,
    acquired_at   {{TS}},
    lease_until   {{TS}},
    released_at   {{TS}}
);
CREATE INDEX resource_claims_resource ON resource_claims (resource_id, state, requested_at);

-- A connection to an outside service, e.g. one GitHub repository.
CREATE TABLE integrations (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    kind          TEXT NOT NULL,
    project_id    {{ID}},
    name          TEXT NOT NULL DEFAULT '',
    config        {{JSON}},
    -- Encrypted. Used by the server, never returned.
    secret        TEXT NOT NULL DEFAULT '',
    state         {{JSON}},
    active        {{BOOL}} NOT NULL DEFAULT TRUE,
    last_sync_at  {{TS}},
    last_error    TEXT NOT NULL DEFAULT '',
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
