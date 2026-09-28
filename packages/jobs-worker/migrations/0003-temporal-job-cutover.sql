-- Phase 3 Temporal scheduled-job cutover. Raw owner/job ids remain in JOBS_DB;
-- Temporal carries only these deterministic opaque hashes.
ALTER TABLE job_schedule_bindings ADD COLUMN temporal_user_hash TEXT;
ALTER TABLE job_schedule_bindings ADD COLUMN temporal_job_id TEXT;
ALTER TABLE job_schedule_bindings ADD COLUMN backend_changed_at TEXT;

-- Phase 2 outbox payloads already contain the opaque identifiers. Recover them
-- here so existing shadowed jobs are immediately eligible for a gated cutover
-- without exposing or re-hashing raw ids outside JOBS_DB.
UPDATE job_schedule_bindings
SET temporal_user_hash = (
		SELECT json_extract(payload_json, '$.userHash')
		FROM job_schedule_outbox
		WHERE user_id = job_schedule_bindings.user_id
			AND job_id = job_schedule_bindings.job_id
			AND desired_operation = 'upsert'
		ORDER BY desired_version DESC
		LIMIT 1
	),
	temporal_job_id = (
		SELECT json_extract(payload_json, '$.jobId')
		FROM job_schedule_outbox
		WHERE user_id = job_schedule_bindings.user_id
			AND job_id = job_schedule_bindings.job_id
			AND desired_operation = 'upsert'
		ORDER BY desired_version DESC
		LIMIT 1
	);

CREATE UNIQUE INDEX idx_job_schedule_bindings_temporal_identity
	ON job_schedule_bindings(temporal_user_hash, temporal_job_id)
	WHERE temporal_user_hash IS NOT NULL AND temporal_job_id IS NOT NULL;

CREATE INDEX idx_job_schedule_bindings_backend_state
	ON job_schedule_bindings(backend, state, updated_at);

CREATE TABLE temporal_job_rollout_state (
	singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
	cursor_schedule_id TEXT
);

INSERT INTO temporal_job_rollout_state (singleton, cursor_schedule_id)
	VALUES (1, NULL);
