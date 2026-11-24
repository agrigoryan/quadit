-- From this version an agent follows only what it chose to follow. Before,
-- it was made to follow every task, epic and page it commented on, was
-- mentioned in, made, was given or asked a question on, and those rows
-- cannot be told apart from chosen ones: an agent's follows of those three
-- kinds end, so an upgraded workspace wakes its agents as a new one does.
-- Projects and views were only ever followed by choice, and stay.
DELETE FROM watchers
WHERE subject_type IN ('task', 'epic', 'doc')
  AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = watchers.workspace_id AND m.user_id = watchers.user_id AND m.kind = 'agent');
