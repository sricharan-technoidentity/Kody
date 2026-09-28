-- Phase 8 makes Temporal the only job schedule backend. The backend column is
-- retained for on-disk compatibility, but every live row is normalized and
-- the temporary rollout cursor is removed.
UPDATE job_schedule_bindings
SET backend = 'temporal',
	backend_changed_at = COALESCE(backend_changed_at, updated_at);

UPDATE job_schedule_outbox
SET payload_json = json_set(payload_json, '$.backend', 'temporal')
WHERE desired_operation = 'upsert';

DROP TABLE temporal_job_rollout_state;

DROP INDEX idx_job_schedule_bindings_backend_state;
