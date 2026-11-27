-- Before this version a deleted comment kept what its text mentioned: the
-- members, tasks, pages and decisions it named stayed mentioned, and a task
-- went on listing a page only that comment named. Deleting a comment takes
-- them away from this version on; the comments deleted before lose theirs
-- here.
DELETE FROM refs WHERE from_type = 'comment' AND from_id IN (SELECT id FROM comments WHERE deleted_at IS NOT NULL);
