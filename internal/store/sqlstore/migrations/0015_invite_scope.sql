-- An invitation made by someone who reaches only some projects admits the
-- new member to those projects only: the limit is kept with the invitation
-- (a scope, as a member's), and given to the member who accepts it.
ALTER TABLE invites ADD COLUMN scope {{JSON}};
