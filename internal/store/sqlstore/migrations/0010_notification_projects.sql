-- An inbox item's event in the feed belongs to the project of the task or
-- the page it is about, so that a feed kept to other projects (a token made
-- for some) leaves it out. Until this version it belonged to none, and was
-- given to every reader it was addressed to.
UPDATE events SET project_id = (SELECT tasks.project_id FROM tasks WHERE tasks.id = events.scope_id)
WHERE type = 'notification.created' AND scope_type = 'task';
UPDATE events SET project_id = (SELECT docs.project_id FROM docs WHERE docs.id = events.scope_id)
WHERE type = 'notification.created' AND scope_type = 'doc';
