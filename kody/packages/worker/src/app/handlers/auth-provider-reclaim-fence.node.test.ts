import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthProviderCallbackHandler } =
	await import('#app/handlers/auth-provider.ts')
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import {
	type AuthTestDb,
	createAppEnv,
	createMigratedDb,
	getCookiePair,
	runHandler,
	seedUser,
	startProviderFlow,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const msw = createMswNodeServer()

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

afterEach(() => {
	msw.resetHandlers()
})

afterAll(() => {
	msw.close()
})

/** A purge claim (deleting_at stamped) landing right after the writable check. */
function withDeletingAtAfterWritableCheck(
	store: AuthTestDb,
	deletingAt: string,
) {
	return (db: PgDatabase): PgDatabase => ({
		...db,
		prepare(query: string) {
			const statement = db.prepare(query)
			const normalized = query.replace(/\s+/g, ' ').toLowerCase()
			if (
				!normalized.includes('select deleting_at from users') ||
				!normalized.includes('stable_user_id')
			) {
				return statement
			}
			return {
				...statement,
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async first(column?: string) {
							const row = await bound.first(column)
							await store.pg.query(
								`UPDATE users SET deleting_at = $1 WHERE stable_user_id = $2`,
								[deletingAt, params[0]],
							)
							return row
						},
					} as typeof bound
				},
			} as typeof statement
		},
	})
}

/** A purge claim landing right before the oauth_connections insert. */
function withDeletingAtBeforeOauthConnectionInsert(
	store: AuthTestDb,
	deletingAt: string,
) {
	return (db: PgDatabase): PgDatabase => ({
		...db,
		prepare(query: string) {
			const statement = db.prepare(query)
			const normalized = query.replace(/\s+/g, ' ').toLowerCase()
			if (!normalized.includes('insert into oauth_connections')) {
				return statement
			}
			return {
				...statement,
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async run() {
							await store.pg.query(
								`UPDATE users SET deleting_at = $1 WHERE deleting_at IS NULL`,
								[deletingAt],
							)
							return bound.run()
						},
					} as typeof bound
				},
			} as typeof statement
		},
	})
}

test('google sign-in does not reclaim a fenced unverified account', async () => {
	await using db = await createMigratedDb()
	const env = createAppEnv(db, {
		OAUTH_PROVIDER: {
			listUserGrants: async () => ({ items: [] }),
			revokeGrant: async () => undefined,
		},
	})
	await seedUser(db, {
		id: 9,
		email: 'fenced-squat@example.com',
		username: 'fenced-squat',
		emailVerified: false,
	})
	await db.sql.exec(
		`UPDATE users SET deleting_at = '2026-09-01 12:00:00' WHERE id = 9`,
	)

	msw.use(
		http.post('https://oauth2.googleapis.com/token', () =>
			HttpResponse.json({ access_token: 'google-access-token' }),
		),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({
				sub: 'google-fenced-sub',
				email: 'fenced-squat@example.com',
				email_verified: true,
				name: 'Real Owner',
			}),
		),
	)

	const start = await startProviderFlow(
		env,
		'google',
		'http://example.com/auth/google',
	)
	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'google' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe(
		'/login?oauthError=email-unavailable',
	)
	expect(
		callbackResponse.headers
			.getSetCookie()
			.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(false)

	const user = (await db.sql.get(
		`SELECT email_verified_at, deleting_at FROM users WHERE id = 9`,
	)) as { email_verified_at: string | null; deleting_at: string | null }
	expect(user.email_verified_at).toBeNull()
	expect(user.deleting_at).toBe('2026-09-01 12:00:00')
	expect(
		await db.sql.get(
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 9`,
		),
	).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'failure',
			reason: 'account_deleting',
		}),
	)
})

test('google sign-in does not reclaim when a purge claim lands between the writable check and the stamp', async () => {
	await using rawDb = await createMigratedDb()
	const env = createAppEnv(
		rawDb,
		{
			OAUTH_PROVIDER: {
				listUserGrants: async () => ({ items: [] }),
				revokeGrant: async () => undefined,
			},
		},
		{
			wrapAccountDb: withDeletingAtAfterWritableCheck(
				rawDb,
				'2026-09-02 12:00:00',
			),
		},
	)
	await seedUser(rawDb, {
		id: 10,
		email: 'race-squat@example.com',
		username: 'race-squat',
		emailVerified: false,
	})

	msw.use(
		http.post('https://oauth2.googleapis.com/token', () =>
			HttpResponse.json({ access_token: 'google-access-token' }),
		),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({
				sub: 'google-race-sub',
				email: 'race-squat@example.com',
				email_verified: true,
				name: 'Real Owner',
			}),
		),
	)

	const start = await startProviderFlow(
		env,
		'google',
		'http://example.com/auth/google',
	)
	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'google' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe(
		'/login?oauthError=email-unavailable',
	)
	expect(
		callbackResponse.headers
			.getSetCookie()
			.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(false)

	const user = (await rawDb.sql.get(
		`SELECT email_verified_at, deleting_at FROM users WHERE id = 10`,
	)) as { email_verified_at: string | null; deleting_at: string | null }
	expect(user.email_verified_at).toBeNull()
	expect(user.deleting_at).toBe('2026-09-02 12:00:00')
	expect(
		await rawDb.sql.get(
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 10`,
		),
	).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'failure',
			reason: 'account_deleting',
		}),
	)
})

test('google sign-in does not reclaim when a purge claim lands before the oauth connection insert', async () => {
	await using rawDb = await createMigratedDb()
	const env = createAppEnv(
		rawDb,
		{
			OAUTH_PROVIDER: {
				listUserGrants: async () => ({ items: [] }),
				revokeGrant: async () => undefined,
			},
		},
		{
			wrapAccountDb: withDeletingAtBeforeOauthConnectionInsert(
				rawDb,
				'2026-09-02 12:00:00',
			),
		},
	)
	await seedUser(rawDb, {
		id: 13,
		email: 'race-insert-squat@example.com',
		username: 'race-insert-squat',
		emailVerified: false,
	})

	msw.use(
		http.post('https://oauth2.googleapis.com/token', () =>
			HttpResponse.json({ access_token: 'google-access-token' }),
		),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({
				sub: 'google-race-insert-sub',
				email: 'race-insert-squat@example.com',
				email_verified: true,
				name: 'Real Owner',
			}),
		),
	)

	const start = await startProviderFlow(
		env,
		'google',
		'http://example.com/auth/google',
	)
	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'google' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe(
		'/login?oauthError=email-unavailable',
	)
	expect(
		callbackResponse.headers
			.getSetCookie()
			.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(false)

	const user = (await rawDb.sql.get(
		`SELECT email_verified_at, deleting_at FROM users WHERE id = 13`,
	)) as { email_verified_at: string | null; deleting_at: string | null }
	expect(user.email_verified_at).toBeNull()
	expect(user.deleting_at).toBe('2026-09-02 12:00:00')
	expect(
		await rawDb.sql.get(
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 13`,
		),
	).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'failure',
			reason: 'account_deleting',
		}),
	)
})

test('signed-in unverified accounts cannot link a provider; verified accounts still can', async () => {
	await using db = await createMigratedDb()
	const mockGithub = {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	}
	// Signed-in callbacks run on the session account's writer.
	const env = createAppEnv(db, mockGithub, {
		sessionUserId: await createStableUserIdFromEmail(
			'squat-linker@example.com',
		),
	})
	const verifiedEnv = createAppEnv(db, mockGithub, {
		sessionUserId: await createStableUserIdFromEmail(
			'verified-linker@example.com',
		),
	})
	await seedUser(db, {
		id: 31,
		email: 'squat-linker@example.com',
		username: 'squat-linker',
		emailVerified: false,
	})
	await seedUser(db, {
		id: 32,
		email: 'verified-linker@example.com',
		username: 'verified-linker',
		emailVerified: true,
	})

	const unverifiedSessionCookie = getCookiePair(
		await createAuthCookie(
			{
				stableUserId: await createStableUserIdFromEmail(
					'squat-linker@example.com',
				),
				email: 'squat-linker@example.com',
				rememberMe: false,
			},
			false,
		),
	)
	const unverifiedStart = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const unverifiedResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(unverifiedStart.location, {
			headers: {
				Cookie: `${unverifiedStart.stateCookie}; ${unverifiedSessionCookie}`,
			},
		}),
		{ provider: 'github' },
	)
	expect(unverifiedResponse.status).toBe(302)
	expect(unverifiedResponse.headers.get('Location')).toBe(
		'/account?oauthError=email-unverified',
	)
	expect(
		await db.sql.get(
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = 31`,
		),
	).toEqual({ count: 0 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'failure',
			reason: 'email_unverified',
		}),
	)

	const verifiedSessionCookie = getCookiePair(
		await createAuthCookie(
			{
				stableUserId: await createStableUserIdFromEmail(
					'verified-linker@example.com',
				),
				email: 'verified-linker@example.com',
				rememberMe: false,
			},
			false,
		),
	)
	const verifiedStart = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const verifiedResponse = await runHandler(
		createAuthProviderCallbackHandler(verifiedEnv),
		new Request(verifiedStart.location, {
			headers: {
				Cookie: `${verifiedStart.stateCookie}; ${verifiedSessionCookie}`,
			},
		}),
		{ provider: 'github' },
	)
	expect(verifiedResponse.status).toBe(302)
	expect(verifiedResponse.headers.get('Location')).toBe(
		'/account?oauthLinked=github',
	)
	expect(
		await db.sql.get(
			`SELECT user_id FROM oauth_connections WHERE provider_name = 'github'`,
		),
	).toEqual({ user_id: 32 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_connection_linked',
			result: 'success',
			email: 'verified-linker@example.com',
		}),
	)
})
