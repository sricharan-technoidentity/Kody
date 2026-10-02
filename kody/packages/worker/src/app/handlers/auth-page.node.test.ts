import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAuthPageHandler } from '#app/handlers/auth-page.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async (input: { extraSetCookies?: Array<string> }) => {
		const headers = new Headers({ 'Content-Type': 'text/html' })
		for (const cookie of input.extraSetCookies ?? []) {
			headers.append('Set-Cookie', cookie)
		}
		return new Response('login-page', {
			status: 200,
			headers,
		})
	},
}))

function createSessionTestEnv(db: PgDatabase) {
	return { COOKIE_SECRET: testCookieSecret, APP_DB: db } as unknown as Env
}

test('auth page renders login for a stale session instead of redirecting away', async () => {
	setAuthSessionSecret(testCookieSecret)
	const session: AuthSession = {
		stableUserId: 'f'.repeat(64),
		email: 'missing@example.com',
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	await using store = await createTestDb()
	const handler = createAuthPageHandler(
		createSessionTestEnv(store.forUser(session.stableUserId).db),
		'login',
	)
	const response = await handler.handler(
		new RequestContext(
			new Request('https://example.com/login?redirectTo=%2Faccount', {
				headers: { Cookie: cookie },
			}),
		),
	)

	expect(response.status).toBe(200)
	expect(await response.text()).toBe('login-page')
})

test('auth page renders login for a deleting account instead of redirecting to /account', async () => {
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
	const env = createSessionTestEnv(store.forUser(session.stableUserId).db)
	const handler = createAuthPageHandler(env, 'login')
	const response = await handler.handler(
		new RequestContext(
			new Request('https://example.com/login?redirectTo=%2Faccount', {
				headers: { Cookie: cookie },
			}),
		),
	)

	expect(response.status).toBe(200)
	expect(await response.text()).toBe('login-page')
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=0')
})
