-- The sample tasks a project was made with ("Getting started", on a new
-- install or when asked for), in order, so they are found again exactly:
-- to remove them, and to give the third to an agent. NULL for every other
-- project.
ALTER TABLE projects ADD COLUMN samples {{JSON}};
