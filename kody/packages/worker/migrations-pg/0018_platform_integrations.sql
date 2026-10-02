-- Platform OAuth apps are operator configuration: every signed-in connect flow reads
-- them (the client secret stays KMS-envelope ciphertext bound to the app slug), only
-- kody_admin writes them and the shared provider marks. Renaming an app re-points
-- existing connections, so the operator may read and update only
-- user_integrations.platform_app_slug, never tokens or account labels.
GRANT SELECT ON platform_oauth_apps TO kody_reader, kody_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_oauth_apps, platform_provider_marks
  TO kody_admin;
GRANT SELECT (platform_app_slug), UPDATE (platform_app_slug) ON user_integrations
  TO kody_admin;
CREATE POLICY user_integrations_admin_platform_app ON user_integrations TO kody_admin
  USING (platform_app_slug IS NOT NULL) WITH CHECK (platform_app_slug IS NOT NULL);
