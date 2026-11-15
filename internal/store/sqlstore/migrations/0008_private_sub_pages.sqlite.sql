-- Search keeps a private page, and the comments on it, to its owner. The
-- pages above were indexed for everyone, and so was a page that was made
-- private itself.
UPDATE search_index SET audience_id = (SELECT d.owner_id FROM docs d WHERE d.id = search_index.scope_id)
WHERE scope_type = 'doc' AND audience_id = ''
    AND scope_id IN (SELECT id FROM docs WHERE owner_id IS NOT NULL);
