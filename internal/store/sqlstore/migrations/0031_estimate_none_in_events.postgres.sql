-- Before this version a task's estimate of none was said as 0 in the feed:
-- a change that cleared an estimate went "to": 0, and one that set it from
-- none came "from": 0. No 0 was an estimate then (this version makes it one
-- where a project allows zero estimates), so each such 0 is none, and is
-- said as null now, as it is from here on. Only task.updated carried an
-- estimate's change; a task's row in task.created left out an estimate of
-- none.
UPDATE events SET data = jsonb_set(data, '{changes,estimate,from}', 'null'::jsonb)
WHERE type = 'task.updated' AND data #> '{changes,estimate,from}' = '0'::jsonb;
UPDATE events SET data = jsonb_set(data, '{changes,estimate,to}', 'null'::jsonb)
WHERE type = 'task.updated' AND data #> '{changes,estimate,to}' = '0'::jsonb;
