-- Login, password-reset request and provider sign-in know only an email before a session
-- exists, and owner RLS hides every account from the pre-auth writer. Same rule as 0012:
-- the definer returns the owner's stable id and nothing else; the flow then continues on
-- that owner's scoped writer, where the password or provider identity is still verified.
GRANT SELECT (email) ON users TO kody_token_resolver;

CREATE FUNCTION kody_account_email_owner(lookup_email text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT stable_user_id FROM users WHERE email = lookup_email
$fn$;
ALTER FUNCTION kody_account_email_owner(text) OWNER TO kody_token_resolver;
REVOKE ALL ON FUNCTION kody_account_email_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_account_email_owner(text) TO kody_writer;

-- Self-service signup allocates a stable id before the account exists. Mirrors
-- allocateSignupIdentity and answers only the outcome: 'current_email',
-- 'former_email_claimed', 'preferred' (sha256(email) is free) or 'random' (the hashed id
-- belongs to an account that released this address). The caller mints the id and inserts
-- the row on that id's own writer; a random-id collision fails the insert's unique check.
CREATE FUNCTION kody_signup_identity(lookup_email text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH hashed AS (
    SELECT u.email FROM users u
    WHERE u.stable_user_id = encode(sha256(convert_to(lookup_email, 'UTF8')), 'hex')
  )
  SELECT CASE
    WHEN lookup_email = '' THEN 'current_email'
    WHEN EXISTS (SELECT 1 FROM users u WHERE u.email = lookup_email) THEN 'current_email'
    WHEN EXISTS (SELECT 1 FROM user_email_claims c WHERE c.email = lookup_email
      AND c.status = 'claimed') THEN 'former_email_claimed'
    WHEN NOT EXISTS (SELECT 1 FROM hashed) THEN 'preferred'
    WHEN EXISTS (SELECT 1 FROM hashed WHERE lower(btrim(email)) = lookup_email) THEN 'current_email'
    WHEN EXISTS (SELECT 1 FROM user_email_claims c WHERE c.email = lookup_email
      AND c.status = 'released') THEN 'random'
    ELSE 'former_email_claimed'
  END
$fn$;
ALTER FUNCTION kody_signup_identity(text) OWNER TO kody_account_directory;
REVOKE ALL ON FUNCTION kody_signup_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_signup_identity(text) TO kody_writer, kody_admin;

-- A returning provider sign-in carries only the provider identity.
GRANT SELECT (provider_name, provider_id, user_id) ON oauth_connections TO kody_token_resolver;
CREATE POLICY oauth_connections_token_resolver ON oauth_connections FOR SELECT TO kody_token_resolver USING (true);
CREATE FUNCTION kody_oauth_connection_owner(lookup_provider text, lookup_provider_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.stable_user_id FROM oauth_connections c JOIN users u ON u.id = c.user_id
  WHERE c.provider_name = lookup_provider AND c.provider_id = lookup_provider_id
$fn$;
ALTER FUNCTION kody_oauth_connection_owner(text, text) OWNER TO kody_token_resolver;
REVOKE ALL ON FUNCTION kody_oauth_connection_owner(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_oauth_connection_owner(text, text) TO kody_writer;

-- Usernames are public handles; signup and generated usernames need "is it taken" across
-- accounts. The caller learns only true/false.
CREATE FUNCTION kody_username_taken(lookup_username text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM users WHERE username = lookup_username)
$fn$;
ALTER FUNCTION kody_username_taken(text) OWNER TO kody_account_directory;
REVOKE ALL ON FUNCTION kody_username_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_username_taken(text) TO kody_writer, kody_admin;

-- A signup's referral code is the referrer's public username. The referee's writer may
-- record the referral row (it names the referee), but cannot see the referrer: this
-- returns a person account's stable id for the code, or null.
CREATE FUNCTION kody_referral_referrer(lookup_username text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT stable_user_id FROM users
  WHERE username = lookup_username AND account_type IS DISTINCT FROM 'platform'
$fn$;
ALTER FUNCTION kody_referral_referrer(text) OWNER TO kody_account_directory;
REVOKE ALL ON FUNCTION kody_referral_referrer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_referral_referrer(text) TO kody_writer;
