-- The parts of an upload that comes in several requests, in order: the
-- keys in file storage of the parts kept so far. A part is written under
-- a key of its own and then listed here in the same statement that counts
-- its bytes, so two parts sent at once for one place cannot both be kept.
ALTER TABLE files ADD COLUMN parts {{JSON}};
