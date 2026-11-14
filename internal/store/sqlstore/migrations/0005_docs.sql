-- Docs: a tree of pages, each a list of blocks with stable ids. An edit is
-- a change to one block, sent through the same pipeline as a task change.

CREATE TABLE docs (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    parent_id     {{ID}} REFERENCES docs (id),
    -- page, database, row (a row of a database is a page under it)
    kind          TEXT NOT NULL DEFAULT 'page',
    title         TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL DEFAULT '',
    cover         TEXT NOT NULL DEFAULT '',
    project_id    {{ID}} REFERENCES projects (id),
    -- Set = a private page of this member (or an agent's memory).
    owner_id      {{ID}} REFERENCES users (id),
    shared_with   {{JSON}},
    -- Set = built from data: decision_log, changelog, open_questions.
    generated     TEXT NOT NULL DEFAULT '',
    -- Agent memory: the agent whose notes this page holds.
    memory_of     {{ID}} REFERENCES users (id),
    -- Database rows: property id -> value. Databases: their own settings.
    props         {{JSON}},
    -- Repository sync: which file this page mirrors.
    source_id     {{ID}},
    source_path   TEXT NOT NULL DEFAULT '',
    source_hash   TEXT NOT NULL DEFAULT '',
    rank          TEXT NOT NULL,
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_by    {{ID}} REFERENCES users (id),
    updated_at    {{TS}} NOT NULL,
    created_seq   {{BIGINT}} NOT NULL,
    -- updated_seq: the page's own fields. content_seq: any block in it.
    updated_seq   {{BIGINT}} NOT NULL,
    content_seq   {{BIGINT}} NOT NULL,
    archived_at   {{TS}},
    deleted_at    {{TS}}
);
CREATE INDEX docs_parent ON docs (workspace_id, parent_id, rank);
CREATE INDEX docs_source ON docs (source_id, source_path);

CREATE TABLE doc_blocks (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    doc_id        {{ID}} NOT NULL REFERENCES docs (id),
    parent_id     {{ID}},
    rank          TEXT NOT NULL,
    type          TEXT NOT NULL,
    props         {{JSON}},
    content       {{JSON}},
    -- The block's plain text, for search and previews.
    plain         TEXT NOT NULL DEFAULT '',
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    updated_by    {{ID}} NOT NULL REFERENCES users (id),
    created_seq   {{BIGINT}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX doc_blocks_doc ON doc_blocks (doc_id, parent_id, rank);

CREATE TABLE doc_versions (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    doc_id        {{ID}} NOT NULL REFERENCES docs (id),
    seq           {{BIGINT}} NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL DEFAULT '',
    snapshot      {{JSON}},
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL
);
CREATE INDEX doc_versions_doc ON doc_versions (doc_id, seq);

-- A column of a database.
CREATE TABLE db_properties (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    database_id   {{ID}} NOT NULL REFERENCES docs (id),
    name          TEXT NOT NULL,
    -- text, number, select, multi_select, date, checkbox, url, member,
    -- relation, rollup, formula, created_at, updated_at
    type          TEXT NOT NULL,
    config        {{JSON}},
    rank          TEXT NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX db_properties_db ON db_properties (database_id, rank);

-- One way of looking at a database: table, board, calendar, gallery,
-- timeline or form.
CREATE TABLE db_views (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    database_id   {{ID}} NOT NULL REFERENCES docs (id),
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,
    config        {{JSON}},
    rank          TEXT NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX db_views_db ON db_views (database_id, rank);

-- A folder of Markdown files in a git repository mirrored as pages.
CREATE TABLE doc_sources (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    root_doc_id   {{ID}} NOT NULL REFERENCES docs (id),
    repo          TEXT NOT NULL,
    branch        TEXT NOT NULL DEFAULT '',
    subdir        TEXT NOT NULL DEFAULT '',
    -- repo: files win a conflict. pages: pages win.
    authority     TEXT NOT NULL DEFAULT 'repo',
    -- commit: page edits are committed. propose: they go to a branch.
    write_mode    TEXT NOT NULL DEFAULT 'commit',
    last_commit   TEXT NOT NULL DEFAULT '',
    last_sync_at  {{TS}},
    last_error    TEXT NOT NULL DEFAULT '',
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);

-- Who has a page open and which block they are in. Rows live for seconds:
-- each is renewed while its page stays open, and dropped when it goes stale.
-- It is a table, not memory, so several servers show the same people.
CREATE TABLE doc_presence (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    doc_id        {{ID}} NOT NULL,
    user_id       {{ID}} NOT NULL,
    block         TEXT NOT NULL DEFAULT '',
    at            {{TS}} NOT NULL,
    PRIMARY KEY (doc_id, user_id)
);
