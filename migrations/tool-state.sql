-- Explicit deployment migration. Keep terminal barriers and claims until application reconciliation.
CREATE TABLE envai_tool_state (
    key text PRIMARY KEY,
    record jsonb NOT NULL
);
