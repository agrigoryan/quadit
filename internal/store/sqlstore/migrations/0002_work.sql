-- Grouping, views, files, the inbox and everything else that hangs off tasks.

-- An epic is a named piece of functionality with its own list of tasks.
CREATE TABLE epics (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} NOT NULL REFERENCES projects (id),
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL CHECK (state IN ('planned', 'active', 'paused', 'done', 'canceled')),
    lead_id       {{ID}} REFERENCES users (id),
    color         TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL DEFAULT '',
    start_on      TEXT,
    target_on     TEXT,
    rank          TEXT NOT NULL,
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    completed_at  {{TS}},
    deleted_at    {{TS}}
);
CREATE INDEX epics_project ON epics (project_id, rank);

CREATE TABLE milestones (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    epic_id       {{ID}} NOT NULL REFERENCES epics (id),
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    target_on     TEXT,
    rank          TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX milestones_epic ON milestones (epic_id, rank);

-- A cycle is a time-boxed sprint. Its state follows its dates.
CREATE TABLE cycles (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} NOT NULL REFERENCES projects (id),
    number        {{INT}} NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    starts_on     TEXT NOT NULL,
    ends_on       TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    -- Set when unfinished tasks were rolled into the next cycle.
    closed_at     {{TS}},
    deleted_at    {{TS}}
);
CREATE INDEX cycles_project ON cycles (project_id, starts_on);

-- A saved filter with a layout. People open it; agents query it by name.
CREATE TABLE views (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} REFERENCES projects (id),
    name          TEXT NOT NULL,
    slug          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    icon          TEXT NOT NULL DEFAULT '',
    owner_id      {{ID}} NOT NULL REFERENCES users (id),
    shared        {{BOOL}} NOT NULL DEFAULT TRUE,
    query         {{JSON}},
    layout        TEXT NOT NULL DEFAULT 'list',
    display       {{JSON}},
    rank          TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE UNIQUE INDEX views_slug ON views (workspace_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE watchers (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    subject_type  TEXT NOT NULL,
    subject_id    {{ID}} NOT NULL,
    created_at    {{TS}} NOT NULL,
    PRIMARY KEY (subject_id, user_id)
);
CREATE INDEX watchers_user ON watchers (workspace_id, user_id);

-- The inbox: one row per thing that concerns a member.
CREATE TABLE notifications (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    seq           {{BIGINT}} NOT NULL,
    -- assigned, mentioned, waiting_on, decision_asked, picked, replied,
    -- comment, result, unclear, status, approval, budget
    type          TEXT NOT NULL,
    actor_id      {{ID}} NOT NULL REFERENCES users (id),
    task_id       {{ID}},
    doc_id        {{ID}},
    entity_type   TEXT NOT NULL DEFAULT '',
    entity_id     {{ID}},
    title         TEXT NOT NULL DEFAULT '',
    snippet       TEXT NOT NULL DEFAULT '',
    created_at    {{TS}} NOT NULL,
    read_at       {{TS}},
    archived_at   {{TS}}
);
CREATE INDEX notifications_user ON notifications (workspace_id, user_id, seq);
CREATE INDEX notifications_unread ON notifications (user_id, read_at);

-- Links from a task to the outside: a branch, a commit, a pull request, a URL.
CREATE TABLE task_links (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    task_id       {{ID}} NOT NULL REFERENCES tasks (id),
    kind          TEXT NOT NULL CHECK (kind IN ('branch', 'commit', 'pr', 'url')),
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
CREATE INDEX task_links_task ON task_links (task_id);
CREATE INDEX task_links_ref ON task_links (workspace_id, kind, repo, ref);

-- Who mentions what: the "linked from" list on tasks, decisions and docs.
CREATE TABLE refs (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    from_type     TEXT NOT NULL,
    from_id       {{ID}} NOT NULL,
    -- The task or doc the mention sits in, for showing where it is.
    from_scope_type TEXT NOT NULL,
    from_scope_id {{ID}} NOT NULL,
    to_type       TEXT NOT NULL,
    to_id         {{ID}} NOT NULL,
    PRIMARY KEY (from_id, to_id)
);
CREATE INDEX refs_to ON refs (to_id);

CREATE TABLE templates (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} REFERENCES projects (id),
    name          TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    -- Fields a new task starts with: priority, labels, a decision skeleton.
    preset        {{JSON}},
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);

-- A standing preference: a decision turned into a rule agents are shown.
CREATE TABLE preferences (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} REFERENCES projects (id),
    body          TEXT NOT NULL,
    decision_id   {{ID}},
    label_ids     {{JSON}},
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    retired_at    {{TS}},
    deleted_at    {{TS}}
);
CREATE INDEX preferences_ws ON preferences (workspace_id, project_id);

-- A stored file. The bytes live in file storage under storage_key.
CREATE TABLE files (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    name          TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    size          {{BIGINT}} NOT NULL,
    received      {{BIGINT}} NOT NULL DEFAULT 0,
    sha256        TEXT NOT NULL DEFAULT '',
    storage_key   TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('uploading', 'ready')),
    width         {{INT}},
    height        {{INT}},
    duration_ms   {{BIGINT}},
    -- A reduced copy of an image, or a sheet of stills from a clip.
    preview_key   TEXT NOT NULL DEFAULT '',
    uploaded_by   {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX files_ws ON files (workspace_id, created_at);

-- A file shown on something: a task, a comment, one option of a decision.
CREATE TABLE attachments (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    file_id       {{ID}} NOT NULL REFERENCES files (id),
    subject_type  TEXT NOT NULL CHECK (subject_type IN ('task', 'comment', 'decision', 'decision_option', 'doc')),
    subject_id    {{ID}} NOT NULL,
    task_id       {{ID}},
    -- '' or one side of a pair: before, after
    role          TEXT NOT NULL DEFAULT '',
    caption       TEXT NOT NULL DEFAULT '',
    rank          TEXT NOT NULL,
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX attachments_subject ON attachments (subject_id, rank);
CREATE INDEX attachments_task ON attachments (task_id);
