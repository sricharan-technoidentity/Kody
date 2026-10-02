-- Operator analytics reads fleet-wide counters only after the application permission check.
-- Counters hold user ids and totals, never user content; the role is read-only and
-- separate from account administration. Extend the grant list as admin insights migrate.
CREATE ROLE kody_analytics NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_analytics;
GRANT SELECT ON feature_flag_exposure_rollups, usage_rollups TO kody_analytics;
CREATE POLICY feature_flag_exposure_rollups_analytics ON feature_flag_exposure_rollups
  FOR SELECT TO kody_analytics USING (true);
CREATE POLICY usage_rollups_analytics ON usage_rollups
  FOR SELECT TO kody_analytics USING (true);
