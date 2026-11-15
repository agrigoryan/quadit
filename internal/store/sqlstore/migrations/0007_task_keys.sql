-- The keys a task had before it moved to another project: SVA-23 still finds
-- the task once it has become OPS-5. A key is never given to another task.
CREATE TABLE task_keys (
    workspace_id  {{ID}} NOT NULL REFERENCES workspaces (id),
    key           TEXT NOT NULL,
    task_id       {{ID}} NOT NULL,
    at            {{TS}} NOT NULL,
    PRIMARY KEY (workspace_id, key)
);
CREATE INDEX task_keys_task ON task_keys (task_id);
