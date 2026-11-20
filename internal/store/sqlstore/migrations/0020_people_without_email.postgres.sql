-- A person may have no email address, as an agent has none: the owner of an
-- install the desktop app sets up signs in through the app, and adds an
-- address (and a password) only to sign in from a browser. The check that
-- required one is the table's second unnamed one, which Postgres named
-- users_check1.
ALTER TABLE users DROP CONSTRAINT users_check1;
