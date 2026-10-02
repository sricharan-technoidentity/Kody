import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

test('loadSessionInfo signs out a deleting account and clears the session cookie', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'a'.repeat(64),
		email: 'deleting@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id, deleting_at)
		 VALUES (7, 'deleting@example.com', 'deleting-user', 'unused', $1, '2026-08-31 15:00:00')`,
		[session.stableUserId],
	)
	const env = {
		COOKIE_SECRET: testCookieSecret,
		APP_DB: store.forUser(session.stableUserId).db,
	} as unknown as Env

	const loaded = await loadSessionInfo(
		new Request('https://example.com/', { headers: { Cookie: cookie } }),
		env,
	)
	expect(loaded.session).toBeNull()
	expect(loaded.setCookie ?? '').toContain('kody_session=')
	expect(loaded.setCookie ?? '').toContain('Max-Age=0')
})
