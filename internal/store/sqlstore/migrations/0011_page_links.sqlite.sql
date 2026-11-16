-- A task may be linked to a page of the workspace: a link of kind 'doc',
-- whose ref is the page's id. SQLite cannot change a CHECK in place, so the
-- table is made again with the new kind allowed and its rows copied over.
-- The copy is REPLACE, not INSERT: it is part of making the table again,
-- and a restore, which runs again only the statements that change rows
-- (UpgradeLoaded: UPDATE, INSERT, DELETE, WITH), has the new table already.
CREATE TABLE task_links_new (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    task_id       {{ID}} NOT NULL REFERENCES tasks (id),
    kind          TEXT NOT NULL CHECK (kind IN ('branch', 'commit', 'pr', 'issue', 'url', 'doc')),
    url           TEXT NOT NULL DEFAULT '',
    title         TEXT NOT NULL DEFAULT '',
    repo          TEXT NOT NULL DEFAULT '',
    ref           TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT '',
    checks        TEXT NOT NULL DEFAULT '',
    data          {{JSON}},
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
REPLACE INTO task_links_new SELECT id, workspace_id, task_id, kind, url, title, repo, ref, state, checks, data,
    created_by, created_at, updated_at, updated_seq, deleted_at FROM task_links;
DROP TABLE task_links;
ALTER TABLE task_links_new RENAME TO task_links;
CREATE INDEX task_links_task ON task_links (task_id);
CREATE INDEX task_links_ref ON task_links (workspace_id, kind, repo, ref);
