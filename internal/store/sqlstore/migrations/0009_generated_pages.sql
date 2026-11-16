-- A page built from data (a decision log, a changelog, the open questions)
-- is built for each reader when it is read, from what that reader may see.
-- Until this version it was written into the page by its first reader, for
-- everyone: its text, with every project's decisions and tasks, was in the
-- page's blocks, in search, in what the page mentions, in its versions and
-- in its events in the feed. All of that is taken out; the page stays.
DELETE FROM doc_blocks WHERE doc_id IN (SELECT id FROM docs WHERE generated <> '');
DELETE FROM doc_versions WHERE doc_id IN (SELECT id FROM docs WHERE generated <> '');
DELETE FROM refs WHERE from_type = 'doc' AND from_id IN (SELECT id FROM docs WHERE generated <> '');
-- The page's edits stay in the feed, where positions are never reused,
-- without the blocks they wrote.
UPDATE events SET data = '{"blocks":null,"deleted":null}'
WHERE type = 'doc.edited' AND scope_id IN (SELECT id FROM docs WHERE generated <> '');
-- Search finds the page by its title alone.
UPDATE search_index SET body = '' WHERE kind = 'doc' AND entity_id IN (SELECT id FROM docs WHERE generated <> '');
-- What the page kept in its props was when it was last built.
UPDATE docs SET props = NULL WHERE generated <> '';
