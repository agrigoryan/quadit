-- A person may have no email address, as an agent has none: the owner of an
-- install the desktop app sets up signs in through the app, and adds an
-- address (and a password) only to sign in from a browser. SQLite cannot
-- drop a CHECK in place, so the table is made again without it and its rows
-- copied back. Most tables point at users: the checks of those pointers wait
-- for the end of the upgrade (defer_foreign_keys), when every row is back.
-- The copy back is REPLACE, not INSERT: a restore, which runs again only
-- the statements that change rows (UpgradeLoaded: UPDATE, INSERT, DELETE,
-- WITH), has the new table already.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE users_before AS SELECT * FROM users;
DROP TABLE users;
CREATE TABLE users (
    id              {{ID}} PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    name            TEXT NOT NULL,
    email           TEXT,
    avatar          TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    timezone        TEXT NOT NULL DEFAULT '',
    theme           TEXT NOT NULL DEFAULT '',
    locale          TEXT NOT NULL DEFAULT '',
    password_hash   TEXT,
    totp_secret     TEXT,
    totp_at         {{TS}},
    is_admin        {{BOOL}} NOT NULL DEFAULT FALSE,
    notify          {{JSON}},
    workspace_id    {{ID}} REFERENCES workspaces (id),
    responsible_id  {{ID}} REFERENCES users (id),
    created_by      {{ID}} REFERENCES users (id),
    created_at      {{TS}} NOT NULL,
    updated_at      {{TS}} NOT NULL,
    last_seen_at    {{TS}},
    disabled_at     {{TS}},
    deleted_at      {{TS}},
    CHECK (kind = 'person' OR (workspace_id IS NOT NULL AND responsible_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL AND deleted_at IS NULL;
REPLACE INTO users SELECT * FROM users_before;
DROP TABLE users_before;
