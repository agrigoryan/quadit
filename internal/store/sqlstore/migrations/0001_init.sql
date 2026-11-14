-- Core schema: identity, workspaces, projects, tasks, decisions, and the
-- event feed. Written once for every database; {{TYPE}} macros become the
-- database's own column types (see dialect.go).
--
-- Conventions
--   id          UUIDv7, made by the client or the server
--   *_at        Unix milliseconds, UTC
--   *_seq       a number from the workspace's event sequence
--   deleted_at  set = in the trash; rows are never updated in place to "gone"
--   rank        a string that sorts rows in manual order (see internal/rank)

-- A workspace owns everything below it and the sequence that orders its events.
CREATE TABLE workspaces (
    id          {{ID}} PRIMARY KEY,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    seq         {{BIGINT}} NOT NULL DEFAULT 0,
    created_at  {{TS}} NOT NULL,
    updated_at  {{TS}} NOT NULL,
    deleted_at  {{TS}}
);
CREATE UNIQUE INDEX workspaces_slug ON workspaces (slug) WHERE deleted_at IS NULL;

-- People and agents are the same kind of row, so anything that can point at
-- a person (assignee, author, mention) can point at an agent.
CREATE TABLE users (
    id              {{ID}} PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
    name            TEXT NOT NULL,
    email           TEXT,
    workspace_id    {{ID}} REFERENCES workspaces (id),
    responsible_id  {{ID}} REFERENCES users (id),
    created_by      {{ID}} REFERENCES users (id),
    created_at      {{TS}} NOT NULL,
    updated_at      {{TS}} NOT NULL,
    disabled_at     {{TS}},
    deleted_at      {{TS}},
    -- An agent belongs to one workspace and has a person who answers for it.
    CHECK (kind = 'person' OR (workspace_id IS NOT NULL AND responsible_id IS NOT NULL)),
    CHECK (kind = 'agent' OR email IS NOT NULL)
);
CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE members (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    handle        TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    removed_at    {{TS}},
    PRIMARY KEY (workspace_id, user_id)
);
CREATE UNIQUE INDEX members_handle ON members (workspace_id, handle) WHERE removed_at IS NULL;
CREATE INDEX members_user ON members (user_id);

-- Only the SHA-256 of a token is kept; the prefix is what the interface shows.
CREATE TABLE api_tokens (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    scopes        TEXT NOT NULL DEFAULT '',
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    expires_at    {{TS}},
    last_used_at  {{TS}},
    revoked_at    {{TS}}
);
CREATE UNIQUE INDEX api_tokens_hash ON api_tokens (token_hash);
CREATE INDEX api_tokens_user ON api_tokens (workspace_id, user_id);

-- A project owns its statuses, labels and task numbers (KEY-12).
CREATE TABLE projects (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    key           TEXT NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    task_counter  {{INT}} NOT NULL DEFAULT 0,
    created_by    {{ID}} NOT NULL REFERENCES users (id),
    created_at    {{TS}} NOT NULL,
    updated_at    {{TS}} NOT NULL,
    created_seq   {{BIGINT}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    archived_at   {{TS}},
    deleted_at    {{TS}}
);
CREATE UNIQUE INDEX projects_key ON projects (workspace_id, key) WHERE deleted_at IS NULL;

-- Names, colours and order are the team's; the category is one of a fixed
-- set, so "open", "waiting" and "done" mean the same in every project.
CREATE TABLE statuses (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} NOT NULL REFERENCES projects (id),
    name          TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL CHECK (category IN ('backlog', 'unstarted', 'started', 'waiting', 'done', 'canceled')),
    rank          TEXT NOT NULL,
    is_default    {{BOOL}} NOT NULL,
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX statuses_project ON statuses (project_id, rank);
CREATE UNIQUE INDEX statuses_name ON statuses (project_id, name) WHERE deleted_at IS NULL;

-- project_id NULL = a label shared by the whole workspace.
CREATE TABLE labels (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id    {{ID}} REFERENCES projects (id),
    name          TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT '',
    created_at    {{TS}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX labels_workspace ON labels (workspace_id, project_id);

CREATE TABLE tasks (
    id               {{ID}} PRIMARY KEY,
    workspace_id     {{ID}} NOT NULL REFERENCES workspaces (id),
    project_id       {{ID}} NOT NULL REFERENCES projects (id),
    number           {{INT}} NOT NULL,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    status_id        {{ID}} NOT NULL REFERENCES statuses (id),
    -- 0 none, 1 urgent, 2 high, 3 medium, 4 low
    priority         {{INT}} NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    assignee_id      {{ID}} REFERENCES users (id),
    -- Who has the next move. A member, or an outside event named in the note.
    waiting_on_id    {{ID}} REFERENCES users (id),
    waiting_on_note  TEXT NOT NULL DEFAULT '',
    parent_id        {{ID}} REFERENCES tasks (id),
    rank             TEXT NOT NULL,
    due_on           TEXT,
    created_by       {{ID}} NOT NULL REFERENCES users (id),
    created_at       {{TS}} NOT NULL,
    updated_at       {{TS}} NOT NULL,
    started_at       {{TS}},
    completed_at     {{TS}},
    canceled_at      {{TS}},
    created_seq      {{BIGINT}} NOT NULL,
    -- updated_seq moves when the task's own fields change; activity_seq moves
    -- on anything in the task, comments and decisions included, so "what is
    -- new on this task" never misses a comment.
    updated_seq      {{BIGINT}} NOT NULL,
    activity_seq     {{BIGINT}} NOT NULL,
    archived_at      {{TS}},
    deleted_at       {{TS}},
    deleted_by       {{ID}} REFERENCES users (id)
);
CREATE UNIQUE INDEX tasks_number ON tasks (project_id, number);
CREATE INDEX tasks_activity ON tasks (workspace_id, activity_seq);
CREATE INDEX tasks_status ON tasks (project_id, status_id, rank);
CREATE INDEX tasks_assignee ON tasks (workspace_id, assignee_id);
CREATE INDEX tasks_waiting_on ON tasks (workspace_id, waiting_on_id);
CREATE INDEX tasks_parent ON tasks (parent_id);

CREATE TABLE task_labels (
    task_id       {{ID}} NOT NULL REFERENCES tasks (id),
    label_id      {{ID}} NOT NULL REFERENCES labels (id),
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label ON task_labels (label_id);

-- One row per pair; the reverse name ("blocked by") is derived when read.
CREATE TABLE task_relations (
    id               {{ID}} PRIMARY KEY,
    workspace_id     {{ID}} NOT NULL REFERENCES workspaces (id),
    task_id          {{ID}} NOT NULL REFERENCES tasks (id),
    related_task_id  {{ID}} NOT NULL REFERENCES tasks (id),
    type             TEXT NOT NULL CHECK (type IN ('blocks', 'relates', 'duplicates')),
    created_by       {{ID}} NOT NULL REFERENCES users (id),
    created_at       {{TS}} NOT NULL,
    CHECK (task_id <> related_task_id)
);
CREATE UNIQUE INDEX task_relations_pair ON task_relations (task_id, related_task_id, type);
CREATE INDEX task_relations_reverse ON task_relations (related_task_id);

-- A decision is a question inside a task with options and an answer.
CREATE TABLE decisions (
    id                     {{ID}} PRIMARY KEY,
    workspace_id           {{ID}} NOT NULL REFERENCES workspaces (id),
    task_id                {{ID}} NOT NULL REFERENCES tasks (id),
    -- choice: pick among options. approval: a plain yes or no.
    kind                   TEXT NOT NULL CHECK (kind IN ('choice', 'approval')),
    question               TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN ('open', 'picked', 'sent_back')),
    recommended_option_id  {{ID}},
    recommendation         TEXT NOT NULL DEFAULT '',
    picked_option_id       {{ID}},
    -- as_is: this one. with_changes: this one, see the note. none: try again.
    -- approved / declined: the answer to an approval.
    outcome                TEXT CHECK (outcome IN ('as_is', 'with_changes', 'none', 'approved', 'declined')),
    outcome_note           TEXT NOT NULL DEFAULT '',
    decided_by             {{ID}} REFERENCES users (id),
    decided_at             {{TS}},
    rank                   TEXT NOT NULL,
    created_by             {{ID}} NOT NULL REFERENCES users (id),
    created_at             {{TS}} NOT NULL,
    updated_at             {{TS}} NOT NULL,
    created_seq            {{BIGINT}} NOT NULL,
    updated_seq            {{BIGINT}} NOT NULL,
    deleted_at             {{TS}}
);
CREATE INDEX decisions_task ON decisions (task_id, rank);
CREATE INDEX decisions_open ON decisions (workspace_id, state);

CREATE TABLE decision_options (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    decision_id   {{ID}} NOT NULL REFERENCES decisions (id),
    label         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    rank          TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX decision_options_decision ON decision_options (decision_id, rank);

-- A comment hangs on one subject: a task, a decision, or one option of a
-- decision. task_id names the task whose timeline it shows in.
CREATE TABLE comments (
    id            {{ID}} PRIMARY KEY,
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    task_id       {{ID}} NOT NULL REFERENCES tasks (id),
    subject_type  TEXT NOT NULL CHECK (subject_type IN ('task', 'decision', 'decision_option')),
    subject_id    {{ID}} NOT NULL,
    parent_id     {{ID}} REFERENCES comments (id),
    author_id     {{ID}} NOT NULL REFERENCES users (id),
    body          TEXT NOT NULL,
    created_at    {{TS}} NOT NULL,
    edited_at     {{TS}},
    created_seq   {{BIGINT}} NOT NULL,
    updated_seq   {{BIGINT}} NOT NULL,
    deleted_at    {{TS}}
);
CREATE INDEX comments_task ON comments (task_id, created_seq);
CREATE INDEX comments_subject ON comments (subject_type, subject_id, created_seq);

-- The event feed: every accepted change, in order, with its new values.
-- It is the task timeline, the audit trail of work, what agents read from a
-- cursor, and what a browser replays to keep its local copy current.
--
-- entity is the row that changed; scope is the top-level object whose
-- timeline the event belongs to (a comment's scope is its task).
CREATE TABLE events (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    seq           {{BIGINT}} NOT NULL,
    at            {{TS}} NOT NULL,
    actor_id      {{ID}} NOT NULL REFERENCES users (id),
    change_id     {{ID}} NOT NULL,
    type          TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     {{ID}} NOT NULL,
    scope_type    TEXT NOT NULL,
    scope_id      {{ID}} NOT NULL,
    project_id    {{ID}},
    data          {{JSON}} NOT NULL,
    PRIMARY KEY (workspace_id, seq)
);
CREATE INDEX events_scope ON events (workspace_id, scope_type, scope_id, seq);
CREATE INDEX events_entity ON events (workspace_id, entity_type, entity_id, seq);

-- Every write is a named change with an id made by the caller. Sending the
-- same change twice returns the first answer instead of applying it again.
CREATE TABLE changes (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    id            {{ID}} NOT NULL,
    actor_id      {{ID}} NOT NULL REFERENCES users (id),
    type          TEXT NOT NULL,
    args_hash     TEXT NOT NULL,
    first_seq     {{BIGINT}} NOT NULL,
    last_seq      {{BIGINT}} NOT NULL,
    created_at    {{TS}} NOT NULL,
    PRIMARY KEY (workspace_id, id)
);

-- The server remembers each member's place in the feed, so a session that
-- starts with no memory can ask for "everything since last time".
CREATE TABLE cursors (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    user_id       {{ID}} NOT NULL REFERENCES users (id),
    name          TEXT NOT NULL,
    seq           {{BIGINT}} NOT NULL,
    updated_at    {{TS}} NOT NULL,
    PRIMARY KEY (workspace_id, user_id, name)
);
