-- The status type "waiting" is gone: the types are backlog, unstarted,
-- started, done and canceled, and who a task waits on is its waiting_on.
-- Every status of type waiting becomes an ordinary started status, with its
-- name, color and place kept; no task moves. What named the type is
-- rewritten first, while the statuses still say which were waiting.
--
-- The statuses' CHECK still admits 'waiting': an archive made before this
-- version is loaded into this schema as it is, and only then are these
-- statements run on its rows again (UpgradeLoaded). A stored JSON value is
-- read only where it is what the server stores (a list, a text), so a null
-- or a value of another shape is left as it is.
--
-- Saved views are left as they are: one that asks for the type has that
-- part left out when it is read, with a note, as a status deleted since is
-- (Resolver.TaskFilter).
-- A rule on a move into the type cannot say those statuses alone: it is
-- turned off, on started, for an admin to look at again rather than fire
-- on every move into started.
UPDATE rules SET match_on = json_set(match_on, '$.to_category', 'started'), active = FALSE
WHERE json_valid(match_on) AND json_type(match_on, '$.to_category') = 'text' AND json_extract(match_on, '$.to_category') = 'waiting';
-- A template's status, and the status a GitHub integration moves a task to,
-- read "waiting" (trimmed, in any case) as the type where no status of the
-- task's project was called that: started now. A row of one project whose
-- project has a status of that name meant that status, and still does.
UPDATE templates SET preset = json_set(preset, '$.status', 'started')
WHERE json_valid(preset) AND json_type(preset, '$.status') = 'text'
    AND lower(trim(json_extract(preset, '$.status'), ' ' || char(9, 10, 13))) = 'waiting'
    AND NOT (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM statuses s
        WHERE s.project_id = templates.project_id AND s.deleted_at IS NULL AND lower(s.name) = 'waiting'));
UPDATE integrations SET config = json_set(config, '$.on_open', 'started')
WHERE kind = 'github' AND json_valid(config) AND json_type(config, '$.on_open') = 'text'
    AND lower(trim(json_extract(config, '$.on_open'), ' ' || char(9, 10, 13))) = 'waiting'
    AND NOT (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM statuses s
        WHERE s.project_id = integrations.project_id AND s.deleted_at IS NULL AND lower(s.name) = 'waiting'));
UPDATE integrations SET config = json_set(config, '$.on_merge', 'started')
WHERE kind = 'github' AND json_valid(config) AND json_type(config, '$.on_merge') = 'text'
    AND lower(trim(json_extract(config, '$.on_merge'), ' ' || char(9, 10, 13))) = 'waiting'
    AND NOT (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM statuses s
        WHERE s.project_id = integrations.project_id AND s.deleted_at IS NULL AND lower(s.name) = 'waiting'));
-- The feed says the statuses as they are now, so a copy brought up to date
-- from it never holds a type there is no more.
UPDATE events SET data = json_set(data, '$.row.category', 'started')
WHERE entity_type = 'status' AND json_valid(data) AND json_type(data, '$.row.category') = 'text' AND json_extract(data, '$.row.category') = 'waiting';
UPDATE events SET data = json_set(data, '$.changes.category.from', 'started')
WHERE entity_type = 'status' AND json_valid(data) AND json_type(data, '$.changes.category.from') = 'text' AND json_extract(data, '$.changes.category.from') = 'waiting';
UPDATE events SET data = json_set(data, '$.changes.category.to', 'started')
WHERE entity_type = 'status' AND json_valid(data) AND json_type(data, '$.changes.category.to') = 'text' AND json_extract(data, '$.changes.category.to') = 'waiting';
-- Last, the statuses themselves.
UPDATE statuses SET category = 'started' WHERE category = 'waiting';
