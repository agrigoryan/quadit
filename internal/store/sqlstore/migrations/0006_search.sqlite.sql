-- Full-text search on SQLite: one FTS5 table over everything searchable.
CREATE VIRTUAL TABLE search_index USING fts5 (
    title, body,
    workspace_id UNINDEXED, kind UNINDEXED, entity_id UNINDEXED,
    scope_type UNINDEXED, scope_id UNINDEXED, project_id UNINDEXED, audience_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);
-- Which FTS row holds an entity, so replacing one is a lookup, not a scan.
CREATE TABLE search_map (
    entity_id TEXT PRIMARY KEY,
    rid       INTEGER NOT NULL
);
