-- Full-text search on Postgres: one table with a generated tsvector.
CREATE TABLE search_index (
    workspace_id  UUID NOT NULL,
    kind          TEXT NOT NULL,
    entity_id     UUID NOT NULL,
    scope_type    TEXT NOT NULL,
    scope_id      UUID NOT NULL,
    project_id    UUID,
    audience_id   UUID,
    title         TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    tsv           tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body), 'B')) STORED,
    PRIMARY KEY (entity_id)
);
CREATE INDEX search_index_tsv ON search_index USING GIN (tsv);
CREATE INDEX search_index_ws ON search_index (workspace_id);
