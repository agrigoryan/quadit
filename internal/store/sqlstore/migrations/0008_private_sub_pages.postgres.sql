-- Search keeps a private page, and the comments on it, to its owner. The
-- pages above were indexed for everyone, and so was a page that was made
-- private itself.
UPDATE search_index SET audience_id = d.owner_id FROM docs d
WHERE search_index.scope_type = 'doc' AND search_index.scope_id = d.id
    AND search_index.audience_id IS NULL AND d.owner_id IS NOT NULL;
