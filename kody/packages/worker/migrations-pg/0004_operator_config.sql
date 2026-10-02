-- Banner editing is selected only after application operator authorization.
GRANT SELECT, INSERT, UPDATE, DELETE ON site_banners TO kody_admin;

-- Global flags and per-user assignment overrides are account administration.
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags, feature_flag_user_overrides TO kody_admin;
CREATE POLICY feature_flag_user_overrides_admin ON feature_flag_user_overrides TO kody_admin USING (true) WITH CHECK (true);
