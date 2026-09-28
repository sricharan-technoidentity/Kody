-- Phase 2 Temporal schedule shadowing. The job definition remains authoritative
-- and every Temporal Schedule created from these rows stays paused.
CREATE TABLE job_schedule_bindings (
	job_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	backend TEXT NOT NULL DEFAULT 'cloudflare'
		CHECK (backend IN ('cloudflare', 'temporal')),
	temporal_schedule_id TEXT NOT NULL,
	desired_version INTEGER NOT NULL CHECK (desired_version > 0),
	applied_version INTEGER NOT NULL DEFAULT 0 CHECK (applied_version >= 0),
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending', 'in_sync', 'drifted', 'error', 'deleting')),
	last_error TEXT,
	expected_next_run_at TEXT,
	observed_next_run_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, job_id),
	UNIQUE (temporal_schedule_id)
);

CREATE INDEX idx_job_schedule_bindings_state
	ON job_schedule_bindings(state, updated_at);

CREATE TABLE job_schedule_outbox (
	operation_id TEXT PRIMARY KEY NOT NULL,
	job_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	desired_operation TEXT NOT NULL
		CHECK (desired_operation IN ('upsert', 'delete')),
	desired_version INTEGER NOT NULL CHECK (desired_version > 0),
	payload_json TEXT NOT NULL,
	payload_hash TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending', 'processing', 'applied')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT NOT NULL,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	applied_at TEXT,
	UNIQUE (user_id, job_id, desired_version)
);

CREATE INDEX idx_job_schedule_outbox_pending
	ON job_schedule_outbox(state, next_attempt_at, created_at);
