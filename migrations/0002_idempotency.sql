CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    operation TEXT NOT NULL,
    response_digest TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
