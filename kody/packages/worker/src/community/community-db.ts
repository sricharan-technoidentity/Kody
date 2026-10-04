import { type SqlDatabase } from '#worker/aws/pg-database.ts'

/**
 * Public community metadata (active listings, public packages and profiles,
 * rating and fork aggregates, ban status, URL redirects) spans users, so it is
 * read through the read-only `kody_community` role rather than the caller's
 * own scoped writer. Owner writes stay on `APP_DB`; moderation runs on the
 * admin environment's `APP_DB`.
 */
export function getCommunityDb(env: Pick<Env, 'APP_DB'>): SqlDatabase {
	// ponytail: legacy fixtures can omit COMMUNITY_DB; require the community reader after those fixtures are converted.
	return (env as { COMMUNITY_DB?: SqlDatabase }).COMMUNITY_DB ?? env.APP_DB
}
