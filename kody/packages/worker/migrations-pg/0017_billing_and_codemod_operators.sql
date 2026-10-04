-- P8 isolated billing/referral/fleet operator permissions.
-- Approved for the POC; ordinary writers/readers retain owner RLS.
-- Billing webhooks/debit sweeps/admin credit grants and fleet codemods use the
-- isolated operator connection. Ordinary writers retain owner RLS.
GRANT SELECT, INSERT, UPDATE ON credit_wallets, credit_ledger_entries,
  credit_debit_progress, referrals, package_codemod_runs, package_codemod_run_items
  TO kody_admin;
CREATE POLICY credit_wallets_operator ON credit_wallets TO kody_admin USING (true) WITH CHECK (true);
CREATE POLICY credit_ledger_entries_operator ON credit_ledger_entries TO kody_admin USING (true) WITH CHECK (true);
CREATE POLICY credit_debit_progress_operator ON credit_debit_progress TO kody_admin USING (true) WITH CHECK (true);
CREATE POLICY referrals_operator ON referrals TO kody_admin USING (true) WITH CHECK (true);
CREATE POLICY package_codemod_runs_operator ON package_codemod_runs TO kody_admin USING (true) WITH CHECK (true);
CREATE POLICY package_codemod_run_items_operator ON package_codemod_run_items TO kody_admin USING (true) WITH CHECK (true);
GRANT USAGE, SELECT ON SEQUENCE referrals_id_seq TO kody_admin;
GRANT SELECT, INSERT, UPDATE ON credit_debit_cursor, stripe_webhook_events TO kody_admin;
GRANT SELECT ON usage_rollups TO kody_admin;
CREATE POLICY usage_rollups_billing_operator ON usage_rollups FOR SELECT TO kody_admin USING (true);
GRANT EXECUTE ON FUNCTION kody_referral_referrer(text) TO kody_admin;
