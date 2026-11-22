-- What holds a member's listener lease, in words a person reads ("a chat",
-- "a companion", "the Quadit app"), as the holder said when it took it.
ALTER TABLE members ADD COLUMN listen_by TEXT;
