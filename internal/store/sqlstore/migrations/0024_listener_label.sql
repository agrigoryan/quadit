-- What holds a member's listener lease, in words a person reads ("a chat",
-- "a companion", "the Quadit app"), as the holder said when it took it,
-- and since when it has held it.
ALTER TABLE members ADD COLUMN listen_by TEXT;
ALTER TABLE members ADD COLUMN listen_since {{TS}};
