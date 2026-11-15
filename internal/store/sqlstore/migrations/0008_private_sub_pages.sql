-- A page under a private page is private the same way. Until this version,
-- making a page private left the pages already under it to everyone: each
-- of those takes the owner and the sharing of the nearest private page
-- above it, as it would now.
WITH RECURSIVE heir (id, owner_id, shared_with) AS (
    SELECT k.id, p.owner_id, p.shared_with FROM docs k JOIN docs p ON p.id = k.parent_id
    WHERE p.owner_id IS NOT NULL AND k.owner_id IS NULL
    UNION
    SELECT k.id, h.owner_id, h.shared_with FROM docs k JOIN heir h ON h.id = k.parent_id
    WHERE k.owner_id IS NULL
)
UPDATE docs SET
    owner_id = (SELECT h.owner_id FROM heir h WHERE h.id = docs.id),
    shared_with = (SELECT h.shared_with FROM heir h WHERE h.id = docs.id)
WHERE id IN (SELECT id FROM heir);
