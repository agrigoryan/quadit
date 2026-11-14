-- Sign-in, sessions, invitations, install settings and the audit log.
-- These sit outside any workspace's event sequence.

CREATE TABLE sessions (
    id            {{ID}} PRIMARY KEY,
    token_hash    TEXT NOT NULL,
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    -- full, or mfa: password accepted, second step still due
    stage         TEXT NOT NULL DEFAULT 'full',
    ip            TEXT NOT NULL DEFAULT '',
    user_agent    TEXT NOT NULL DEFAULT '',
    created_at    {{TS}} NOT NULL,
    last_seen_at  {{TS}} NOT NULL,
    expires_at    {{TS}} NOT NULL,
    revoked_at    {{TS}}
);
CREATE UNIQUE INDEX sessions_token ON sessions (token_hash);
CREATE INDEX sessions_user ON sessions (user_id);

-- A sign-in with Google, GitHub or an OpenID Connect provider.
CREATE TABLE identities (
    id            {{ID}} PRIMARY KEY,
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    provider      TEXT NOT NULL,
    subject       TEXT NOT NULL,
    email         TEXT NOT NULL DEFAULT '',
    created_at    {{TS}} NOT NULL
);
CREATE UNIQUE INDEX identities_subject ON identities (provider, subject);
CREATE INDEX identities_user ON identities (user_id);

CREATE TABLE passkeys (
    id            {{ID}} PRIMARY KEY,
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    name          TEXT NOT NULL DEFAULT '',
    credential_id TEXT NOT NULL,
    credential    {{JSON}},
    created_at    {{TS}} NOT NULL,
    last_used_at  {{TS}}
);
CREATE UNIQUE INDEX passkeys_credential ON passkeys (credential_id);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE recovery_codes (
    id            {{ID}} PRIMARY KEY,
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    code_hash     TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    used_at       {{TS}}
);
CREATE INDEX recovery_codes_user ON recovery_codes (user_id);

CREATE TABLE invites (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    email         TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    expires_at    {{TS}} NOT NULL,
    max_uses      {{INT}} NOT NULL DEFAULT 1,
    uses          {{INT}} NOT NULL DEFAULT 0,
    revoked_at    {{TS}}
);
CREATE UNIQUE INDEX invites_token ON invites (token_hash);

-- Short-lived secrets: password resets, sign-in states, authorization codes.
CREATE TABLE one_time_tokens (
    id            {{ID}} PRIMARY KEY,
    kind          TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    user_id       {{ID}},
    data          {{JSON}},
    created_at    {{TS}} NOT NULL,
    expires_at    {{TS}} NOT NULL,
    used_at       {{TS}}
);
CREATE UNIQUE INDEX one_time_tokens_hash ON one_time_tokens (token_hash);

-- Install settings set in the admin area. Secret values are encrypted.
CREATE TABLE settings (
    name          TEXT PRIMARY KEY,
    value         {{JSON}},
    updated_at    {{TS}} NOT NULL,
    updated_by    {{ID}}
);

CREATE TABLE audit_log (
    id            {{ID}} PRIMARY KEY,
    at            {{TS}} NOT NULL,
    workspace_id  {{ID}},
    actor_id      {{ID}},
    actor_name    TEXT NOT NULL DEFAULT '',
    action        TEXT NOT NULL,
    target_type   TEXT NOT NULL DEFAULT '',
    target_id     TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT '',
    user_agent    TEXT NOT NULL DEFAULT '',
    data          {{JSON}}
);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_ws ON audit_log (workspace_id, at);

-- Counters for throttling sign-in attempts and API calls.
CREATE TABLE rate_counters (
    name          TEXT NOT NULL,
    bucket        {{BIGINT}} NOT NULL,
    hits          {{INT}} NOT NULL,
    PRIMARY KEY (name, bucket)
);

CREATE TABLE push_subscriptions (
    id            {{ID}} PRIMARY KEY,
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    endpoint      TEXT NOT NULL,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    user_agent    TEXT NOT NULL DEFAULT '',
    created_at    {{TS}} NOT NULL
);
CREATE UNIQUE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);

-- MCP clients that registered themselves to sign members in with OAuth.
CREATE TABLE oauth_clients (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '',
    redirect_uris {{JSON}},
    created_at    {{TS}} NOT NULL
);

CREATE TABLE backups (
    id            {{ID}} PRIMARY KEY,
    started_at    {{TS}} NOT NULL,
    finished_at   {{TS}},
    location      TEXT NOT NULL DEFAULT '',
    size          {{BIGINT}} NOT NULL DEFAULT 0,
    sha256        TEXT NOT NULL DEFAULT '',
    verified_at   {{TS}},
    error         TEXT NOT NULL DEFAULT ''
);
