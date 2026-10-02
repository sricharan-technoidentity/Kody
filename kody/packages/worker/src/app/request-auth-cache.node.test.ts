import { expect, test } from 'vitest'
import { createCookie } from 'remix/cookie'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { hasResolvedRequestFeatureFlags } from '#app/request-feature-flags-cache.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const sessionEmail = 'user@example.com'
const stableUserId = testStableUserIdFromEmail(sessionEmail)
const session: AuthSession = {
	stableUserId,
	email: sessionEmail,
	rememberMe: false,
}

async function resolveCookie(db: PgDatabase, cookie: string) {
	const request = new Request('https://example.com/account', {
		headers: { Cookie: cookie.split(';')[0]! },
	})
	const resolved = await loadResolvedRequestAuth(request, {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
	} as unknown as Env)
	expect(hasResolvedRequestFeatureFlags(request)).toBe(false)
	return resolved
}

function expectSignedOutWithClearedCookie(
	resolved: Awaited<ReturnType<typeof loadResolvedRequestAuth>>,
) {
	expect(resolved.user).toBeNull()
	expect(resolved.setCookie ?? '').toContain('kody_session=')
	expect(resolved.setCookie ?? '').toContain('Max-Age=0')
}

test('resolveRequestAuth rejects cookies past the absolute lifetime and legacy cookies without issuedAt', async () => {
	setAuthSessionSecret(testCookieSecret)
	await using store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id)
		 VALUES (7, $1, 'session-user', 'unused', $2)`,
		[sessionEmail, stableUserId],
	)
	const db = store.forUser(stableUserId).db
	const now = Date.now()
	const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000
	const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000

	expectSignedOutWithClearedCookie(
		await resolveCookie(
			db,
			await createAuthCookie(
				{ ...session, rememberMe: false },
				false,
				eightDaysAgo,
			),
		),
	)

	const rememberedEightDays = await resolveCookie(
		db,
		await createAuthCookie(
			{ ...session, rememberMe: true },
			false,
			eightDaysAgo,
		),
	)
	expect(rememberedEightDays.user).not.toBeNull()
	expect(rememberedEightDays.user?.username).toBe('session-user')
	expect(rememberedEightDays.setCookie ?? '').not.toContain('Max-Age=0')

	expectSignedOutWithClearedCookie(
		await resolveCookie(
			db,
			await createAuthCookie(
				{ ...session, rememberMe: true },
				false,
				thirtyOneDaysAgo,
			),
		),
	)

	const fresh = await resolveCookie(
		db,
		await createAuthCookie(session, false, now),
	)
	expect(fresh.user).not.toBeNull()
	expect(fresh.user?.username).toBe('session-user')

	const legacyCookie = createCookie('kody_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		secrets: [testCookieSecret],
	})
	expectSignedOutWithClearedCookie(
		await resolveCookie(
			db,
			await legacyCookie.serialize(
				JSON.stringify({
					v: 2,
					stableUserId,
					email: sessionEmail,
				}),
			),
		),
	)
})
