-- Runtime roles never own tables or bypass RLS. Role switching is host-only.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE kody_admin NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_admin;
GRANT SELECT ON roles, permissions, role_permissions, feature_flags, site_banners, platform_provider_marks TO kody_reader, kody_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kody_writer;

ALTER TABLE "password_resets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_resets" FORCE ROW LEVEL SECURITY;
CREATE POLICY password_resets_owner ON "password_resets" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "password_resets" TO kody_writer;
GRANT SELECT ON "password_resets" TO kody_reader;

ALTER TABLE "value_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "value_buckets" FORCE ROW LEVEL SECURITY;
CREATE POLICY value_buckets_owner ON "value_buckets" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "value_buckets" TO kody_writer;
GRANT SELECT ON "value_buckets" TO kody_reader;

ALTER TABLE "value_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "value_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY value_entries_owner ON "value_entries" TO kody_writer, kody_reader USING (EXISTS (SELECT 1 FROM value_buckets b WHERE b.id = bucket_id AND b.user_id = current_setting('app.user_id', true))) WITH CHECK (EXISTS (SELECT 1 FROM value_buckets b WHERE b.id = bucket_id AND b.user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "value_entries" TO kody_writer;
GRANT SELECT ON "value_entries" TO kody_reader;

ALTER TABLE "mcp_user_server_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_user_server_instructions" FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_user_server_instructions_owner ON "mcp_user_server_instructions" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_user_server_instructions" TO kody_writer;
GRANT SELECT ON "mcp_user_server_instructions" TO kody_reader;

ALTER TABLE "mcp_memories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_memories" FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_memories_owner ON "mcp_memories" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_memories" TO kody_writer;
GRANT SELECT ON "mcp_memories" TO kody_reader;

ALTER TABLE "mcp_memory_conversation_suppressions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_memory_conversation_suppressions" FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_memory_conversation_suppressions_owner ON "mcp_memory_conversation_suppressions" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_memory_conversation_suppressions" TO kody_writer;
GRANT SELECT ON "mcp_memory_conversation_suppressions" TO kody_reader;

ALTER TABLE "entity_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_sources_owner ON "entity_sources" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "entity_sources" TO kody_writer;
GRANT SELECT ON "entity_sources" TO kody_reader;

ALTER TABLE "saved_packages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_packages" FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_packages_owner ON "saved_packages" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_packages" TO kody_writer;
GRANT SELECT ON "saved_packages" TO kody_reader;

ALTER TABLE "published_bundle_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "published_bundle_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY published_bundle_artifacts_owner ON "published_bundle_artifacts" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "published_bundle_artifacts" TO kody_writer;
GRANT SELECT ON "published_bundle_artifacts" TO kody_reader;

ALTER TABLE "email_inboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_inboxes" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_inboxes_owner ON "email_inboxes" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_inboxes" TO kody_writer;
GRANT SELECT ON "email_inboxes" TO kody_reader;

ALTER TABLE "email_inbox_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_inbox_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_inbox_addresses_owner ON "email_inbox_addresses" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_inbox_addresses" TO kody_writer;
GRANT SELECT ON "email_inbox_addresses" TO kody_reader;

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_owner ON "user_roles" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_roles" TO kody_writer;
GRANT SELECT ON "user_roles" TO kody_reader;

ALTER TABLE "community_ratings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_ratings" FORCE ROW LEVEL SECURITY;
CREATE POLICY community_ratings_owner ON "community_ratings" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "community_ratings" TO kody_writer;
GRANT SELECT ON "community_ratings" TO kody_reader;

ALTER TABLE "community_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY community_reports_owner ON "community_reports" TO kody_writer, kody_reader USING ("reporter_user_id" = current_setting('app.user_id', true)) WITH CHECK ("reporter_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "community_reports" TO kody_writer;
GRANT SELECT ON "community_reports" TO kody_reader;

ALTER TABLE "community_bans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_bans" FORCE ROW LEVEL SECURITY;
CREATE POLICY community_bans_owner ON "community_bans" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "community_bans" TO kody_writer;
GRANT SELECT ON "community_bans" TO kody_reader;

ALTER TABLE "email_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_verifications_owner ON "email_verifications" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_verifications" TO kody_writer;
GRANT SELECT ON "email_verifications" TO kody_reader;

ALTER TABLE "usage_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_rollups_owner ON "usage_rollups" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "usage_rollups" TO kody_writer;
GRANT SELECT ON "usage_rollups" TO kody_reader;

ALTER TABLE "pending_email_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_email_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_email_changes_owner ON "pending_email_changes" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_email_changes" TO kody_writer;
GRANT SELECT ON "pending_email_changes" TO kody_reader;

ALTER TABLE "mcp_server_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_server_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_server_settings_owner ON "mcp_server_settings" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_server_settings" TO kody_writer;
GRANT SELECT ON "mcp_server_settings" TO kody_reader;

ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY verifications_owner ON "verifications" TO kody_writer, kody_reader USING (target IN (SELECT id::text FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK (target IN (SELECT id::text FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "verifications" TO kody_writer;
GRANT SELECT ON "verifications" TO kody_reader;

ALTER TABLE "passkeys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "passkeys" FORCE ROW LEVEL SECURITY;
CREATE POLICY passkeys_owner ON "passkeys" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "passkeys" TO kody_writer;
GRANT SELECT ON "passkeys" TO kody_reader;

ALTER TABLE "oauth_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_connections_owner ON "oauth_connections" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "oauth_connections" TO kody_writer;
GRANT SELECT ON "oauth_connections" TO kody_reader;

ALTER TABLE "secret_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_buckets" FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_buckets_owner ON "secret_buckets" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "secret_buckets" TO kody_writer;
GRANT SELECT ON "secret_buckets" TO kody_reader;

ALTER TABLE "feature_flag_user_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_user_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_user_overrides_owner ON "feature_flag_user_overrides" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "feature_flag_user_overrides" TO kody_writer;
GRANT SELECT ON "feature_flag_user_overrides" TO kody_reader;

ALTER TABLE "community_activity_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_activity_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY community_activity_events_owner ON "community_activity_events" TO kody_writer, kody_reader USING ("actor_user_id" = current_setting('app.user_id', true)) WITH CHECK ("actor_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "community_activity_events" TO kody_writer;
GRANT SELECT ON "community_activity_events" TO kody_reader;

ALTER TABLE "community_forks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_forks" FORCE ROW LEVEL SECURITY;
CREATE POLICY community_forks_owner ON "community_forks" TO kody_writer, kody_reader USING ("forker_user_id" = current_setting('app.user_id', true)) WITH CHECK ("forker_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "community_forks" TO kody_writer;
GRANT SELECT ON "community_forks" TO kody_reader;

ALTER TABLE "package_scope_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_scope_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY package_scope_grants_owner ON "package_scope_grants" TO kody_writer, kody_reader USING (("scope_owner_user_id" = current_setting('app.user_id', true) OR grantee_user_id = current_setting('app.user_id', true))) WITH CHECK (("scope_owner_user_id" = current_setting('app.user_id', true) OR grantee_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "package_scope_grants" TO kody_writer;
GRANT SELECT ON "package_scope_grants" TO kody_reader;

ALTER TABLE "agent_package_conversation_uses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_package_conversation_uses" FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_package_conversation_uses_owner ON "agent_package_conversation_uses" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_package_conversation_uses" TO kody_writer;
GRANT SELECT ON "agent_package_conversation_uses" TO kody_reader;

ALTER TABLE "email_sender_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_sender_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_sender_identities_owner ON "email_sender_identities" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_sender_identities" TO kody_writer;
GRANT SELECT ON "email_sender_identities" TO kody_reader;

ALTER TABLE "mcp_agent_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mcp_agent_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY mcp_agent_sessions_owner ON "mcp_agent_sessions" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_agent_sessions" TO kody_writer;
GRANT SELECT ON "mcp_agent_sessions" TO kody_reader;

ALTER TABLE "account_write_lease_repairs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_write_lease_repairs" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_write_lease_repairs_owner ON "account_write_lease_repairs" TO kody_writer, kody_reader USING ("target_user_id" = current_setting('app.user_id', true)) WITH CHECK ("target_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "account_write_lease_repairs" TO kody_writer;
GRANT SELECT ON "account_write_lease_repairs" TO kody_reader;

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_owner ON "webhook_endpoints" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_endpoints" TO kody_writer;
GRANT SELECT ON "webhook_endpoints" TO kody_reader;

ALTER TABLE "user_oauth_apps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_oauth_apps" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_oauth_apps_owner ON "user_oauth_apps" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_oauth_apps" TO kody_writer;
GRANT SELECT ON "user_oauth_apps" TO kody_reader;

ALTER TABLE "email_sender_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_sender_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_sender_rules_owner ON "email_sender_rules" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_sender_rules" TO kody_writer;
GRANT SELECT ON "email_sender_rules" TO kody_reader;

ALTER TABLE "package_codemod_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_codemod_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY package_codemod_runs_owner ON "package_codemod_runs" TO kody_writer, kody_reader USING ("scope_user_id" = current_setting('app.user_id', true)) WITH CHECK ("scope_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "package_codemod_runs" TO kody_writer;
GRANT SELECT ON "package_codemod_runs" TO kody_reader;

ALTER TABLE "package_codemod_run_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_codemod_run_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY package_codemod_run_items_owner ON "package_codemod_run_items" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "package_codemod_run_items" TO kody_writer;
GRANT SELECT ON "package_codemod_run_items" TO kody_reader;

ALTER TABLE "feature_flag_exposure_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "feature_flag_exposure_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_exposure_rollups_owner ON "feature_flag_exposure_rollups" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "feature_flag_exposure_rollups" TO kody_writer;
GRANT SELECT ON "feature_flag_exposure_rollups" TO kody_reader;

ALTER TABLE "email_outbound_provider_index" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_outbound_provider_index" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_outbound_provider_index_owner ON "email_outbound_provider_index" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_outbound_provider_index" TO kody_writer;
GRANT SELECT ON "email_outbound_provider_index" TO kody_reader;

ALTER TABLE "email_inbound_due_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_inbound_due_owners" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_inbound_due_owners_owner ON "email_inbound_due_owners" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_inbound_due_owners" TO kody_writer;
GRANT SELECT ON "email_inbound_due_owners" TO kody_reader;

ALTER TABLE "email_outbound_provider_index_repair_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_outbound_provider_index_repair_owners" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_outbound_provider_index_repair_owners_owner ON "email_outbound_provider_index_repair_owners" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_outbound_provider_index_repair_owners" TO kody_writer;
GRANT SELECT ON "email_outbound_provider_index_repair_owners" TO kody_reader;

ALTER TABLE "user_repos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_repos" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_repos_owner ON "user_repos" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_repos" TO kody_writer;
GRANT SELECT ON "user_repos" TO kody_reader;

ALTER TABLE "entity_source_artifacts_push_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_source_artifacts_push_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY entity_source_artifacts_push_subscriptions_owner ON "entity_source_artifacts_push_subscriptions" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "entity_source_artifacts_push_subscriptions" TO kody_writer;
GRANT SELECT ON "entity_source_artifacts_push_subscriptions" TO kody_reader;

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY users_owner ON "users" TO kody_writer, kody_reader USING ("stable_user_id" = current_setting('app.user_id', true)) WITH CHECK ("stable_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO kody_writer;
GRANT SELECT ON "users" TO kody_reader;

ALTER TABLE "user_integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_integrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_integrations_owner ON "user_integrations" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_integrations" TO kody_writer;
GRANT SELECT ON "user_integrations" TO kody_reader;

ALTER TABLE "saved_package_search_index_debt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_package_search_index_debt" FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_package_search_index_debt_owner ON "saved_package_search_index_debt" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_package_search_index_debt" TO kody_writer;
GRANT SELECT ON "saved_package_search_index_debt" TO kody_reader;

ALTER TABLE "username_redirects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "username_redirects" FORCE ROW LEVEL SECURITY;
CREATE POLICY username_redirects_owner ON "username_redirects" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "username_redirects" TO kody_writer;
GRANT SELECT ON "username_redirects" TO kody_reader;

ALTER TABLE "package_kody_id_redirects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_kody_id_redirects" FORCE ROW LEVEL SECURITY;
CREATE POLICY package_kody_id_redirects_owner ON "package_kody_id_redirects" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "package_kody_id_redirects" TO kody_writer;
GRANT SELECT ON "package_kody_id_redirects" TO kody_reader;

ALTER TABLE "repo_session_due_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "repo_session_due_owners" FORCE ROW LEVEL SECURITY;
CREATE POLICY repo_session_due_owners_owner ON "repo_session_due_owners" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "repo_session_due_owners" TO kody_writer;
GRANT SELECT ON "repo_session_due_owners" TO kody_reader;

ALTER TABLE "user_storage_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_storage_buckets" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_storage_buckets_owner ON "user_storage_buckets" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_storage_buckets" TO kody_writer;
GRANT SELECT ON "user_storage_buckets" TO kody_reader;

ALTER TABLE "package_invocation_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_invocation_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY package_invocation_tokens_owner ON "package_invocation_tokens" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "package_invocation_tokens" TO kody_writer;
GRANT SELECT ON "package_invocation_tokens" TO kody_reader;

ALTER TABLE "user_mcp_oauth_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_mcp_oauth_clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_mcp_oauth_clients_owner ON "user_mcp_oauth_clients" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_mcp_oauth_clients" TO kody_writer;
GRANT SELECT ON "user_mcp_oauth_clients" TO kody_reader;

ALTER TABLE "vector_embed_fingerprints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vector_embed_fingerprints" FORCE ROW LEVEL SECURITY;
CREATE POLICY vector_embed_fingerprints_owner ON "vector_embed_fingerprints" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "vector_embed_fingerprints" TO kody_writer;
GRANT SELECT ON "vector_embed_fingerprints" TO kody_reader;

ALTER TABLE "transactional_email_delivery_index" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactional_email_delivery_index" FORCE ROW LEVEL SECURITY;
CREATE POLICY transactional_email_delivery_index_owner ON "transactional_email_delivery_index" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "transactional_email_delivery_index" TO kody_writer;
GRANT SELECT ON "transactional_email_delivery_index" TO kody_reader;

ALTER TABLE "secret_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_entries_owner ON "secret_entries" TO kody_writer, kody_reader USING (EXISTS (SELECT 1 FROM secret_buckets b WHERE b.id = bucket_id AND b.user_id = current_setting('app.user_id', true))) WITH CHECK (EXISTS (SELECT 1 FROM secret_buckets b WHERE b.id = bucket_id AND b.user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "secret_entries" TO kody_writer;
GRANT SELECT ON "secret_entries" TO kody_reader;

ALTER TABLE "platform_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_feedback_owner ON "platform_feedback" TO kody_writer, kody_reader USING ("submitter_user_id" = current_setting('app.user_id', true)) WITH CHECK ("submitter_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_feedback" TO kody_writer;
GRANT SELECT ON "platform_feedback" TO kody_reader;

ALTER TABLE "community_listings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "community_listings" FORCE ROW LEVEL SECURITY;
CREATE POLICY community_listings_owner ON "community_listings" TO kody_writer, kody_reader USING ("owner_user_id" = current_setting('app.user_id', true)) WITH CHECK ("owner_user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "community_listings" TO kody_writer;
GRANT SELECT ON "community_listings" TO kody_reader;

ALTER TABLE "user_email_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_email_claims" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_email_claims_owner ON "user_email_claims" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_email_claims" TO kody_writer;
GRANT SELECT ON "user_email_claims" TO kody_reader;

ALTER TABLE "pending_email_claim_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_email_claim_releases" FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_email_claim_releases_owner ON "pending_email_claim_releases" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_email_claim_releases" TO kody_writer;
GRANT SELECT ON "pending_email_claim_releases" TO kody_reader;

ALTER TABLE "referrals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "referrals" FORCE ROW LEVEL SECURITY;
CREATE POLICY referrals_owner ON "referrals" TO kody_writer, kody_reader USING (("referee_stable_user_id" = current_setting('app.user_id', true) OR referrer_stable_user_id = current_setting('app.user_id', true))) WITH CHECK (("referee_stable_user_id" = current_setting('app.user_id', true) OR referrer_stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "referrals" TO kody_writer;
GRANT SELECT ON "referrals" TO kody_reader;

ALTER TABLE "user_tips_email_opt_outs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_tips_email_opt_outs" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_tips_email_opt_outs_owner ON "user_tips_email_opt_outs" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_tips_email_opt_outs" TO kody_writer;
GRANT SELECT ON "user_tips_email_opt_outs" TO kody_reader;

ALTER TABLE "user_usage_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_usage_campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_usage_campaigns_owner ON "user_usage_campaigns" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_usage_campaigns" TO kody_writer;
GRANT SELECT ON "user_usage_campaigns" TO kody_reader;

ALTER TABLE "user_usage_campaign_sends" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_usage_campaign_sends" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_usage_campaign_sends_owner ON "user_usage_campaign_sends" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_usage_campaign_sends" TO kody_writer;
GRANT SELECT ON "user_usage_campaign_sends" TO kody_reader;

ALTER TABLE "site_banner_dismissals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_banner_dismissals" FORCE ROW LEVEL SECURITY;
CREATE POLICY site_banner_dismissals_owner ON "site_banner_dismissals" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "site_banner_dismissals" TO kody_writer;
GRANT SELECT ON "site_banner_dismissals" TO kody_reader;

ALTER TABLE "package_share_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "package_share_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY package_share_grants_owner ON "package_share_grants" TO kody_writer, kody_reader USING (("owner_user_id" = current_setting('app.user_id', true) OR grantee_user_id = current_setting('app.user_id', true))) WITH CHECK (("owner_user_id" = current_setting('app.user_id', true) OR grantee_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "package_share_grants" TO kody_writer;
GRANT SELECT ON "package_share_grants" TO kody_reader;

ALTER TABLE "email_notification_destinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_notification_destinations" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_notification_destinations_owner ON "email_notification_destinations" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_notification_destinations" TO kody_writer;
GRANT SELECT ON "email_notification_destinations" TO kody_reader;

ALTER TABLE "pending_email_destination_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_email_destination_verifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_email_destination_verifications_owner ON "pending_email_destination_verifications" TO kody_writer, kody_reader USING ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))) WITH CHECK ("user_id" = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_email_destination_verifications" TO kody_writer;
GRANT SELECT ON "pending_email_destination_verifications" TO kody_reader;

ALTER TABLE "secret_provider_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_provider_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_provider_bindings_owner ON "secret_provider_bindings" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "secret_provider_bindings" TO kody_writer;
GRANT SELECT ON "secret_provider_bindings" TO kody_reader;

ALTER TABLE "secret_provider_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "secret_provider_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY secret_provider_grants_owner ON "secret_provider_grants" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "secret_provider_grants" TO kody_writer;
GRANT SELECT ON "secret_provider_grants" TO kody_reader;

ALTER TABLE "webhook_apply_destination_pending" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_apply_destination_pending" FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_apply_destination_pending_owner ON "webhook_apply_destination_pending" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_apply_destination_pending" TO kody_writer;
GRANT SELECT ON "webhook_apply_destination_pending" TO kody_reader;

ALTER TABLE "webhook_apply_destination_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_apply_destination_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_apply_destination_grants_owner ON "webhook_apply_destination_grants" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_apply_destination_grants" TO kody_writer;
GRANT SELECT ON "webhook_apply_destination_grants" TO kody_reader;

ALTER TABLE "durable_object_duration_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_object_duration_daily" FORCE ROW LEVEL SECURITY;
CREATE POLICY durable_object_duration_daily_owner ON "durable_object_duration_daily" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "durable_object_duration_daily" TO kody_writer;
GRANT SELECT ON "durable_object_duration_daily" TO kody_reader;

ALTER TABLE "credit_wallets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_wallets" FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_wallets_owner ON "credit_wallets" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_wallets" TO kody_writer;
GRANT SELECT ON "credit_wallets" TO kody_reader;

ALTER TABLE "credit_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_entries_owner ON "credit_ledger_entries" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_ledger_entries" TO kody_writer;
GRANT SELECT ON "credit_ledger_entries" TO kody_reader;

ALTER TABLE "credit_debit_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_debit_progress" FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_debit_progress_owner ON "credit_debit_progress" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "credit_debit_progress" TO kody_writer;
GRANT SELECT ON "credit_debit_progress" TO kody_reader;

ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_owner ON "jobs" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "jobs" TO kody_writer;
GRANT SELECT ON "jobs" TO kody_reader;

ALTER TABLE "archived_job_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "archived_job_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY archived_job_artifacts_owner ON "archived_job_artifacts" TO kody_writer, kody_reader USING ("user_id" = current_setting('app.user_id', true)) WITH CHECK ("user_id" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "archived_job_artifacts" TO kody_writer;
GRANT SELECT ON "archived_job_artifacts" TO kody_reader;

-- Four exceptions: account/RBAC administration, system email, approved feedback, public activity metadata.
GRANT SELECT, INSERT, UPDATE, DELETE ON users, roles, permissions, role_permissions, user_roles TO kody_admin;
GRANT USAGE, SELECT ON SEQUENCE users_id_seq, roles_id_seq, permissions_id_seq TO kody_admin;
CREATE POLICY users_admin ON users TO kody_admin USING (true) WITH CHECK (true);
CREATE POLICY user_roles_admin ON user_roles TO kody_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON system_email_threads, system_email_messages, system_email_attachments, system_email_delivery_events, system_email_daily_counters, system_email_graph_authority TO kody_admin;
-- Presence in platform_feedback already means the user approved submission.
GRANT SELECT ON platform_feedback TO kody_admin;
GRANT UPDATE (status, reviewed_by_user_id, reviewed_at, admin_note, revision, updated_at) ON platform_feedback TO kody_admin;
CREATE POLICY platform_feedback_admin ON platform_feedback TO kody_admin USING (true) WITH CHECK (true);
-- Public metadata views deliberately omit rating notes and package source.
CREATE VIEW public_community_ratings AS SELECT r.listing_id, r.user_id, r.stars, r.adaptation_effort, r.created_at FROM community_ratings r JOIN community_listings l ON l.id = r.listing_id WHERE l.status = 'active';
CREATE VIEW public_community_forks AS SELECT f.listing_id, f.forker_user_id, f.created_at FROM community_forks f JOIN community_listings l ON l.id = f.listing_id WHERE l.status = 'active';
GRANT SELECT ON public_community_ratings, public_community_forks TO kody_admin;
