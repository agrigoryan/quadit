-- A task may be linked to a page of the workspace: a link of kind 'doc',
-- whose ref is the page's id.
ALTER TABLE task_links DROP CONSTRAINT task_links_kind_check;
ALTER TABLE task_links ADD CONSTRAINT task_links_kind_check CHECK (kind IN ('branch', 'commit', 'pr', 'issue', 'url', 'doc'));
