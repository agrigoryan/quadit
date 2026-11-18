-- An approval reaches no further than the one who gave it did when giving
-- it: through their membership and the credential they answered with (a
-- token limited to some projects). Those projects are kept with the
-- answer, and the change the approval allows is held to them when it is
-- made. NULL is every project, as for an answer from before.
ALTER TABLE decisions ADD COLUMN approver_projects {{JSON}};
