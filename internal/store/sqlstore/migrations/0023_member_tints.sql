-- The color a member's initials are drawn on: one of the web app's
-- MemberTints tints, 1 to 8, chosen when the member is made as the one
-- used least among the workspace's members, and kept. Members there
-- already get theirs in the order they joined, by the same rule: the
-- current members one after another through the tints, and so do those
-- removed, who are still drawn in the history.
ALTER TABLE members ADD COLUMN tint INTEGER;
UPDATE members SET tint = ranked.n % 8 + 1
FROM (SELECT workspace_id, user_id, ROW_NUMBER() OVER (PARTITION BY workspace_id, removed_at IS NULL ORDER BY created_at, user_id) - 1 AS n FROM members) AS ranked
WHERE ranked.workspace_id = members.workspace_id AND ranked.user_id = members.user_id;
