-- Public community metadata is the fourth documented cross-user exception. Anonymous page
-- loads and cross-user browse, fork, rate and report preflights read it through the
-- read-only kody_community role. Rows are limited to active listings and public packages;
-- column grants keep email, credentials, rating notes and report content out of reach.
CREATE ROLE kody_community NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_community;

GRANT SELECT ON community_listings TO kody_community;
CREATE POLICY community_listings_public ON community_listings FOR SELECT TO kody_community
  USING (status = 'active');
GRANT SELECT ON saved_packages TO kody_community;
CREATE POLICY saved_packages_public ON saved_packages FOR SELECT TO kody_community
  USING (is_private = 0);
-- Sources of public packages and listings (fork origin, icon commit, ahead-of-listing).
GRANT SELECT ON entity_sources TO kody_community;
CREATE POLICY entity_sources_public ON entity_sources FOR SELECT TO kody_community USING (
  EXISTS (SELECT 1 FROM community_listings l WHERE l.source_id = entity_sources.id AND l.owner_user_id = entity_sources.user_id)
  OR EXISTS (SELECT 1 FROM saved_packages p WHERE p.source_id = entity_sources.id AND p.user_id = entity_sources.user_id));
GRANT SELECT (id, username, stable_user_id, display_name, bio, avatar_key, profile_visibility, created_at)
  ON users TO kody_community;
CREATE POLICY users_public ON users FOR SELECT TO kody_community USING (true);
GRANT SELECT (id, listing_id, user_id, stars, adaptation_effort, created_at, updated_at)
  ON community_ratings TO kody_community;
CREATE POLICY community_ratings_public ON community_ratings FOR SELECT TO kody_community
  USING (listing_id IN (SELECT id FROM community_listings));
GRANT SELECT (id, listing_id, forker_user_id, forked_package_id, created_at)
  ON community_forks TO kody_community;
CREATE POLICY community_forks_public ON community_forks FOR SELECT TO kody_community
  USING (listing_id IN (SELECT id FROM community_listings));
GRANT SELECT (actor_user_id, event_type, listing_id, created_at)
  ON community_activity_events TO kody_community;
CREATE POLICY community_activity_events_public ON community_activity_events FOR SELECT TO kody_community
  USING (listing_id IN (SELECT id FROM community_listings));
-- Ban status gates every participation write, including a delegated actor's.
GRANT SELECT ON community_bans TO kody_community;
CREATE POLICY community_bans_public ON community_bans FOR SELECT TO kody_community USING (true);
GRANT SELECT ON username_redirects TO kody_community;
CREATE POLICY username_redirects_public ON username_redirects FOR SELECT TO kody_community USING (true);
GRANT SELECT ON package_kody_id_redirects TO kody_community;
CREATE POLICY package_kody_id_redirects_public ON package_kody_id_redirects FOR SELECT TO kody_community
  USING (EXISTS (SELECT 1 FROM saved_packages p WHERE p.id = package_kody_id_redirects.package_id AND p.user_id = package_kody_id_redirects.user_id));
-- Public profile signifier counts.
GRANT SELECT (user_id, package_id) ON webhook_endpoints TO kody_community;
CREATE POLICY webhook_endpoints_public ON webhook_endpoints FOR SELECT TO kody_community
  USING (EXISTS (SELECT 1 FROM saved_packages p WHERE p.id = webhook_endpoints.package_id AND p.user_id = webhook_endpoints.user_id));
GRANT SELECT (user_id, source_id) ON jobs TO kody_community;
CREATE POLICY jobs_public ON jobs FOR SELECT TO kody_community
  USING (EXISTS (SELECT 1 FROM saved_packages p WHERE p.source_id = jobs.source_id AND p.user_id = jobs.user_id));

-- Owner actions that touch other users' rows run in definers owned by kody_community_curator,
-- each bound to the caller's own listing or username. RLS (and PostgreSQL's SELECT check on
-- UPDATE/DELETE predicates) would otherwise hide those rows or expose private columns such
-- as rating notes to the listing owner.
CREATE ROLE kody_community_curator NOLOGIN;
GRANT USAGE ON SCHEMA public TO kody_community_curator;
GRANT SELECT (id, owner_user_id) ON community_listings TO kody_community_curator;
CREATE POLICY community_listings_curator ON community_listings FOR SELECT TO kody_community_curator USING (true);
GRANT SELECT (listing_id, listing_name, listing_kody_id), UPDATE (listing_id) ON community_forks TO kody_community_curator;
CREATE POLICY community_forks_curator ON community_forks TO kody_community_curator USING (true) WITH CHECK (true);
GRANT SELECT (listing_id), DELETE ON community_ratings, community_activity_events TO kody_community_curator;
CREATE POLICY community_ratings_curator ON community_ratings TO kody_community_curator USING (true);
CREATE POLICY community_activity_events_curator ON community_activity_events TO kody_community_curator USING (true);
GRANT SELECT (old_username), DELETE ON username_redirects TO kody_community_curator;
CREATE POLICY username_redirects_curator ON username_redirects TO kody_community_curator USING (true);
GRANT SELECT (stable_user_id, username) ON users TO kody_community_curator;
CREATE POLICY users_curator ON users FOR SELECT TO kody_community_curator USING (true);

CREATE FUNCTION kody_community_assert_owned(target text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF coalesce(current_setting('app.user_id', true), '') = '' OR NOT EXISTS (
    SELECT 1 FROM community_listings WHERE id = target AND owner_user_id = current_setting('app.user_id', true)
  ) THEN
    RAISE EXCEPTION 'listing % is not owned by app.user_id', target;
  END IF;
END
$fn$;

-- Unpublish removes every rating and activity row on the caller's listing, before the listing.
CREATE FUNCTION kody_community_clear_listing_engagement(target text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  ratings bigint;
  events bigint;
BEGIN
  PERFORM kody_community_assert_owned(target);
  DELETE FROM community_ratings WHERE listing_id = target;
  GET DIAGNOSTICS ratings = ROW_COUNT;
  DELETE FROM community_activity_events WHERE listing_id = target;
  GET DIAGNOSTICS events = ROW_COUNT;
  RETURN ratings + events;
END
$fn$;

-- Claiming a username clears any retirement row for it, including another user's stale one.
CREATE FUNCTION kody_community_release_claimed_username() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  released bigint;
BEGIN
  DELETE FROM username_redirects WHERE old_username = (
    SELECT username FROM users WHERE stable_user_id = current_setting('app.user_id', true)
  );
  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released;
END
$fn$;

-- Republishing re-points forks orphaned by an earlier unpublish of the same scoped name;
-- orphan status must see every listing.
CREATE FUNCTION kody_community_repoint_orphan_forks(target text, fork_listing_name text, fork_listing_kody_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  moved bigint;
BEGIN
  PERFORM kody_community_assert_owned(target);
  UPDATE community_forks SET listing_id = target
  WHERE listing_id <> target AND listing_name = fork_listing_name AND listing_kody_id = fork_listing_kody_id
    AND NOT EXISTS (SELECT 1 FROM community_listings WHERE community_listings.id = community_forks.listing_id);
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END
$fn$;
ALTER FUNCTION kody_community_assert_owned(text) OWNER TO kody_community_curator;
ALTER FUNCTION kody_community_clear_listing_engagement(text) OWNER TO kody_community_curator;
ALTER FUNCTION kody_community_release_claimed_username() OWNER TO kody_community_curator;
ALTER FUNCTION kody_community_repoint_orphan_forks(text, text, text) OWNER TO kody_community_curator;
REVOKE ALL ON FUNCTION kody_community_assert_owned(text), kody_community_clear_listing_engagement(text),
  kody_community_release_claimed_username(), kody_community_repoint_orphan_forks(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kody_community_clear_listing_engagement(text),
  kody_community_release_claimed_username(), kody_community_repoint_orphan_forks(text, text, text) TO kody_writer;

-- Moderation (featuring, report resolution, bans, delist/delete, orphan cleanup, activity
-- review) runs as kody_admin after the application permission check. Rating notes stay
-- denied; the unused sanitized views are replaced by these column grants.
DROP VIEW public_community_ratings, public_community_forks;
GRANT SELECT, DELETE, UPDATE (status, featured_at, updated_at) ON community_listings TO kody_admin;
CREATE POLICY community_listings_admin ON community_listings TO kody_admin USING (true) WITH CHECK (true);
GRANT SELECT (id, user_id, entity_kind, entity_id, published_commit) ON entity_sources TO kody_admin;
CREATE POLICY entity_sources_admin ON entity_sources FOR SELECT TO kody_admin USING (true);
GRANT SELECT (id) ON saved_packages TO kody_admin;
CREATE POLICY saved_packages_admin ON saved_packages FOR SELECT TO kody_admin USING (true);
GRANT SELECT (id, listing_id, listing_name, listing_kody_id, forker_user_id, forked_package_id,
  forked_source_id, target_kody_id, created_at), DELETE ON community_forks TO kody_admin;
CREATE POLICY community_forks_admin ON community_forks TO kody_admin USING (true);
GRANT SELECT (id, listing_id, user_id, stars, adaptation_effort, created_at, updated_at), DELETE
  ON community_ratings TO kody_admin;
CREATE POLICY community_ratings_admin ON community_ratings TO kody_admin USING (true);
GRANT SELECT (listing_id), DELETE ON community_activity_events TO kody_admin;
CREATE POLICY community_activity_events_admin ON community_activity_events TO kody_admin USING (true);
GRANT SELECT, UPDATE (status, resolved_by_user_id, resolved_at, resolution_note, updated_at)
  ON community_reports TO kody_admin;
CREATE POLICY community_reports_admin ON community_reports TO kody_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON community_bans TO kody_admin;
CREATE POLICY community_bans_admin ON community_bans TO kody_admin USING (true) WITH CHECK (true);
