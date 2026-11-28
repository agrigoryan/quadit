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
UPDATE rules SET match_on = jsonb_set(match_on, '{to_category}', '"started"'::jsonb), active = FALSE
WHERE CASE WHEN jsonb_typeof(match_on) = 'object' THEN match_on ->> 'to_category' = 'waiting' ELSE FALSE END;
-- A template's status, and the status a GitHub integration moves a task to,
-- read "waiting" (trimmed, in any case) as the type where no status of the
-- task's project was called that: started now. A row of one project whose
-- project has a status of that name meant that status, and still does.
UPDATE templates SET preset = jsonb_set(preset, '{status}', '"started"'::jsonb)
WHERE CASE WHEN jsonb_typeof(preset) = 'object' AND jsonb_typeof(preset -> 'status') = 'string'
        THEN lower(btrim(preset ->> 'status', E' \t\n\r')) = 'waiting' ELSE FALSE END
    AND NOT (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM statuses s
        WHERE s.project_id = templates.project_id AND s.deleted_at IS NULL AND lower(s.name) = 'waiting'));
UPDATE integrations SET config = jsonb_set(config, '{on_open}', '"started"'::jsonb)
WHERE kind = 'github' AND CASE WHEN jsonb_typeof(config) = 'object' AND jsonb_typeof(config -> 'on_open') = 'string'
        THEN lower(btrim(config ->> 'on_open', E' \t\n\r')) = 'waiting' ELSE FALSE END
    AND NOT (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM statuses s
        WHERE s.project_id = integrations.project_id AND s.deleted_at IS NULL AND lower(s.name) = 'waiting'));
UPDATE integrations SET config = jsonb_set(config, '{on_merge}', '"started"'::jsonb)
WHERE kind = 'github' AND CASE WHEN jsonb_typeof(config) = 'object' AND jsonb_typeof(config -> 'on_merge') = 'string'
        THEN lower(btrim(config ->> 'on_merge', E' \t\n\r')) = 'waiting' ELSE FALSE END
    AND NOT (project_id IS NOT NULL AND EXISTS (SELECT 1 FROM statuses s
        WHERE s.project_id = integrations.project_id AND s.deleted_at IS NULL AND lower(s.name) = 'waiting'));
-- The feed says the statuses as they are now, so a copy brought up to date
-- from it never holds a type there is no more.
UPDATE events SET data = jsonb_set(data, '{row,category}', '"started"'::jsonb)
WHERE entity_type = 'status' AND CASE WHEN jsonb_typeof(data -> 'row') = 'object' THEN data #>> '{row,category}' = 'waiting' ELSE FALSE END;
UPDATE events SET data = jsonb_set(data, '{changes,category,from}', '"started"'::jsonb)
WHERE entity_type = 'status' AND CASE WHEN jsonb_typeof(data #> '{changes,category}') = 'object' THEN data #>> '{changes,category,from}' = 'waiting' ELSE FALSE END;
UPDATE events SET data = jsonb_set(data, '{changes,category,to}', '"started"'::jsonb)
WHERE entity_type = 'status' AND CASE WHEN jsonb_typeof(data #> '{changes,category}') = 'object' THEN data #>> '{changes,category,to}' = 'waiting' ELSE FALSE END;
-- Last, the statuses themselves.
UPDATE statuses SET category = 'started' WHERE category = 'waiting';
