-- A session made for taking a picture of a page signs the browser in with
-- the reach of the request that asked for the picture: the workspace it
-- was asked in, and the scopes of its credential, written as a token's
-- are ("read", "project:ID"). A person's own session has neither.
ALTER TABLE sessions ADD COLUMN workspace_id {{ID}};
ALTER TABLE sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '';
