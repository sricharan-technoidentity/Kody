-- The retention lane prunes aged growth rows across every account. NOLOGIN kody_retention
-- can only read and delete those tables (it inserts and updates nothing), plus read the
-- three entity_sources columns that decide whether a published bundle is still current.
CREATE ROLE kody_retention NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_retention;
GRANT SELECT, DELETE ON mcp_memory_conversation_suppressions, platform_feedback,
  published_bundle_artifacts, usage_rollups, feature_flag_exposure_rollups,
  stripe_webhook_events, agent_package_conversation_uses TO kody_retention;
GRANT SELECT (id, user_id, published_commit) ON entity_sources TO kody_retention;
CREATE POLICY mcp_memory_conversation_suppressions_retention ON mcp_memory_conversation_suppressions TO kody_retention USING (true);
CREATE POLICY platform_feedback_retention ON platform_feedback TO kody_retention USING (true);
CREATE POLICY published_bundle_artifacts_retention ON published_bundle_artifacts TO kody_retention USING (true);
CREATE POLICY usage_rollups_retention ON usage_rollups TO kody_retention USING (true);
CREATE POLICY feature_flag_exposure_rollups_retention ON feature_flag_exposure_rollups TO kody_retention USING (true);
CREATE POLICY agent_package_conversation_uses_retention ON agent_package_conversation_uses TO kody_retention USING (true);
CREATE POLICY entity_sources_retention ON entity_sources FOR SELECT TO kody_retention USING (true);
