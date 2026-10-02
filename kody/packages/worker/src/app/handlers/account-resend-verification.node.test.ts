import { beforeAll, expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	createAccountResendVerificationHandler,
	resendVerificationRateLimitConfig,
} from './account-resend-verification.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const rateLimitKey = 'verification-resend:user:1'
const cloudflareEmailEnv = {
	CLOUDFLARE_ACCOUNT_ID: 'cf-account-test',
	CLOUDFLARE_API_TOKEN: 'cf-token-test',
	CLOUDFLARE_API_BASE_URL: 'https://cloudflare-api.example.com',
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const session: AuthSession = {
	stableUserId: testStableUserIdFromEmail('resend-user@example.com'),
	email: 'resend-user@example.com',
	rememberMe: false,
}

/** Account 1 (signed in) plus a bystander whose outstanding token must survive. */
async function createResendStore(
	options: {
		emailVerifiedAt?: string | null
		deliveryClass?: string | null
		deliveryStatus?: string | null
		deletingAt?: string | null
	} = {},
) {
	const store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (
			id, email, username, password_hash, stable_user_id, email_verified_at,
			email_verification_delivery_status, email_verification_delivery_class, deleting_at
		) VALUES
			(1, $1, 'resend-user', 'unused', $2, $3, $4, $5, $6),
			(2, 'bystander@example.com', 'bystander', 'unused', $7, NULL, NULL, NULL, NULL)`,
		[
			session.email,
			session.stableUserId,
			options.emailVerifiedAt ?? null,
			options.deliveryStatus ?? null,
			options.deliveryClass ?? null,
			options.deletingAt ?? null,
			testStableUserIdFromEmail('bystander@example.com'),
		],
	)
	await store.pg.query(
		`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (2, 'bystander-token', $1)`,
		[Date.now() + 60_000],
	)
	return store
}

function createAppEnv(db: PgDatabase, overrides: Record<string, unknown> = {}) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		FLAG_EXPOSURES: { writeDataPoint() {} },
		...overrides,
	} as unknown as Parameters<typeof createAccountResendVerificationHandler>[0]
}

/** The signed-in account's handler on its own scoped writer. */
function createHandler(store: TestDb, overrides: Record<string, unknown> = {}) {
	return createAccountResendVerificationHandler(
		createAppEnv(store.forUser(session.stableUserId).db, overrides),
	)
}

async function readTokenHashes(store: TestDb, userId: number) {
	return (
		await store.pg.query<{ token_hash: string }>(
			`SELECT token_hash FROM email_verifications WHERE user_id = $1 ORDER BY id`,
			[userId],
		)
	).rows.map((row) => row.token_hash)
}

async function countRateLimitSlots(store: TestDb) {
	return (
		await store.pg.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM _rate_limits WHERE key = $1`,
			[rateLimitKey],
		)
	).rows[0]!.count
}

async function createResendRequest() {
	const cookie = await createAuthCookie(session, false)
	return new Request('http://example.com/account/resend-verification.json', {
		method: 'POST',
		headers: { Cookie: cookie },
	})
}

async function runHandler(
	handler: ReturnType<typeof createAccountResendVerificationHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

/**
 * A purge claim (owner stamps `deleting_at`) that lands right after the
 * handler's session lookup or right after its writable check.
 */
function claimPurgeAfter(
	store: TestDb,
	db: PgDatabase,
	step: 'session lookup' | 'writable check',
) {
	const claim = () =>
		store.pg.query(
			`UPDATE users SET deleting_at = '2026-09-02 12:00:00' WHERE id = 1 AND deleting_at IS NULL`,
		)
	return {
		...db,
		async batch(statements) {
			const results = await db.batch(statements)
			const readsUser = statements.some((statement) =>
				/from "users"/.test((statement as { query?: string }).query ?? ''),
			)
			if (step === 'session lookup' && readsUser) await claim()
			return results
		},
		prepare(sql: string) {
			const statement = db.prepare(sql)
			if (
				step !== 'writable check' ||
				!/^SELECT deleting_at FROM users\b/.test(sql)
			)
				return statement
			return {
				...statement,
				bind(...values: Array<unknown>) {
					const bound = statement.bind(...values)
					return {
						...bound,
						async first(column?: string) {
							const row = await bound.first(column)
							await claim()
							return row
						},
					} as typeof bound
				},
			} as typeof statement
		},
	} satisfies PgDatabase
}

function createRacingHandler(
	store: TestDb,
	step: 'session lookup' | 'writable check',
) {
	return createAccountResendVerificationHandler(
		createAppEnv(
			claimPurgeAfter(store, store.forUser(session.stableUserId).db, step),
		),
	)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('resend verification requires an authenticated session', async () => {
	await using store = await createResendStore()

	const response = await runHandler(
		createHandler(store),
		new Request('http://example.com/account/resend-verification.json', {
			method: 'POST',
		}),
	)
	expect(response.status).toBe(401)
	expect(await readTokenHashes(store, 1)).toEqual([])
})

test('resend verification issues a fresh token for unverified accounts and rate-limits repeats', async () => {
	await using store = await createResendStore({ emailVerifiedAt: null })
	const handler = createHandler(store)

	const issued: Array<Array<string>> = []
	for (
		let attempt = 1;
		attempt <= resendVerificationRateLimitConfig.maxRequests;
		attempt++
	) {
		const response = await runHandler(handler, await createResendRequest())
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			message: 'Verification email sent. Check your inbox.',
		})
		issued.push(await readTokenHashes(store, 1))
	}
	// Each resend leaves exactly one live token, and it is a new one.
	expect(issued.map((hashes) => hashes.length)).toEqual([1, 1, 1])
	expect(new Set(issued.flat()).size).toBe(3)
	expect(await readTokenHashes(store, 2)).toEqual(['bystander-token'])
	expect(await countRateLimitSlots(store)).toBe(3)
	// No email sender is configured in this test env, so each resend logs
	// the send as skipped at info level.
	expect(consoleInfo).toHaveBeenCalledWith(
		'email-verification-send-skipped',
		expect.any(Number),
	)

	const rateLimitedResponse = await runHandler(
		handler,
		await createResendRequest(),
	)
	expect(rateLimitedResponse.status).toBe(429)
	expect(rateLimitedResponse.headers.get('Retry-After')).toBeTruthy()
	expect(await rateLimitedResponse.json()).toEqual({
		ok: false,
		error: 'Too many verification emails requested. Please try again later.',
	})
	// No new token is created for rate-limited requests.
	expect(await readTokenHashes(store, 1)).toEqual(issued.at(-1))
	// Three successful resends plus the rate-limited attempt are audited.
	expect(logAuditEventSpy).toHaveBeenCalledTimes(4)
	expect(logAuditEventSpy).toHaveBeenNthCalledWith(
		3,
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'success',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenNthCalledWith(
		4,
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'rate_limited',
		}),
	)
})

test('resend verification records the provider message id and accepted delivery for each send', async () => {
	await using store = await createResendStore({
		emailVerifiedAt: null,
		deliveryStatus: 'delivery_delayed',
	})
	const handler = createHandler(store, cloudflareEmailEnv)
	const messageIds = ['msg-first', 'msg-second']
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json({
				success: true,
				result: { message_id: messageIds.shift() },
			}),
		),
	)
	try {
		for (const _attempt of [1, 2]) {
			const response = await runHandler(handler, await createResendRequest())
			expect(response.status).toBe(200)
		}
	} finally {
		vi.unstubAllGlobals()
	}

	// Latest send wins in the delivery index for this recipient.
	expect(
		(
			await store.pg.query(
				`SELECT provider_message_id, user_id::int AS user_id, recipient
				 FROM transactional_email_delivery_index`,
			)
		).rows,
	).toEqual([
		{
			provider_message_id: 'msg-second',
			user_id: 1,
			recipient: session.email,
		},
	])
	expect(
		(
			await store.pg.query(
				`SELECT email_verification_delivery_status AS status FROM users WHERE id = 1`,
			)
		).rows[0],
	).toEqual({ status: 'accepted' })
	expect(await readTokenHashes(store, 1)).toHaveLength(1)
})

test('resend verification refuses a known sender-domain block without sending again', async () => {
	await using store = await createResendStore({
		emailVerifiedAt: null,
		deliveryStatus: 'bounced',
		deliveryClass: 'sender_block',
	})

	const response = await runHandler(
		createHandler(store),
		await createResendRequest(),
	)
	expect(response.status).toBe(409)
	expect(await response.json()).toMatchObject({
		ok: false,
		code: 'sender_block',
	})
	expect(await readTokenHashes(store, 1)).toEqual([])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'failure',
			reason: 'sender_block',
		}),
	)
})

test('resend verification rejects already-verified accounts', async () => {
	await using store = await createResendStore({
		emailVerifiedAt: new Date(0).toISOString(),
	})

	const response = await runHandler(
		createHandler(store),
		await createResendRequest(),
	)
	expect(response.status).toBe(400)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Your email is already verified.',
	})
	expect(await readTokenHashes(store, 1)).toEqual([])
})

test('resend verification surfaces send failures without pretending success', async () => {
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	await using store = await createResendStore({ emailVerifiedAt: null })
	await store.pg.query(
		`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (1, 'prior-token', $1)`,
		[Date.now() + 60_000],
	)
	const handler = createHandler(store, cloudflareEmailEnv)
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json(
				{ success: false, errors: [{ message: 'delivery refused' }] },
				{ status: 500 },
			),
		),
	)

	const response = await runHandler(handler, await createResendRequest())
	vi.unstubAllGlobals()
	expect(response.status).toBe(502)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Unable to send the verification email. Please try again later.',
	})
	// The failed send refunds the consumed rate-limit slot.
	expect(await countRateLimitSlots(store)).toBe(0)
	// The freshly inserted token is discarded again on send failure, so no
	// net-new token remains and prior tokens stay untouched.
	expect(await readTokenHashes(store, 1)).toEqual(['prior-token'])
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
	// The failed Cloudflare API send is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'email_verification_resend',
			result: 'failure',
			reason: 'send_failed',
		}),
	)
})

test('resend verification refuses a fenced account without minting a token', async () => {
	await using fenced = await createResendStore({
		emailVerifiedAt: null,
		deletingAt: '2026-09-02 12:00:00',
	})
	// A deleting account's session no longer authenticates at all.
	const fencedResponse = await runHandler(
		createHandler(fenced),
		await createResendRequest(),
	)
	expect(fencedResponse.status).toBe(401)
	expect(await readTokenHashes(fenced, 1)).toEqual([])

	// A claim after the session lookup is caught by the writable check.
	await using racing = await createResendStore({ emailVerifiedAt: null })
	const response = await runHandler(
		createRacingHandler(racing, 'session lookup'),
		await createResendRequest(),
	)
	expect(response.status).toBe(409)
	expect(await response.json()).toMatchObject({
		ok: false,
		code: 'account_deleting',
	})
	expect(await readTokenHashes(racing, 1)).toEqual([])
	expect(await countRateLimitSlots(racing)).toBe(0)
})

test('resend verification refuses a purge claim that lands after the writable check', async () => {
	await using store = await createResendStore({ emailVerifiedAt: null })

	const response = await runHandler(
		createRacingHandler(store, 'writable check'),
		await createResendRequest(),
	)
	expect(response.status).toBe(409)
	expect(await response.json()).toMatchObject({
		ok: false,
		code: 'account_deleting',
	})
	expect(await readTokenHashes(store, 1)).toEqual([])
})
