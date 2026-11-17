-- A comment thread started on words of a page keeps those words (quote),
-- and when an edit takes them out of the page, the time it did
-- (detached_at): the thread then stands for the page as a whole, the
-- words shown with it. The words themselves carry the thread's marker in
-- the page's text.
ALTER TABLE comments ADD COLUMN quote TEXT;
ALTER TABLE comments ADD COLUMN detached_at {{TS}};
