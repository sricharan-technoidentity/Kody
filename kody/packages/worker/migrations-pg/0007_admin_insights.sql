-- Admin insights read fleet-wide account counters through kody_analytics after the
-- application permission check. Column grants exclude email, credentials and profile content.
GRANT SELECT (
  id, stable_user_id, username, plan, stripe_plan, stripe_price_id, entitlement_ladder,
  stripe_credits_eligible, admin_credits_eligible, account_type, created_at, deleting_at,
  email_verified_at, first_mcp_connected_at, first_search_at, first_execute_at,
  first_saved_package_at, mcp_client_name, last_active_at,
  second_agent_standard_gift_expires_at, referral_standard_credit_expires_at
) ON users TO kody_analytics;
GRANT SELECT ON user_roles, roles TO kody_analytics;
GRANT SELECT (status) ON platform_feedback TO kody_analytics;
GRANT SELECT (user_id, balance_micro_usd) ON credit_wallets TO kody_analytics;
CREATE POLICY users_analytics ON users FOR SELECT TO kody_analytics USING (true);
CREATE POLICY user_roles_analytics ON user_roles FOR SELECT TO kody_analytics USING (true);
CREATE POLICY platform_feedback_analytics ON platform_feedback FOR SELECT TO kody_analytics USING (true);
CREATE POLICY credit_wallets_analytics ON credit_wallets FOR SELECT TO kody_analytics USING (true);
