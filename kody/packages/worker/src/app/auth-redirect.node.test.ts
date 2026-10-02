import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createStaleSessionTestEnv(db: PgDatabase) {
	return { COOKIE_SECRET: testCookieSecret, APP_DB: db } as unknown as Env
}

test('redirectToLogin attaches Set-Cookie when provided', async () => {
	const destroyCookie = 'kody_session=; Path=/; Max-Age=0'
	const response = redirectToLogin(new Request('https://example.com/account'), {
		setCookie: destroyCookie,
	})

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)
	expect(response.headers.get('Set-Cookie')).toBe(destroyCookie)
})

test('redirectToLoginWhenUnauthenticated clears a stale session cookie', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'f'.repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	// The cookie's account no longer exists; its scoped writer finds nobody.
	await using store = await createTestDb()
	const env = createStaleSessionTestEnv(store.forUser(session.stableUserId).db)

	const response = await redirectToLoginWhenUnauthenticated(
		new Request('https://example.com/account', {
			headers: { Cookie: cookie },
		}),
		env,
	)

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/login?redirectTo=%2Faccount',
	)
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=0')
})
