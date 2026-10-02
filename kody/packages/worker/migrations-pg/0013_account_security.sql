-- More signed-out entry points, same rule as 0012: an email-change or former-email release
-- link carries only a token, and passkey sign-in carries only a credential id. Definers
-- owned by kody_token_resolver return the owner's stable id and nothing else; the flow
-- then runs on that owner's scoped writer. A credential id alone signs nobody in: the
-- assertion is still verified against the owner's stored public key.
GRANT SELECT (user_id, token_hash) ON pending_email_changes, pending_email_claim_releases TO kody_token_resolver;
CREATE POLICY pending_email_changes_token_resolver ON pending_email_changes FOR SELECT TO kody_token_resolver USING (true);
CREATE POLICY pending_email_claim_releases_token_resolver ON pending_email_claim_releases FOR SELECT TO kody_token_resolver USING (true);
GRANT SELECT (id, user_id) ON passkeys TO kody_token_resolver;
CREATE POLICY passkeys_token_resolver ON passkeys FOR SELECT TO kody_token_resolver USING (true);

CREATE FUNCTION kody_email_change_owner(lookup_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.stable_user_id FROM pending_email_changes t JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = lookup_token_hash
$fn$;
CREATE FUNCTION kody_email_claim_release_owner(lookup_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.stable_user_id FROM pending_email_claim_releases t JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = lookup_token_hash
$fn$;
CREATE FUNCTION kody_passkey_owner(lookup_credential_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.stable_user_id FROM passkeys p JOIN users u ON u.id = p.user_id
  WHERE p.id = lookup_credential_id
$fn$;
ALTER FUNCTION kody_email_change_owner(text) OWNER TO kody_token_resolver;
ALTER FUNCTION kody_email_claim_release_owner(text) OWNER TO kody_token_resolver;
ALTER FUNCTION kody_passkey_owner(text) OWNER TO kody_token_resolver;
REVOKE ALL ON FUNCTION kody_email_change_owner(text), kody_email_claim_release_owner(text),
  kody_passkey_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_email_change_owner(text), kody_email_claim_release_owner(text),
  kody_passkey_owner(text) TO kody_writer;

-- Whether an address is held by another account: its login email, an active former-email
-- claim, or the implicit sha256(email) stable id of an account that never released it.
-- Same logic as isEmailReservedForOtherAccount; it answers only true/false.
GRANT SELECT (user_id, email, status) ON user_email_claims TO kody_account_directory;
CREATE POLICY user_email_claims_account_directory ON user_email_claims FOR SELECT TO kody_account_directory USING (true);

CREATE FUNCTION kody_email_reserved_for_other(lookup_email text, except_user_id bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN lookup_email = '' THEN false
    WHEN EXISTS (SELECT 1 FROM users u WHERE u.email = lookup_email
      AND u.id IS DISTINCT FROM except_user_id) THEN true
    WHEN EXISTS (SELECT 1 FROM user_email_claims c WHERE c.email = lookup_email
      AND c.status = 'claimed' AND c.user_id IS DISTINCT FROM except_user_id) THEN true
    WHEN NOT EXISTS (SELECT 1 FROM user_email_claims c WHERE c.email = lookup_email AND c.status = 'claimed')
      AND EXISTS (SELECT 1 FROM user_email_claims c WHERE c.email = lookup_email AND c.status = 'released')
      THEN false
    ELSE EXISTS (SELECT 1 FROM users u
      WHERE u.stable_user_id = encode(sha256(convert_to(lookup_email, 'UTF8')), 'hex')
        AND u.id IS DISTINCT FROM except_user_id
        AND lower(btrim(u.email)) <> lookup_email)
  END
$fn$;
ALTER FUNCTION kody_email_reserved_for_other(text, bigint) OWNER TO kody_account_directory;
REVOKE ALL ON FUNCTION kody_email_reserved_for_other(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_email_reserved_for_other(text, bigint) TO kody_writer, kody_admin;
