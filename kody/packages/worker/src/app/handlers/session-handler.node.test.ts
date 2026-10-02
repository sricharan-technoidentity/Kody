import { expect, test } from 'vitest'
import { RequestContext } from 'remix/router'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createSessionHandler } from '#app/handlers/session.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const rememberedSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('user@example.com'),
	email: 'user@example.com',
	rememberMe: true,
}

function createSessionRequestContext(cookie: string) {
	return new RequestContext(
		new Request('http://example.com/session', {
			headers: {
				Cookie: cookie,
			},
		}),
	)
}

/** The remembered account, served through its own scoped writer. */
async function createSessionTestDb() {
	const store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, email, username, password_hash, stable_user_id, created_at, updated_at)
		 VALUES (1, 'user@example.com', 'session-user', 'unused', $1, $2, $2),
		        (2, 'other@example.com', 'other-user', 'unused', $3, $2, $2)`,
		[
			rememberedSession.stableUserId,
			new Date(0).toISOString(),
			testStableUserIdFromEmail('other@example.com'),
		],
	)
	return store
}

function createEnv(db: PgDatabase) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
	} as unknown as Env
}

async function withMockedNow<T>(now: number, callback: () => Promise<T>) {
	const originalDateNow = Date.now
	Date.now = () => now
	try {
		return await callback()
	} finally {
		Date.now = originalDateNow
	}
}

test('session handler only renews remembered sessions after the renewal window', async () => {
	setAuthSessionSecret(testCookieSecret)
	await using store = await createSessionTestDb()
	const session = createSessionHandler(
		createEnv(store.forUser(rememberedSession.stableUserId).db),
	)
	const now = Date.UTC(2026, 1, 1)
	const scenarios = [
		{
			ageDays: 15,
			expectSetCookie: true,
		},
		{
			ageDays: 13,
			expectSetCookie: false,
		},
	] as const

	for (const scenario of scenarios) {
		const cookie = await createAuthCookie(
			rememberedSession,
			false,
			now - 1000 * 60 * 60 * 24 * scenario.ageDays,
		)

		const response = await withMockedNow(now, () =>
			session.handler(createSessionRequestContext(cookie)),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			session: {
				email: rememberedSession.email,
				emailVerified: false,
				emailVerificationDelivery: null,
				username: 'session-user',
				avatarUrl: null,
				roles: [],
				permissions: [],
				featureFlags: {
					'demo-indicator': false,
					'compact-mcp-server-instructions': false,
					'package-share-grants': false,
					'secret-providers': false,
					'jev-search-rerank': false,
					'execute-invoke': false,
				},
			},
		})
		if (scenario.expectSetCookie) {
			expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
		} else {
			expect(response.headers.get('Set-Cookie')).toBeNull()
		}
	}
})

test('session handler clears cookies for unknown stable user ids', async () => {
	setAuthSessionSecret(testCookieSecret)
	await using store = await createSessionTestDb()
	for (const identity of [
		{ stableUserId: 'f'.repeat(64), email: 'missing@example.com' },
		{ stableUserId: 'e'.repeat(64), email: 'user@example.com' },
	]) {
		const cookie = await createAuthCookie(
			{ ...identity, rememberMe: false },
			false,
		)
		// Each request runs on the writer for the account its cookie names.
		const session = createSessionHandler(
			createEnv(store.forUser(identity.stableUserId).db),
		)
		const response = await session.handler(createSessionRequestContext(cookie))

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: false })
		expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
	}
})
