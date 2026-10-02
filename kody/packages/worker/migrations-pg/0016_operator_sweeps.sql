-- The hourly usage-campaign sweep lists candidate accounts as kody_admin (like the
-- verification stall scan), ordered by when each was last evaluated; every campaign row
-- is then read and written on the candidate's own writer. The operator sees only the
-- evaluation timestamp, never the campaign state or send ledger.
GRANT SELECT (user_id, last_evaluated_at) ON user_usage_campaigns TO kody_admin;
CREATE POLICY user_usage_campaigns_admin_sweep ON user_usage_campaigns FOR SELECT TO kody_admin USING (true);
