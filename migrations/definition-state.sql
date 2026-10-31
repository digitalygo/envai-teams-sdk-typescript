-- Explicit deployment migration. The SDK never creates or resets this table.
CREATE TABLE envai_definition_state (
    scope text PRIMARY KEY,
    state jsonb NOT NULL
);
