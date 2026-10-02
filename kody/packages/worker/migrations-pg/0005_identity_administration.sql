-- Identity allocation needs current and former email reservations across accounts.
-- Account setup tokens remain accessible only through the new user's scoped writer.
GRANT SELECT ON user_email_claims TO kody_admin;
CREATE POLICY user_email_claims_admin_read ON user_email_claims
  FOR SELECT TO kody_admin USING (true);

-- A runtime writer may assign its own default role, never promote itself.
ALTER POLICY user_roles_owner ON user_roles WITH CHECK (
  user_id = (SELECT id FROM users WHERE stable_user_id = current_setting('app.user_id', true))
  AND role_id = (SELECT id FROM roles WHERE name = 'user')
);
REVOKE UPDATE, DELETE ON user_roles FROM kody_writer;
