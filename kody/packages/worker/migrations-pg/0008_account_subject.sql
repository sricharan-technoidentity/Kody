-- Generated from accountUserDataTargets (packages/worker/src/account/data-targets.ts);
-- account/data-targets.node.test.ts proves it covers the inventory.
-- Account export and deletion act for one data subject (app.user_id) across every column
-- the inventory matches, including attribution on other users' rows. Ordinary owner RLS
-- hides those rows, so deletion would silently leave the subject's id behind.
-- kody_subject_reader: SELECT only the rows the export inventory selects.
-- kody_subject_purger: SELECT/DELETE matched rows, plus EXECUTE on kody_subject_anonymize().
CREATE ROLE kody_subject_reader NOLOGIN;
CREATE ROLE kody_subject_purger NOLOGIN;
CREATE ROLE kody_subject_anonymizer NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_subject_reader, kody_subject_purger, kody_subject_anonymizer;

GRANT SELECT ON users TO kody_subject_reader, kody_subject_purger, kody_subject_anonymizer;
GRANT DELETE, UPDATE (deleting_at, updated_at) ON users TO kody_subject_purger;
CREATE POLICY users_subject ON users TO kody_subject_reader, kody_subject_purger USING (stable_user_id = current_setting('app.user_id', true)) WITH CHECK (stable_user_id = current_setting('app.user_id', true));
CREATE POLICY users_subject_anonymize ON users FOR SELECT TO kody_subject_anonymizer USING (true);

GRANT SELECT ON account_write_lease_repairs TO kody_subject_reader;
CREATE POLICY account_write_lease_repairs_subject_read ON account_write_lease_repairs FOR SELECT TO kody_subject_reader USING ((account_write_lease_repairs.target_user_id = current_setting('app.user_id', true)) OR (account_write_lease_repairs.repaired_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT ON account_write_lease_repairs TO kody_subject_purger;
CREATE POLICY account_write_lease_repairs_subject_purge ON account_write_lease_repairs TO kody_subject_purger USING ((account_write_lease_repairs.target_user_id = current_setting('app.user_id', true)) OR (account_write_lease_repairs.repaired_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, UPDATE ON account_write_lease_repairs TO kody_subject_anonymizer;
CREATE POLICY account_write_lease_repairs_subject_anonymize ON account_write_lease_repairs TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON agent_package_conversation_uses TO kody_subject_reader;
CREATE POLICY agent_package_conversation_uses_subject_read ON agent_package_conversation_uses FOR SELECT TO kody_subject_reader USING ((agent_package_conversation_uses.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON agent_package_conversation_uses TO kody_subject_purger;
CREATE POLICY agent_package_conversation_uses_subject_purge ON agent_package_conversation_uses TO kody_subject_purger USING ((agent_package_conversation_uses.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON community_activity_events TO kody_subject_reader;
CREATE POLICY community_activity_events_subject_read ON community_activity_events FOR SELECT TO kody_subject_reader USING ((community_activity_events.actor_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON community_activity_events TO kody_subject_purger;
CREATE POLICY community_activity_events_subject_purge ON community_activity_events TO kody_subject_purger USING ((community_activity_events.listing_id IN ( SELECT id FROM community_listings WHERE owner_user_id = current_setting('app.user_id', true) )) OR (community_activity_events.actor_user_id = current_setting('app.user_id', true)));

GRANT SELECT ON community_bans TO kody_subject_reader;
CREATE POLICY community_bans_subject_read ON community_bans FOR SELECT TO kody_subject_reader USING ((community_bans.user_id = current_setting('app.user_id', true)) OR (community_bans.banned_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON community_bans TO kody_subject_purger;
CREATE POLICY community_bans_subject_purge ON community_bans TO kody_subject_purger USING ((community_bans.user_id = current_setting('app.user_id', true)) OR (community_bans.banned_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, UPDATE ON community_bans TO kody_subject_anonymizer;
CREATE POLICY community_bans_subject_anonymize ON community_bans TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON community_forks TO kody_subject_reader;
CREATE POLICY community_forks_subject_read ON community_forks FOR SELECT TO kody_subject_reader USING ((community_forks.forker_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON community_forks TO kody_subject_purger;
CREATE POLICY community_forks_subject_purge ON community_forks TO kody_subject_purger USING ((community_forks.listing_id IN ( SELECT id FROM community_listings WHERE owner_user_id = current_setting('app.user_id', true) )) OR (community_forks.forker_user_id = current_setting('app.user_id', true)));

GRANT SELECT ON community_listings TO kody_subject_reader;
CREATE POLICY community_listings_subject_read ON community_listings FOR SELECT TO kody_subject_reader USING ((community_listings.owner_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON community_listings TO kody_subject_purger;
CREATE POLICY community_listings_subject_purge ON community_listings TO kody_subject_purger USING ((community_listings.owner_user_id = current_setting('app.user_id', true)));

GRANT SELECT ON community_ratings TO kody_subject_reader;
CREATE POLICY community_ratings_subject_read ON community_ratings FOR SELECT TO kody_subject_reader USING ((community_ratings.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON community_ratings TO kody_subject_purger;
CREATE POLICY community_ratings_subject_purge ON community_ratings TO kody_subject_purger USING ((community_ratings.listing_id IN ( SELECT id FROM community_listings WHERE owner_user_id = current_setting('app.user_id', true) )) OR (community_ratings.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON community_reports TO kody_subject_reader;
CREATE POLICY community_reports_subject_read ON community_reports FOR SELECT TO kody_subject_reader USING ((community_reports.reporter_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON community_reports TO kody_subject_purger;
CREATE POLICY community_reports_subject_purge ON community_reports TO kody_subject_purger USING ((community_reports.listing_id IN ( SELECT id FROM community_listings WHERE owner_user_id = current_setting('app.user_id', true) )) OR (community_reports.listing_owner_user_id = current_setting('app.user_id', true) OR community_reports.reporter_user_id = current_setting('app.user_id', true)) OR (community_reports.reporter_user_id = current_setting('app.user_id', true)) OR (community_reports.resolved_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, UPDATE ON community_reports TO kody_subject_anonymizer;
CREATE POLICY community_reports_subject_anonymize ON community_reports TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON credit_debit_progress TO kody_subject_reader;
CREATE POLICY credit_debit_progress_subject_read ON credit_debit_progress FOR SELECT TO kody_subject_reader USING ((credit_debit_progress.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON credit_debit_progress TO kody_subject_purger;
CREATE POLICY credit_debit_progress_subject_purge ON credit_debit_progress TO kody_subject_purger USING ((credit_debit_progress.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON credit_ledger_entries TO kody_subject_reader;
CREATE POLICY credit_ledger_entries_subject_read ON credit_ledger_entries FOR SELECT TO kody_subject_reader USING ((credit_ledger_entries.granted_by_user_id = current_setting('app.user_id', true)) OR (credit_ledger_entries.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON credit_ledger_entries TO kody_subject_purger;
CREATE POLICY credit_ledger_entries_subject_purge ON credit_ledger_entries TO kody_subject_purger USING ((credit_ledger_entries.granted_by_user_id = current_setting('app.user_id', true)) OR (credit_ledger_entries.user_id = current_setting('app.user_id', true)));
GRANT SELECT, UPDATE ON credit_ledger_entries TO kody_subject_anonymizer;
CREATE POLICY credit_ledger_entries_subject_anonymize ON credit_ledger_entries TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON credit_wallets TO kody_subject_reader;
CREATE POLICY credit_wallets_subject_read ON credit_wallets FOR SELECT TO kody_subject_reader USING ((credit_wallets.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON credit_wallets TO kody_subject_purger;
CREATE POLICY credit_wallets_subject_purge ON credit_wallets TO kody_subject_purger USING ((credit_wallets.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON durable_object_duration_daily TO kody_subject_reader;
CREATE POLICY durable_object_duration_daily_subject_read ON durable_object_duration_daily FOR SELECT TO kody_subject_reader USING ((durable_object_duration_daily.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON durable_object_duration_daily TO kody_subject_purger;
CREATE POLICY durable_object_duration_daily_subject_purge ON durable_object_duration_daily TO kody_subject_purger USING ((durable_object_duration_daily.user_id = current_setting('app.user_id', true)));

GRANT SELECT, DELETE ON email_inbound_due_owners TO kody_subject_purger;
CREATE POLICY email_inbound_due_owners_subject_purge ON email_inbound_due_owners TO kody_subject_purger USING ((email_inbound_due_owners.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON email_inbox_addresses TO kody_subject_reader;
CREATE POLICY email_inbox_addresses_subject_read ON email_inbox_addresses FOR SELECT TO kody_subject_reader USING ((email_inbox_addresses.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON email_inbox_addresses TO kody_subject_purger;
CREATE POLICY email_inbox_addresses_subject_purge ON email_inbox_addresses TO kody_subject_purger USING ((email_inbox_addresses.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON email_inboxes TO kody_subject_reader;
CREATE POLICY email_inboxes_subject_read ON email_inboxes FOR SELECT TO kody_subject_reader USING ((email_inboxes.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON email_inboxes TO kody_subject_purger;
CREATE POLICY email_inboxes_subject_purge ON email_inboxes TO kody_subject_purger USING ((email_inboxes.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON email_notification_destinations TO kody_subject_reader;
CREATE POLICY email_notification_destinations_subject_read ON email_notification_destinations FOR SELECT TO kody_subject_reader USING ((email_notification_destinations.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON email_notification_destinations TO kody_subject_purger;
CREATE POLICY email_notification_destinations_subject_purge ON email_notification_destinations TO kody_subject_purger USING ((email_notification_destinations.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT, DELETE ON email_outbound_provider_index TO kody_subject_purger;
CREATE POLICY email_outbound_provider_index_subject_purge ON email_outbound_provider_index TO kody_subject_purger USING ((email_outbound_provider_index.user_id = current_setting('app.user_id', true)));

GRANT SELECT, DELETE ON email_outbound_provider_index_repair_owners TO kody_subject_purger;
CREATE POLICY email_outbound_provider_index_repair_owners_subject_purge ON email_outbound_provider_index_repair_owners TO kody_subject_purger USING ((email_outbound_provider_index_repair_owners.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON email_sender_identities TO kody_subject_reader;
CREATE POLICY email_sender_identities_subject_read ON email_sender_identities FOR SELECT TO kody_subject_reader USING ((email_sender_identities.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON email_sender_identities TO kody_subject_purger;
CREATE POLICY email_sender_identities_subject_purge ON email_sender_identities TO kody_subject_purger USING ((email_sender_identities.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON email_sender_rules TO kody_subject_reader;
CREATE POLICY email_sender_rules_subject_read ON email_sender_rules FOR SELECT TO kody_subject_reader USING ((email_sender_rules.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON email_sender_rules TO kody_subject_purger;
CREATE POLICY email_sender_rules_subject_purge ON email_sender_rules TO kody_subject_purger USING ((email_sender_rules.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON email_verifications TO kody_subject_reader;
CREATE POLICY email_verifications_subject_read ON email_verifications FOR SELECT TO kody_subject_reader USING ((email_verifications.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON email_verifications TO kody_subject_purger;
CREATE POLICY email_verifications_subject_purge ON email_verifications TO kody_subject_purger USING ((email_verifications.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON entity_source_artifacts_push_subscriptions TO kody_subject_reader;
CREATE POLICY entity_source_artifacts_push_subscriptions_subject_read ON entity_source_artifacts_push_subscriptions FOR SELECT TO kody_subject_reader USING ((entity_source_artifacts_push_subscriptions.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON entity_source_artifacts_push_subscriptions TO kody_subject_purger;
CREATE POLICY entity_source_artifacts_push_subscriptions_subject_purge ON entity_source_artifacts_push_subscriptions TO kody_subject_purger USING ((entity_source_artifacts_push_subscriptions.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON entity_sources TO kody_subject_reader;
CREATE POLICY entity_sources_subject_read ON entity_sources FOR SELECT TO kody_subject_reader USING ((entity_sources.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON entity_sources TO kody_subject_purger;
CREATE POLICY entity_sources_subject_purge ON entity_sources TO kody_subject_purger USING ((entity_sources.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON feature_flag_exposure_rollups TO kody_subject_reader;
CREATE POLICY feature_flag_exposure_rollups_subject_read ON feature_flag_exposure_rollups FOR SELECT TO kody_subject_reader USING ((feature_flag_exposure_rollups.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON feature_flag_exposure_rollups TO kody_subject_purger;
CREATE POLICY feature_flag_exposure_rollups_subject_purge ON feature_flag_exposure_rollups TO kody_subject_purger USING ((feature_flag_exposure_rollups.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON feature_flag_user_overrides TO kody_subject_reader;
CREATE POLICY feature_flag_user_overrides_subject_read ON feature_flag_user_overrides FOR SELECT TO kody_subject_reader USING ((feature_flag_user_overrides.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON feature_flag_user_overrides TO kody_subject_purger;
CREATE POLICY feature_flag_user_overrides_subject_purge ON feature_flag_user_overrides TO kody_subject_purger USING ((feature_flag_user_overrides.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON mcp_agent_sessions TO kody_subject_reader;
CREATE POLICY mcp_agent_sessions_subject_read ON mcp_agent_sessions FOR SELECT TO kody_subject_reader USING ((mcp_agent_sessions.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON mcp_agent_sessions TO kody_subject_purger;
CREATE POLICY mcp_agent_sessions_subject_purge ON mcp_agent_sessions TO kody_subject_purger USING ((mcp_agent_sessions.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON mcp_memories TO kody_subject_reader;
CREATE POLICY mcp_memories_subject_read ON mcp_memories FOR SELECT TO kody_subject_reader USING ((mcp_memories.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON mcp_memories TO kody_subject_purger;
CREATE POLICY mcp_memories_subject_purge ON mcp_memories TO kody_subject_purger USING ((mcp_memories.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON mcp_memory_conversation_suppressions TO kody_subject_reader;
CREATE POLICY mcp_memory_conversation_suppressions_subject_read ON mcp_memory_conversation_suppressions FOR SELECT TO kody_subject_reader USING ((mcp_memory_conversation_suppressions.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON mcp_memory_conversation_suppressions TO kody_subject_purger;
CREATE POLICY mcp_memory_conversation_suppressions_subject_purge ON mcp_memory_conversation_suppressions TO kody_subject_purger USING ((mcp_memory_conversation_suppressions.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON mcp_server_settings TO kody_subject_reader;
CREATE POLICY mcp_server_settings_subject_read ON mcp_server_settings FOR SELECT TO kody_subject_reader USING ((mcp_server_settings.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON mcp_server_settings TO kody_subject_purger;
CREATE POLICY mcp_server_settings_subject_purge ON mcp_server_settings TO kody_subject_purger USING ((mcp_server_settings.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON mcp_user_server_instructions TO kody_subject_reader;
CREATE POLICY mcp_user_server_instructions_subject_read ON mcp_user_server_instructions FOR SELECT TO kody_subject_reader USING ((mcp_user_server_instructions.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON mcp_user_server_instructions TO kody_subject_purger;
CREATE POLICY mcp_user_server_instructions_subject_purge ON mcp_user_server_instructions TO kody_subject_purger USING ((mcp_user_server_instructions.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON oauth_connections TO kody_subject_reader;
CREATE POLICY oauth_connections_subject_read ON oauth_connections FOR SELECT TO kody_subject_reader USING ((oauth_connections.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON oauth_connections TO kody_subject_purger;
CREATE POLICY oauth_connections_subject_purge ON oauth_connections TO kody_subject_purger USING ((oauth_connections.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON package_codemod_run_items TO kody_subject_reader;
CREATE POLICY package_codemod_run_items_subject_read ON package_codemod_run_items FOR SELECT TO kody_subject_reader USING ((package_codemod_run_items.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON package_codemod_run_items TO kody_subject_purger;
CREATE POLICY package_codemod_run_items_subject_purge ON package_codemod_run_items TO kody_subject_purger USING ((package_codemod_run_items.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON package_codemod_runs TO kody_subject_reader;
CREATE POLICY package_codemod_runs_subject_read ON package_codemod_runs FOR SELECT TO kody_subject_reader USING ((package_codemod_runs.scope_user_id = current_setting('app.user_id', true)) OR (package_codemod_runs.initiated_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT ON package_codemod_runs TO kody_subject_purger;
CREATE POLICY package_codemod_runs_subject_purge ON package_codemod_runs TO kody_subject_purger USING ((package_codemod_runs.scope_user_id = current_setting('app.user_id', true)) OR (package_codemod_runs.initiated_by_user_id = current_setting('app.user_id', true)) OR (length(replace(package_codemod_runs.filters_json, '"' || current_setting('app.user_id', true) || '"', '')) < length(package_codemod_runs.filters_json)));
GRANT SELECT, UPDATE ON package_codemod_runs TO kody_subject_anonymizer;
CREATE POLICY package_codemod_runs_subject_anonymize ON package_codemod_runs TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON package_invocation_tokens TO kody_subject_reader;
CREATE POLICY package_invocation_tokens_subject_read ON package_invocation_tokens FOR SELECT TO kody_subject_reader USING ((package_invocation_tokens.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON package_invocation_tokens TO kody_subject_purger;
CREATE POLICY package_invocation_tokens_subject_purge ON package_invocation_tokens TO kody_subject_purger USING ((package_invocation_tokens.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON package_kody_id_redirects TO kody_subject_reader;
CREATE POLICY package_kody_id_redirects_subject_read ON package_kody_id_redirects FOR SELECT TO kody_subject_reader USING ((package_kody_id_redirects.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON package_kody_id_redirects TO kody_subject_purger;
CREATE POLICY package_kody_id_redirects_subject_purge ON package_kody_id_redirects TO kody_subject_purger USING ((package_kody_id_redirects.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON package_scope_grants TO kody_subject_reader;
CREATE POLICY package_scope_grants_subject_read ON package_scope_grants FOR SELECT TO kody_subject_reader USING ((package_scope_grants.scope_owner_user_id = current_setting('app.user_id', true) OR package_scope_grants.grantee_user_id = current_setting('app.user_id', true)) OR (package_scope_grants.created_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON package_scope_grants TO kody_subject_purger;
CREATE POLICY package_scope_grants_subject_purge ON package_scope_grants TO kody_subject_purger USING ((package_scope_grants.scope_owner_user_id = current_setting('app.user_id', true) OR package_scope_grants.grantee_user_id = current_setting('app.user_id', true)) OR (package_scope_grants.created_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, UPDATE ON package_scope_grants TO kody_subject_anonymizer;
CREATE POLICY package_scope_grants_subject_anonymize ON package_scope_grants TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON package_share_grants TO kody_subject_reader;
CREATE POLICY package_share_grants_subject_read ON package_share_grants FOR SELECT TO kody_subject_reader USING ((package_share_grants.owner_user_id = current_setting('app.user_id', true) OR package_share_grants.grantee_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON package_share_grants TO kody_subject_purger;
CREATE POLICY package_share_grants_subject_purge ON package_share_grants TO kody_subject_purger USING ((package_share_grants.owner_user_id = current_setting('app.user_id', true) OR package_share_grants.grantee_user_id = current_setting('app.user_id', true)));

GRANT SELECT ON passkeys TO kody_subject_reader;
CREATE POLICY passkeys_subject_read ON passkeys FOR SELECT TO kody_subject_reader USING ((passkeys.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON passkeys TO kody_subject_purger;
CREATE POLICY passkeys_subject_purge ON passkeys TO kody_subject_purger USING ((passkeys.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON password_resets TO kody_subject_reader;
CREATE POLICY password_resets_subject_read ON password_resets FOR SELECT TO kody_subject_reader USING ((password_resets.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON password_resets TO kody_subject_purger;
CREATE POLICY password_resets_subject_purge ON password_resets TO kody_subject_purger USING ((password_resets.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON pending_email_changes TO kody_subject_reader;
CREATE POLICY pending_email_changes_subject_read ON pending_email_changes FOR SELECT TO kody_subject_reader USING ((pending_email_changes.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON pending_email_changes TO kody_subject_purger;
CREATE POLICY pending_email_changes_subject_purge ON pending_email_changes TO kody_subject_purger USING ((pending_email_changes.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON pending_email_claim_releases TO kody_subject_reader;
CREATE POLICY pending_email_claim_releases_subject_read ON pending_email_claim_releases FOR SELECT TO kody_subject_reader USING ((pending_email_claim_releases.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON pending_email_claim_releases TO kody_subject_purger;
CREATE POLICY pending_email_claim_releases_subject_purge ON pending_email_claim_releases TO kody_subject_purger USING ((pending_email_claim_releases.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON pending_email_destination_verifications TO kody_subject_reader;
CREATE POLICY pending_email_destination_verifications_subject_read ON pending_email_destination_verifications FOR SELECT TO kody_subject_reader USING ((pending_email_destination_verifications.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON pending_email_destination_verifications TO kody_subject_purger;
CREATE POLICY pending_email_destination_verifications_subject_purge ON pending_email_destination_verifications TO kody_subject_purger USING ((pending_email_destination_verifications.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON platform_feedback TO kody_subject_reader;
CREATE POLICY platform_feedback_subject_read ON platform_feedback FOR SELECT TO kody_subject_reader USING ((platform_feedback.submitter_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON platform_feedback TO kody_subject_purger;
CREATE POLICY platform_feedback_subject_purge ON platform_feedback TO kody_subject_purger USING ((platform_feedback.submitter_user_id = current_setting('app.user_id', true)) OR (platform_feedback.reviewed_by_user_id = current_setting('app.user_id', true)));
GRANT SELECT, UPDATE ON platform_feedback TO kody_subject_anonymizer;
CREATE POLICY platform_feedback_subject_anonymize ON platform_feedback TO kody_subject_anonymizer USING (true) WITH CHECK (true);

GRANT SELECT ON published_bundle_artifacts TO kody_subject_reader;
CREATE POLICY published_bundle_artifacts_subject_read ON published_bundle_artifacts FOR SELECT TO kody_subject_reader USING ((published_bundle_artifacts.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON published_bundle_artifacts TO kody_subject_purger;
CREATE POLICY published_bundle_artifacts_subject_purge ON published_bundle_artifacts TO kody_subject_purger USING ((published_bundle_artifacts.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON referrals TO kody_subject_reader;
CREATE POLICY referrals_subject_read ON referrals FOR SELECT TO kody_subject_reader USING ((referrals.referrer_stable_user_id = current_setting('app.user_id', true) OR referrals.referee_stable_user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON referrals TO kody_subject_purger;
CREATE POLICY referrals_subject_purge ON referrals TO kody_subject_purger USING ((referrals.referrer_stable_user_id = current_setting('app.user_id', true) OR referrals.referee_stable_user_id = current_setting('app.user_id', true)));

GRANT SELECT, DELETE ON repo_session_due_owners TO kody_subject_purger;
CREATE POLICY repo_session_due_owners_subject_purge ON repo_session_due_owners TO kody_subject_purger USING ((repo_session_due_owners.user_id = current_setting('app.user_id', true)));

GRANT SELECT, DELETE ON saved_package_search_index_debt TO kody_subject_purger;
CREATE POLICY saved_package_search_index_debt_subject_purge ON saved_package_search_index_debt TO kody_subject_purger USING ((saved_package_search_index_debt.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON saved_packages TO kody_subject_reader;
CREATE POLICY saved_packages_subject_read ON saved_packages FOR SELECT TO kody_subject_reader USING ((saved_packages.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON saved_packages TO kody_subject_purger;
CREATE POLICY saved_packages_subject_purge ON saved_packages TO kody_subject_purger USING ((saved_packages.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON secret_buckets TO kody_subject_reader;
CREATE POLICY secret_buckets_subject_read ON secret_buckets FOR SELECT TO kody_subject_reader USING ((secret_buckets.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON secret_buckets TO kody_subject_purger;
CREATE POLICY secret_buckets_subject_purge ON secret_buckets TO kody_subject_purger USING ((secret_buckets.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON secret_entries TO kody_subject_reader;
CREATE POLICY secret_entries_subject_read ON secret_entries FOR SELECT TO kody_subject_reader USING ((secret_entries.bucket_id IN ( SELECT id FROM secret_buckets WHERE user_id = current_setting('app.user_id', true) )));
GRANT SELECT, DELETE ON secret_entries TO kody_subject_purger;
CREATE POLICY secret_entries_subject_purge ON secret_entries TO kody_subject_purger USING ((secret_entries.bucket_id IN ( SELECT id FROM secret_buckets WHERE user_id = current_setting('app.user_id', true) )));

GRANT SELECT ON secret_provider_bindings TO kody_subject_reader;
CREATE POLICY secret_provider_bindings_subject_read ON secret_provider_bindings FOR SELECT TO kody_subject_reader USING ((secret_provider_bindings.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON secret_provider_bindings TO kody_subject_purger;
CREATE POLICY secret_provider_bindings_subject_purge ON secret_provider_bindings TO kody_subject_purger USING ((secret_provider_bindings.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON secret_provider_grants TO kody_subject_reader;
CREATE POLICY secret_provider_grants_subject_read ON secret_provider_grants FOR SELECT TO kody_subject_reader USING ((secret_provider_grants.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON secret_provider_grants TO kody_subject_purger;
CREATE POLICY secret_provider_grants_subject_purge ON secret_provider_grants TO kody_subject_purger USING ((secret_provider_grants.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON site_banner_dismissals TO kody_subject_reader;
CREATE POLICY site_banner_dismissals_subject_read ON site_banner_dismissals FOR SELECT TO kody_subject_reader USING ((site_banner_dismissals.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON site_banner_dismissals TO kody_subject_purger;
CREATE POLICY site_banner_dismissals_subject_purge ON site_banner_dismissals TO kody_subject_purger USING ((site_banner_dismissals.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT, DELETE ON transactional_email_delivery_index TO kody_subject_purger;
CREATE POLICY transactional_email_delivery_index_subject_purge ON transactional_email_delivery_index TO kody_subject_purger USING ((transactional_email_delivery_index.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON usage_rollups TO kody_subject_reader;
CREATE POLICY usage_rollups_subject_read ON usage_rollups FOR SELECT TO kody_subject_reader USING ((usage_rollups.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON usage_rollups TO kody_subject_purger;
CREATE POLICY usage_rollups_subject_purge ON usage_rollups TO kody_subject_purger USING ((usage_rollups.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_email_claims TO kody_subject_reader;
CREATE POLICY user_email_claims_subject_read ON user_email_claims FOR SELECT TO kody_subject_reader USING ((user_email_claims.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON user_email_claims TO kody_subject_purger;
CREATE POLICY user_email_claims_subject_purge ON user_email_claims TO kody_subject_purger USING ((user_email_claims.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON user_integrations TO kody_subject_reader;
CREATE POLICY user_integrations_subject_read ON user_integrations FOR SELECT TO kody_subject_reader USING ((user_integrations.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_integrations TO kody_subject_purger;
CREATE POLICY user_integrations_subject_purge ON user_integrations TO kody_subject_purger USING ((user_integrations.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_mcp_oauth_clients TO kody_subject_reader;
CREATE POLICY user_mcp_oauth_clients_subject_read ON user_mcp_oauth_clients FOR SELECT TO kody_subject_reader USING ((user_mcp_oauth_clients.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON user_mcp_oauth_clients TO kody_subject_purger;
CREATE POLICY user_mcp_oauth_clients_subject_purge ON user_mcp_oauth_clients TO kody_subject_purger USING ((user_mcp_oauth_clients.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON user_oauth_apps TO kody_subject_reader;
CREATE POLICY user_oauth_apps_subject_read ON user_oauth_apps FOR SELECT TO kody_subject_reader USING ((user_oauth_apps.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_oauth_apps TO kody_subject_purger;
CREATE POLICY user_oauth_apps_subject_purge ON user_oauth_apps TO kody_subject_purger USING ((user_oauth_apps.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_repos TO kody_subject_reader;
CREATE POLICY user_repos_subject_read ON user_repos FOR SELECT TO kody_subject_reader USING ((user_repos.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_repos TO kody_subject_purger;
CREATE POLICY user_repos_subject_purge ON user_repos TO kody_subject_purger USING ((user_repos.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_roles TO kody_subject_reader;
CREATE POLICY user_roles_subject_read ON user_roles FOR SELECT TO kody_subject_reader USING ((user_roles.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));
GRANT SELECT, DELETE ON user_roles TO kody_subject_purger;
CREATE POLICY user_roles_subject_purge ON user_roles TO kody_subject_purger USING ((user_roles.user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))));

GRANT SELECT ON user_storage_buckets TO kody_subject_reader;
CREATE POLICY user_storage_buckets_subject_read ON user_storage_buckets FOR SELECT TO kody_subject_reader USING ((user_storage_buckets.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_storage_buckets TO kody_subject_purger;
CREATE POLICY user_storage_buckets_subject_purge ON user_storage_buckets TO kody_subject_purger USING ((user_storage_buckets.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_tips_email_opt_outs TO kody_subject_reader;
CREATE POLICY user_tips_email_opt_outs_subject_read ON user_tips_email_opt_outs FOR SELECT TO kody_subject_reader USING ((user_tips_email_opt_outs.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_tips_email_opt_outs TO kody_subject_purger;
CREATE POLICY user_tips_email_opt_outs_subject_purge ON user_tips_email_opt_outs TO kody_subject_purger USING ((user_tips_email_opt_outs.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_usage_campaign_sends TO kody_subject_reader;
CREATE POLICY user_usage_campaign_sends_subject_read ON user_usage_campaign_sends FOR SELECT TO kody_subject_reader USING ((user_usage_campaign_sends.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_usage_campaign_sends TO kody_subject_purger;
CREATE POLICY user_usage_campaign_sends_subject_purge ON user_usage_campaign_sends TO kody_subject_purger USING ((user_usage_campaign_sends.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON user_usage_campaigns TO kody_subject_reader;
CREATE POLICY user_usage_campaigns_subject_read ON user_usage_campaigns FOR SELECT TO kody_subject_reader USING ((user_usage_campaigns.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON user_usage_campaigns TO kody_subject_purger;
CREATE POLICY user_usage_campaigns_subject_purge ON user_usage_campaigns TO kody_subject_purger USING ((user_usage_campaigns.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON username_redirects TO kody_subject_reader;
CREATE POLICY username_redirects_subject_read ON username_redirects FOR SELECT TO kody_subject_reader USING ((username_redirects.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON username_redirects TO kody_subject_purger;
CREATE POLICY username_redirects_subject_purge ON username_redirects TO kody_subject_purger USING ((username_redirects.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON value_buckets TO kody_subject_reader;
CREATE POLICY value_buckets_subject_read ON value_buckets FOR SELECT TO kody_subject_reader USING ((value_buckets.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON value_buckets TO kody_subject_purger;
CREATE POLICY value_buckets_subject_purge ON value_buckets TO kody_subject_purger USING ((value_buckets.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON value_entries TO kody_subject_reader;
CREATE POLICY value_entries_subject_read ON value_entries FOR SELECT TO kody_subject_reader USING ((value_entries.bucket_id IN ( SELECT id FROM value_buckets WHERE user_id = current_setting('app.user_id', true) )));
GRANT SELECT, DELETE ON value_entries TO kody_subject_purger;
CREATE POLICY value_entries_subject_purge ON value_entries TO kody_subject_purger USING ((value_entries.bucket_id IN ( SELECT id FROM value_buckets WHERE user_id = current_setting('app.user_id', true) )));

GRANT SELECT, DELETE ON vector_embed_fingerprints TO kody_subject_purger;
CREATE POLICY vector_embed_fingerprints_subject_purge ON vector_embed_fingerprints TO kody_subject_purger USING ((vector_embed_fingerprints.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON verifications TO kody_subject_reader;
CREATE POLICY verifications_subject_read ON verifications FOR SELECT TO kody_subject_reader USING ((verifications.target = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))::text));
GRANT SELECT, DELETE ON verifications TO kody_subject_purger;
CREATE POLICY verifications_subject_purge ON verifications TO kody_subject_purger USING ((verifications.target = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))::text));

GRANT SELECT ON webhook_apply_destination_grants TO kody_subject_reader;
CREATE POLICY webhook_apply_destination_grants_subject_read ON webhook_apply_destination_grants FOR SELECT TO kody_subject_reader USING ((webhook_apply_destination_grants.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON webhook_apply_destination_grants TO kody_subject_purger;
CREATE POLICY webhook_apply_destination_grants_subject_purge ON webhook_apply_destination_grants TO kody_subject_purger USING ((webhook_apply_destination_grants.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON webhook_apply_destination_pending TO kody_subject_reader;
CREATE POLICY webhook_apply_destination_pending_subject_read ON webhook_apply_destination_pending FOR SELECT TO kody_subject_reader USING ((webhook_apply_destination_pending.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON webhook_apply_destination_pending TO kody_subject_purger;
CREATE POLICY webhook_apply_destination_pending_subject_purge ON webhook_apply_destination_pending TO kody_subject_purger USING ((webhook_apply_destination_pending.user_id = current_setting('app.user_id', true)));

GRANT SELECT ON webhook_endpoints TO kody_subject_reader;
CREATE POLICY webhook_endpoints_subject_read ON webhook_endpoints FOR SELECT TO kody_subject_reader USING ((webhook_endpoints.user_id = current_setting('app.user_id', true)));
GRANT SELECT, DELETE ON webhook_endpoints TO kody_subject_purger;
CREATE POLICY webhook_endpoints_subject_purge ON webhook_endpoints TO kody_subject_purger USING ((webhook_endpoints.user_id = current_setting('app.user_id', true)));

-- PostgreSQL makes an UPDATE's new row pass SELECT policies, so RLS cannot let the purger
-- rewrite the column that makes a row visible. This definer function applies only the
-- inventory's fixed anonymizations, only for the caller's own transaction subject.
CREATE FUNCTION kody_subject_anonymize() RETURNS TABLE (target_ordinal integer, changed_rows bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  subject text := current_setting('app.user_id', true);
BEGIN
  IF coalesce(subject, '') = '' THEN RAISE EXCEPTION 'app.user_id is required'; END IF;
  UPDATE credit_ledger_entries SET granted_by_user_id = 'deleted-user' WHERE granted_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 8; RETURN NEXT;
  UPDATE package_codemod_runs SET scope_user_id = 'deleted-user' WHERE scope_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 15; RETURN NEXT;
  UPDATE package_codemod_runs SET initiated_by_user_id = 'deleted-user' WHERE initiated_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 16; RETURN NEXT;
  UPDATE package_codemod_runs SET filters_json = REPLACE(filters_json, '"' || subject || '"', '"deleted-user"') WHERE length(replace(filters_json, '"' || subject || '"', '')) < length(filters_json);
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 17; RETURN NEXT;
  UPDATE account_write_lease_repairs SET target_user_id = 'deleted-user' WHERE target_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 22; RETURN NEXT;
  UPDATE account_write_lease_repairs SET repaired_by_user_id = 'deleted-user' WHERE repaired_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 23; RETURN NEXT;
  UPDATE platform_feedback SET reviewed_by_user_id = NULL, reviewed_at = NULL, admin_note = NULL WHERE reviewed_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 54; RETURN NEXT;
  UPDATE community_reports SET resolved_by_user_id = NULL, resolved_at = NULL, resolution_note = NULL WHERE resolved_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 64; RETURN NEXT;
  UPDATE package_scope_grants SET created_by_user_id = 'deleted-user' WHERE created_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 66; RETURN NEXT;
  UPDATE community_bans SET banned_by_user_id = 'deleted-user' WHERE banned_by_user_id = subject;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  target_ordinal := 68; RETURN NEXT;
END
$fn$;
ALTER FUNCTION kody_subject_anonymize() OWNER TO kody_subject_anonymizer;
REVOKE ALL ON FUNCTION kody_subject_anonymize() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_subject_anonymize() TO kody_subject_purger;

-- Job rows sit outside the deletion inventory (the jobs service purges them), but they
-- are the subject's data, so export reads them through the same subject reader.
GRANT SELECT ON jobs, archived_job_artifacts TO kody_subject_reader;
CREATE POLICY jobs_subject_read ON jobs FOR SELECT TO kody_subject_reader USING (user_id = current_setting('app.user_id', true));
CREATE POLICY archived_job_artifacts_subject_read ON archived_job_artifacts FOR SELECT TO kody_subject_reader USING (user_id = current_setting('app.user_id', true));

-- The unverified-account purge lists and claims candidates through kody_admin; its
-- eligibility skips accounts with a linked provider, which needs only the owner id.
GRANT SELECT (user_id) ON oauth_connections TO kody_admin;
CREATE POLICY oauth_connections_admin ON oauth_connections FOR SELECT TO kody_admin USING (true);
