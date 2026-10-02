-- Applied only to the dedicated audit database, never the application database.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE kody_audit_writer NOLOGIN;
CREATE ROLE kody_audit_reader NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_audit_writer, kody_audit_reader;

CREATE TABLE audit_events (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	category TEXT NOT NULL CHECK (category IN ('account', 'admin', 'auth', 'oauth')),
	action TEXT NOT NULL,
	result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'rate_limited')),
	email_hash TEXT,
	ip_hash TEXT,
	client_id TEXT,
	path TEXT,
	reason TEXT,
	timestamp TEXT NOT NULL
);
CREATE INDEX idx_audit_events_timestamp ON audit_events(timestamp DESC);
CREATE INDEX idx_audit_events_action_timestamp ON audit_events(action, timestamp DESC);
CREATE INDEX idx_audit_events_email_hash_timestamp ON audit_events(email_hash, timestamp DESC);

GRANT INSERT ON audit_events TO kody_audit_writer;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO kody_audit_writer;
GRANT SELECT ON audit_events TO kody_audit_reader;
