-- Storage-byte sweeps (estimate backfill, repo-session inventory reconcile and the
-- storage-byte reconcile lane) list work fleet-wide as kody_admin and then read and
-- write each account's rows on that account's own writer. The operator sees only the
-- inventory columns and owner ids, never bucket contents, and advances the two
-- platform-owned singleton cursors.
GRANT SELECT (user_id, storage_id, kind, last_seen_at, estimated_bytes)
  ON user_storage_buckets TO kody_admin;
CREATE POLICY user_storage_buckets_admin_sweep ON user_storage_buckets
  FOR SELECT TO kody_admin USING (true);
GRANT SELECT (user_id, due_at) ON repo_session_due_owners TO kody_admin;
CREATE POLICY repo_session_due_owners_admin_sweep ON repo_session_due_owners
  FOR SELECT TO kody_admin USING (true);
GRANT SELECT, UPDATE ON repo_session_storage_bucket_cursor, d1_storage_reconcile_cursor
  TO kody_admin;
