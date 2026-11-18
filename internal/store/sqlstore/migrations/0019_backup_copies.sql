-- Whether each backup was also copied where the "backup" setting says:
-- when the copy got there, or why it did not.
ALTER TABLE backups ADD COLUMN copied_at {{TS}};
ALTER TABLE backups ADD COLUMN copy_error TEXT NOT NULL DEFAULT '';
