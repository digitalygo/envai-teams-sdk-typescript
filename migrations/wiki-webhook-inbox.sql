-- Apply explicitly with your deployment tooling. Constructor/receive never run DDL.
CREATE TABLE envai_wiki_webhook_receipts (
    deduplication_key text PRIMARY KEY,
    connection_scope text NOT NULL,
    workspace_id text NOT NULL,
    event_id text NOT NULL,
    payload_hash text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (connection_scope, workspace_id, event_id)
);
CREATE TABLE envai_wiki_application_outbox (
    deduplication_key text PRIMARY KEY REFERENCES envai_wiki_webhook_receipts(deduplication_key),
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    raw_body bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
