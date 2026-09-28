-- Distributed replay protection for signed Temporal-to-Cloudflare requests.
-- Rows contain only opaque key/nonce values and expire after the request
-- signature window. Business idempotency remains owned by each operation.
CREATE TABLE temporal_gateway_nonces (
	key_id TEXT NOT NULL,
	nonce TEXT NOT NULL,
	expires_at_ms INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (key_id, nonce)
);

CREATE INDEX idx_temporal_gateway_nonces_expires_at
	ON temporal_gateway_nonces(expires_at_ms);
