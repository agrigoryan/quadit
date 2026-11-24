-- A question can be settled without an answer: no longer needed
-- (decision.close, a task closing, an asker moving on from an answer sent
-- back). SQLite cannot change a CHECK in place, so the table is made again
-- with the new state and its rows copied back; decision_options points at
-- it, and that check waits for the end of the upgrade (defer_foreign_keys).
-- The copy back is REPLACE, not INSERT: a restore, which runs again only the
-- statements that change rows, has the new table already.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE decisions_before AS SELECT * FROM decisions;
DROP TABLE decisions;
CREATE TABLE decisions (
    id                     {{ID}} PRIMARY KEY,
    workspace_id           {{ID}} NOT NULL REFERENCES workspaces (id),
    task_id                {{ID}} NOT NULL REFERENCES tasks (id),
    -- choice: pick among options. approval: a plain yes or no.
    kind                   TEXT NOT NULL CHECK (kind IN ('choice', 'approval')),
    question               TEXT NOT NULL,
    details                TEXT NOT NULL DEFAULT '',
    -- approval requests: the action being asked for, e.g. "task.delete".
    action                 TEXT NOT NULL DEFAULT '',
    -- the arguments of that action, exactly as approved, and when it was run:
    -- an approval covers one change and is used once.
    action_args            {{JSON}},
    action_used_at         {{TS}},
    state                  TEXT NOT NULL CHECK (state IN ('open', 'picked', 'sent_back', 'not_needed')),
    asked_id               {{ID}} REFERENCES users (id),
    -- Set when the asker found the answer unclear and asked again.
    unclear_note           TEXT NOT NULL DEFAULT '',
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
    deleted_at             {{TS}},
    approver_projects      {{JSON}}
);
CREATE INDEX decisions_task ON decisions (task_id, rank);
CREATE INDEX decisions_open ON decisions (workspace_id, state);
REPLACE INTO decisions SELECT * FROM decisions_before;
DROP TABLE decisions_before;
-- Questions open or sent back on a task done or canceled ask nothing of
-- anyone: they are no longer needed, settled now by nobody, with no answer;
-- what an answer that sent one back said stays as the reason. Such a task
-- waits on nobody.
UPDATE decisions SET state = 'not_needed', outcome = NULL, decided_by = NULL, decided_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE state IN ('open', 'sent_back')
    AND task_id IN (SELECT t.id FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE s.category IN ('done', 'canceled'));
-- The items that asked them of someone are read, as closing reads them.
UPDATE notifications SET read_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE read_at IS NULL AND entity_type = 'decision' AND type IN ('decision_asked', 'unclear')
    AND entity_id IN (SELECT id FROM decisions WHERE state = 'not_needed');
UPDATE tasks SET waiting_on_id = NULL, waiting_on_note = '', waiting_outside = FALSE
WHERE (waiting_on_id IS NOT NULL OR waiting_outside OR waiting_on_note <> '')
    AND status_id IN (SELECT id FROM statuses WHERE category IN ('done', 'canceled'));
