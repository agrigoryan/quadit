-- Whether a session's sign-in took two steps: a passkey, or a first step
-- and a code (or the first second step set up while signed in). Where the
-- install requires two steps, that is what lets a session in, not what the
-- account has set up. A session from before cannot tell, so it is taken to
-- have taken one: such a session is asked for its second step again.
ALTER TABLE sessions ADD COLUMN two_step {{BOOL}} NOT NULL DEFAULT FALSE;
