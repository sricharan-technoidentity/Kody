import { generateTOTP } from '@epic-web/totp'
import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: vi.fn(),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')
import { confirmTwoFactorSetup } from '#app/two-factor.ts'
import { createAccountTwoFactorApiHandler } from '#app/handlers/account-two-factor.ts'
import { createTwoFactorVerifyApiHandler } from '#app/handlers/verify.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { twoFactorVerifyRateLimitConfig } from '#app/rate-limit.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seedUser(
	store: TestDb,
	input: {
		id: number
		email: string
		username: string
		password: string
	},
) {
	const passwordHash = await createPasswordHash(input.password)
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES ($1, $2, $3, $4, $5, '2026-01-01T00:00:00.000Z')`,
		[input.id, input.username, input.email, stableUserId, passwordHash],
	)
}

function createAppEnv(db: PgDatabase, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Parameters<typeof createAccountTwoFactorApiHandler>[0]
}

/** Signed-out requests: a writer with no account context plus the owner factory. */
function createPreAuthEnv(store: TestDb) {
	return createAppEnv(store.forUser().db, {
		APP_DB_FOR_USER: (userId: string) => store.forUser(userId).db,
	})
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(
	handler: Handler,
	request: Request,
): Promise<Response> {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

async function createTwoFactorApiRequest(input: {
	session: AuthSession
	body: Record<string, unknown>
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/two-factor.json', {
		method: 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(input.body),
	})
}

async function readVerificationRow(store: TestDb, target: string) {
	return (
		await store.pg.query<{
			type: string
			secret: string
			algorithm: string
			digits: number
			period: number
			char_set: string
		}>(
			`SELECT type, secret, algorithm, digits::int AS digits, period::int AS period, char_set
			 FROM verifications WHERE target = $1`,
			[target],
		)
	).rows[0]
}

async function countVerifications(store: TestDb, target: string) {
	return (
		await store.pg.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM verifications WHERE target = $1`,
			[target],
		)
	).rows[0]!.count
}

async function generateCurrentCode(row: {
	secret: string
	algorithm: string
	digits: number
	period: number
	char_set: string
}) {
	const { otp } = await generateTOTP({
		secret: row.secret,
		algorithm: row.algorithm,
		digits: row.digits,
		period: row.period,
		charSet: row.char_set,
	})
	return otp
}

function initTestSecrets() {
	setAuthSessionSecret(testCookieSecret)
	setVerifySessionSecret(testCookieSecret)
}

const session: AuthSession = {
	stableUserId: testStableUserIdFromEmail('kody@example.com'),
	email: 'kody@example.com',
	rememberMe: false,
}

/** The primary account plus a bystander whose factor must stay untouched. */
async function createPrimaryUserDb() {
	const store = await createTestDb()
	await seedUser(store, {
		id: 1,
		email: 'kody@example.com',
		username: 'kody',
		password: 'ilikecode',
	})
	await seedUser(store, {
		id: 2,
		email: 'bystander@example.com',
		username: 'bystander',
		password: 'bystander-pw',
	})
	await store.pg.exec(`
		INSERT INTO verifications (type, target, secret, algorithm, digits, period, char_set)
		VALUES ('2fa', '2', 'BYSTANDERSECRET', 'SHA-1', 6, 30, '0123456789')
	`)
	return store
}

test('two-factor setup requires authentication and a valid code before activating', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const unauthenticatedHandler = createAccountTwoFactorApiHandler(
		createAppEnv(store.forUser().db),
	)
	const unauthenticated = await runHandler(
		unauthenticatedHandler,
		new Request('http://example.com/account/two-factor.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ intent: 'setup' }),
		}),
	)
	expect(unauthenticated.status).toBe(401)

	const handler = createAccountTwoFactorApiHandler(
		createAppEnv(store.forUser(session.stableUserId).db),
	)

	const setupResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	expect(setupResponse.status).toBe(200)
	const setupPayload = (await setupResponse.json()) as {
		ok: boolean
		otpUri: string
		secret: string
	}
	expect(setupPayload.ok).toBe(true)
	expect(setupPayload.otpUri).toContain('otpauth://totp/')
	expect(setupPayload.otpUri).toContain(setupPayload.secret)

	const pendingRow = await readVerificationRow(store, '1')
	expect(pendingRow).toMatchObject({
		type: '2fa-verify',
		secret: setupPayload.secret,
	})

	const invalidResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: '000000' },
		}),
	)
	expect(invalidResponse.status).toBe(400)
	expect((await readVerificationRow(store, '1'))?.type).toBe('2fa-verify')

	const validCode = await generateCurrentCode(pendingRow!)
	const confirmResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: validCode },
		}),
	)
	expect(confirmResponse.status).toBe(200)
	expect(await confirmResponse.json()).toEqual({ ok: true, enabled: true })
	// The row is promoted in place: the scanned secret stays the active one.
	expect(await readVerificationRow(store, '1')).toMatchObject({
		type: '2fa',
		secret: setupPayload.secret,
	})
	// Setup start, the rejected confirm, and the successful enable are audited
	// — and nothing else.
	expect(auditEventSummaries()).toEqual([
		'two_factor_setup_start:success',
		'two_factor_enable:failure',
		'two_factor_enable:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'two_factor_enable',
			result: 'success',
		}),
	)
})

test('cancelling a pending setup removes it without touching active 2fa', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const db = store.forUser(session.stableUserId).db
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const cancelResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'cancel' } }),
	)
	expect(cancelResponse.status).toBe(200)
	expect(await cancelResponse.json()).toEqual({ ok: true, enabled: false })
	expect(await readVerificationRow(store, '1')).toBeUndefined()
})

test('login with 2fa enabled defers the session cookie to code verification', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const db = store.forUser(session.stableUserId).db
	const appEnv = createAppEnv(db)
	const twoFactorHandler = createAccountTwoFactorApiHandler(appEnv)

	await runHandler(
		twoFactorHandler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const verificationRow = (await readVerificationRow(store, '1'))!
	await runHandler(
		twoFactorHandler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'confirm',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)

	// Login still finds the account by email on the selected account's writer;
	// its pre-auth owner lookup belongs to the auth-handler batch.
	// Login is signed out: it finds the account by email through the owner definer.
	const authHandler = createAuthHandler(
		createPreAuthEnv(store) as unknown as Parameters<
			typeof createAuthHandler
		>[0],
	)
	const loginResponse = await runHandler(
		authHandler,
		new Request('http://example.com/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: 'kody@example.com',
				password: 'ilikecode',
				mode: 'login',
			}),
		}),
	)
	expect(loginResponse.status).toBe(200)
	expect(await loginResponse.json()).toEqual({
		ok: true,
		mode: 'login',
		requiresTwoFactor: true,
	})
	const loginSetCookies = loginResponse.headers.getSetCookie()
	const pendingCookie = loginSetCookies.find((cookie) =>
		cookie.startsWith('kody_verify='),
	)
	expect(pendingCookie).toBeDefined()
	// Any pre-existing session is cleared while the second factor is pending.
	expect(
		loginSetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_session=') && cookie.includes('Max-Age=0'),
		),
	).toBe(true)
	expect(
		loginSetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
		),
	).toBe(false)

	const verifyHandler = createTwoFactorVerifyApiHandler(createPreAuthEnv(store))
	const verifyCookieValue = pendingCookie?.split(';')[0] ?? ''

	const invalidVerifyResponse = await runHandler(
		verifyHandler,
		new Request('http://example.com/verify/2fa.json', {
			method: 'POST',
			headers: {
				Cookie: verifyCookieValue,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ code: '000000' }),
		}),
	)
	expect(invalidVerifyResponse.status).toBe(400)
	expect(invalidVerifyResponse.headers.get('Set-Cookie')).toBeNull()

	const validVerifyResponse = await runHandler(
		verifyHandler,
		new Request('http://example.com/verify/2fa.json', {
			method: 'POST',
			headers: {
				Cookie: verifyCookieValue,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				code: await generateCurrentCode(verificationRow),
			}),
		}),
	)
	expect(validVerifyResponse.status).toBe(200)
	expect(await validVerifyResponse.json()).toEqual({ ok: true })
	const verifySetCookies = validVerifyResponse.headers.getSetCookie()
	expect(
		verifySetCookies.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(true)
	expect(
		verifySetCookies.some(
			(cookie) =>
				cookie.startsWith('kody_verify=') && cookie.includes('Max-Age=0'),
		),
	).toBe(true)

	const missingVerifyResponse = await runHandler(
		verifyHandler,
		new Request('http://example.com/verify/2fa.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: '123456' }),
		}),
	)
	expect(missingVerifyResponse.status).toBe(401)
	expect(await missingVerifyResponse.json()).toMatchObject({
		ok: false,
		code: 'expired',
	})
})

test('repeated invalid codes lock the account out of 2fa verification', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const db = store.forUser(session.stableUserId).db
	const appEnv = createAppEnv(db)
	const twoFactorHandler = createAccountTwoFactorApiHandler(appEnv)

	await runHandler(
		twoFactorHandler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const verificationRow = (await readVerificationRow(store, '1'))!
	await runHandler(
		twoFactorHandler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'confirm',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)

	const verifyHandler = createTwoFactorVerifyApiHandler(createPreAuthEnv(store))
	const pendingCookie = await createVerifySessionCookie(
		{
			stableUserId: session.stableUserId,
			email: session.email,
			rememberMe: false,
		},
		false,
	)
	const pendingCookieValue = pendingCookie.split(';')[0] ?? ''
	function submitCode(code: string) {
		return runHandler(
			verifyHandler,
			new Request('http://example.com/verify/2fa.json', {
				method: 'POST',
				headers: {
					Cookie: pendingCookieValue,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ code }),
			}),
		)
	}

	for (
		let attempt = 0;
		attempt < twoFactorVerifyRateLimitConfig.maxRequests;
		attempt++
	) {
		const response = await submitCode('000000')
		expect(response.status).toBe(400)
	}

	const lockedResponse = await submitCode('000000')
	expect(lockedResponse.status).toBe(429)
	expect(await lockedResponse.json()).toMatchObject({
		ok: false,
		code: 'locked',
	})
	expect(lockedResponse.headers.get('Retry-After')).toBe(
		String(twoFactorVerifyRateLimitConfig.windowSeconds),
	)
	expect(
		lockedResponse.headers
			.getSetCookie()
			.some(
				(cookie) =>
					cookie.startsWith('kody_verify=') && cookie.includes('Max-Age=0'),
			),
	).toBe(true)

	// The budget is keyed on the account, so re-minting the pending cookie by
	// logging in again does not buy more guesses.
	const validAfterLockout = await submitCode(
		await generateCurrentCode(verificationRow),
	)
	expect(validAfterLockout.status).toBe(429)
})

test('login without 2fa still issues the session cookie directly', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const authHandler = createAuthHandler(
		createPreAuthEnv(store) as unknown as Parameters<
			typeof createAuthHandler
		>[0],
	)

	const loginResponse = await runHandler(
		authHandler,
		new Request('http://example.com/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: 'kody@example.com',
				password: 'ilikecode',
				mode: 'login',
			}),
		}),
	)
	expect(loginResponse.status).toBe(200)
	expect(await loginResponse.json()).toEqual({ ok: true, mode: 'login' })
	expect(loginResponse.headers.get('Set-Cookie')).toContain('kody_session=')
})

test('disabling 2fa requires a valid current code and clears stale pending rows', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const db = store.forUser(session.stableUserId).db
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const verificationRow = (await readVerificationRow(store, '1'))!
	await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'confirm',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)

	const invalidDisable = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'disable', code: '000000' },
		}),
	)
	expect(invalidDisable.status).toBe(400)
	expect((await readVerificationRow(store, '1'))?.type).toBe('2fa')

	await store.pg.exec(`
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set, expires_at
		) VALUES ('2fa-verify', '1', 'STALESECRET', 'SHA-1', 6, 30, '0123456789', NULL);
	`)
	expect(await countVerifications(store, '1')).toBe(2)

	const validDisable = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: {
				intent: 'disable',
				code: await generateCurrentCode(verificationRow),
			},
		}),
	)
	expect(validDisable.status).toBe(200)
	expect(await validDisable.json()).toEqual({ ok: true, enabled: false })
	expect(await countVerifications(store, '1')).toBe(0)
	expect(await countVerifications(store, '2')).toBe(1)
	// The in-test 2FA enablement plus the rejected and successful disable
	// attempts are audited — and nothing else.
	expect(auditEventSummaries()).toEqual([
		'two_factor_setup_start:success',
		'two_factor_enable:success',
		'two_factor_disable:failure',
		'two_factor_disable:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'two_factor_disable',
			result: 'success',
		}),
	)
})

test('setup and confirm are rejected while 2fa is already enabled', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const db = store.forUser(session.stableUserId).db
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const activeRow = (await readVerificationRow(store, '1'))!
	await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: await generateCurrentCode(activeRow) },
		}),
	)

	// A hijacked session must not be able to swap out the active factor.
	const setupResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	expect(setupResponse.status).toBe(400)

	const confirmResponse = await runHandler(
		handler,
		await createTwoFactorApiRequest({
			session,
			body: { intent: 'confirm', code: await generateCurrentCode(activeRow) },
		}),
	)
	expect(confirmResponse.status).toBe(400)
	// The active secret is untouched.
	expect(await readVerificationRow(store, '1')).toMatchObject({
		type: '2fa',
		secret: activeRow.secret,
	})
})

test('a duplicate confirm cannot delete the active factor', async () => {
	initTestSecrets()
	await using store = await createPrimaryUserDb()
	const db = store.forUser(session.stableUserId).db
	const handler = createAccountTwoFactorApiHandler(createAppEnv(db))

	await runHandler(
		handler,
		await createTwoFactorApiRequest({ session, body: { intent: 'setup' } }),
	)
	const pendingRow = (await readVerificationRow(store, '1'))!

	// Simulates two racing confirm requests that both passed the code check:
	// the first promotes, the second must be a no-op rather than deleting the
	// freshly-activated row.
	expect(await confirmTwoFactorSetup(db, 1)).toBe(true)
	expect(await confirmTwoFactorSetup(db, 1)).toBe(false)
	expect(await readVerificationRow(store, '1')).toMatchObject({
		type: '2fa',
		secret: pendingRow.secret,
	})
})
