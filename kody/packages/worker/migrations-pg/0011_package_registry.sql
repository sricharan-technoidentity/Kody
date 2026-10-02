-- Package share grants are consent-scoped cross-user access, so the grant rows themselves
-- must be unforgeable: only an owner creates or deletes a grant (for their own id), a
-- guest updates only the grant addressed to them while it is pending or accepted, and no
-- writer can move a grant's package or owner. Visibility: grants the caller owns, grants
-- naming them as grantee, and unbound pending invites addressed to their verified email.
DROP POLICY package_share_grants_owner ON package_share_grants;
REVOKE UPDATE ON package_share_grants FROM kody_writer;
GRANT UPDATE (status, grantee_user_id, invitee_username, trust_level, accepted_published_commit,
  accepted_at, revoked_at, left_at, last_acknowledged_at, updated_at) ON package_share_grants TO kody_writer;
CREATE POLICY package_share_grants_owner ON package_share_grants TO kody_writer, kody_reader
  USING (owner_user_id = current_setting('app.user_id', true))
  WITH CHECK (owner_user_id = current_setting('app.user_id', true));
CREATE POLICY package_share_grants_grantee_read ON package_share_grants FOR SELECT TO kody_writer, kody_reader
  USING (grantee_user_id = current_setting('app.user_id', true));
CREATE POLICY package_share_grants_grantee_update ON package_share_grants FOR UPDATE TO kody_writer
  USING (grantee_user_id = current_setting('app.user_id', true) AND status IN ('pending', 'accepted'))
  WITH CHECK (grantee_user_id = current_setting('app.user_id', true) AND status IN ('pending', 'accepted', 'left'));
CREATE POLICY package_share_grants_email_invitee_read ON package_share_grants FOR SELECT TO kody_writer, kody_reader
  USING (
    status = 'pending' AND grantee_user_id IS NULL AND invitee_email = (
      SELECT email FROM users
      WHERE stable_user_id = current_setting('app.user_id', true) AND email_verified_at IS NOT NULL
    ));
CREATE POLICY package_share_grants_email_invitee_update ON package_share_grants FOR UPDATE TO kody_writer
  USING (
    status = 'pending' AND grantee_user_id IS NULL AND invitee_email = (
      SELECT email FROM users
      WHERE stable_user_id = current_setting('app.user_id', true) AND email_verified_at IS NOT NULL
    ))
  WITH CHECK (grantee_user_id = current_setting('app.user_id', true) AND status IN ('pending', 'accepted'));

-- A pending or accepted grant shows the guest the owner's package and its source.
CREATE POLICY saved_packages_share_guest ON saved_packages FOR SELECT TO kody_writer, kody_reader
  USING (EXISTS (
    SELECT 1 FROM package_share_grants g
    WHERE g.package_id = saved_packages.id AND g.owner_user_id = saved_packages.user_id
      AND g.status IN ('pending', 'accepted')));
CREATE POLICY entity_sources_share_guest ON entity_sources FOR SELECT TO kody_writer, kody_reader
  USING (EXISTS (
    SELECT 1 FROM saved_packages p
    WHERE p.source_id = entity_sources.id AND p.user_id = entity_sources.user_id));

-- Account rows hold credentials, so other accounts are read through definers owned by
-- NOLOGIN kody_account_directory: a share grant's other party, an exact-match invitee, and
-- platform accounts (public package scopes such as @kody).
CREATE ROLE kody_account_directory NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_account_directory;
GRANT SELECT (id, username, email, stable_user_id, account_type, email_verified_at, plan, stripe_plan,
  entitlement_ladder, stripe_credits_eligible, admin_credits_eligible,
  second_agent_standard_gift_expires_at, referral_standard_credit_expires_at)
  ON users TO kody_account_directory;
CREATE POLICY users_share_directory ON users FOR SELECT TO kody_account_directory USING (true);
GRANT SELECT (owner_user_id, grantee_user_id, invitee_email, status) ON package_share_grants TO kody_account_directory;
CREATE POLICY package_share_grants_share_directory ON package_share_grants FOR SELECT TO kody_account_directory USING (true);

-- Invitee lookup by exact username, or by exact email for person accounts. The email is
-- returned for conflict checks and invite delivery; callers never persist it for
-- username invites.
CREATE FUNCTION kody_share_find_invitee(lookup_username text, lookup_email text)
RETURNS TABLE (id bigint, username text, email text, stable_user_id text, email_verified boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.id, u.username, u.email, u.stable_user_id, u.email_verified_at IS NOT NULL
  FROM users u
  WHERE coalesce(current_setting('app.user_id', true), '') <> ''
    AND ((lookup_username IS NOT NULL AND u.username = lookup_username)
      OR (lookup_username IS NULL AND lookup_email IS NOT NULL AND u.email = lookup_email
        AND u.account_type = 'person'))
  LIMIT 1
$fn$;

-- The other party of a grant the caller can see (or the caller itself): identity and
-- entitlement columns for plan checks. Email only reaches an owner about their grantee.
CREATE FUNCTION kody_share_peer(peer text)
RETURNS TABLE (id bigint, username text, email text, stable_user_id text, plan text, stripe_plan text,
  entitlement_ladder text, stripe_credits_eligible bigint, admin_credits_eligible bigint,
  second_agent_standard_gift_expires_at text, referral_standard_credit_expires_at text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH caller AS (
    SELECT current_setting('app.user_id', true) AS id,
      (SELECT email FROM users WHERE stable_user_id = current_setting('app.user_id', true)
        AND email_verified_at IS NOT NULL) AS verified_email
  ),
  link AS (
    SELECT bool_or(g.owner_user_id = caller.id AND g.grantee_user_id = peer) AS owner_of_peer,
      bool_or((g.grantee_user_id = caller.id AND g.owner_user_id = peer)
        OR (g.owner_user_id = peer AND g.status = 'pending' AND g.grantee_user_id IS NULL
          AND g.invitee_email = caller.verified_email)) AS guest_of_peer
    FROM package_share_grants g, caller
    WHERE g.owner_user_id IN (caller.id, peer)
  )
  SELECT u.id, u.username,
    CASE WHEN u.stable_user_id = caller.id OR link.owner_of_peer THEN u.email END,
    u.stable_user_id, u.plan, u.stripe_plan, u.entitlement_ladder, u.stripe_credits_eligible,
    u.admin_credits_eligible, u.second_agent_standard_gift_expires_at,
    u.referral_standard_credit_expires_at
  FROM users u, caller, link
  WHERE u.stable_user_id = peer AND coalesce(caller.id, '') <> ''
    AND (u.stable_user_id = caller.id OR link.owner_of_peer OR link.guest_of_peer)
$fn$;
ALTER FUNCTION kody_share_find_invitee(text, text) OWNER TO kody_account_directory;
ALTER FUNCTION kody_share_peer(text) OWNER TO kody_account_directory;
REVOKE ALL ON FUNCTION kody_share_find_invitee(text, text), kody_share_peer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_share_find_invitee(text, text), kody_share_peer(text) TO kody_writer, kody_reader;

-- Platform accounts own public package scopes; any account may resolve them.
CREATE FUNCTION kody_platform_account(lookup_username text, lookup_stable_user_id text)
RETURNS TABLE (id bigint, username text, email text, stable_user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.id, u.username, u.email, u.stable_user_id
  FROM users u
  WHERE u.account_type = 'platform'
    AND (u.username = lookup_username OR u.stable_user_id = lookup_stable_user_id)
  LIMIT 1
$fn$;
CREATE FUNCTION kody_platform_account_usernames()
RETURNS TABLE (username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.username FROM users u WHERE u.account_type = 'platform' ORDER BY u.username
$fn$;
ALTER FUNCTION kody_platform_account(text, text) OWNER TO kody_account_directory;
ALTER FUNCTION kody_platform_account_usernames() OWNER TO kody_account_directory;
REVOKE ALL ON FUNCTION kody_platform_account(text, text), kody_platform_account_usernames() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_platform_account(text, text), kody_platform_account_usernames()
  TO kody_writer, kody_reader, kody_admin;

-- Package scope grants let a person act inside a platform scope, so only operators
-- (kody_admin, after the permission check) create or remove them; the parties may read.
DROP POLICY package_scope_grants_owner ON package_scope_grants;
REVOKE INSERT, UPDATE, DELETE ON package_scope_grants FROM kody_writer;
CREATE POLICY package_scope_grants_parties ON package_scope_grants FOR SELECT TO kody_writer, kody_reader
  USING (scope_owner_user_id = current_setting('app.user_id', true)
    OR grantee_user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT, DELETE ON package_scope_grants TO kody_admin;
CREATE POLICY package_scope_grants_admin ON package_scope_grants TO kody_admin USING (true) WITH CHECK (true);
