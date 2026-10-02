import { RequestContext } from 'remix/router'
import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { verifyEmailClaimReleaseToken } from '#app/email-claim-release.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { formerEmailClaimedSignupCode } from '#universal/email-claim-errors.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { createPgDatabase, type SqlDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { allocateSignupIdentity } from '#worker/identity/email-claims.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createAccountEmailClaimReleaseHandler } from './account-email-claim-release.ts'
import { createAuthHandler } from './auth.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seedUser(
	store: TestDb,
	input: {
		id: number
		email: string
		username: string
		password: string
		stableUserId?: string
	},
) {
	const passwordHash = await createPasswordHash(input.password)
	const stableUserId =
		input.stableUserId ?? (await createStableUserIdFromEmail(input.email))
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES ($1, $2, $3, $4, $5, '2026-01-01T00:00:00.000Z')`,
		[input.id, input.username, input.email, stableUserId, passwordHash],
	)
	return stableUserId
}

function createAppEnv(
	db: SqlDatabase,
	overrides: Record<string, unknown> = {},
) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		...overrides,
	} as unknown as Env
}

async function createReleaseRequest(input: {
	session: AuthSession
	email: string
	password: string
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/email-claim-release.json', {
		method: 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			email: input.email,
			password: input.password,
		}),
	})
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('signed-out release link re-verifies a former address, then signup allocates a fresh identity', async () => {
	consoleWarn.mockImplementation(() => {})
	await using store = await createTestDb()
	const formerEmail = 'personal@example.com'
	const currentEmail = 'work@example.com'
	const stableUserId = await seedUser(store, {
		id: 1,
		email: currentEmail,
		username: 'jamie',
		password: 'correct-password',
		stableUserId: await createStableUserIdFromEmail(formerEmail),
	})
	await store.pg.query(
		`INSERT INTO user_email_claims (user_id, email, status)
		 VALUES (1, $1, 'claimed'), (1, $2, 'claimed')`,
		[currentEmail, formerEmail],
	)

	const handler = createAccountEmailClaimReleaseHandler(
		createAppEnv(store.forUser(stableUserId).db),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail(formerEmail),
		email: currentEmail,
		rememberMe: false,
	}

	const currentEmailResponse = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: currentEmail,
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(currentEmailResponse.status).toBe(400)

	// Identity allocation is a trusted account-administration operation.
	const adminDb = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	const signupHandler = createAuthHandler(createAppEnv(adminDb))
	const blockedSignup = await signupHandler.handler(
		new RequestContext(
			new Request('http://example.com/auth', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: formerEmail,
					username: 'new-jamie',
					password: 'password123',
					mode: 'signup',
				}),
			}),
		),
	)
	expect(blockedSignup.status).toBe(409)
	expect(await blockedSignup.json()).toMatchObject({
		code: formerEmailClaimedSignupCode,
	})

	const requestResponse = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: formerEmail,
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(requestResponse.status).toBe(200)
	expect(await requestResponse.json()).toMatchObject({ ok: true })

	const [pending] = (
		await store.pg.query<{ token_hash: string }>(
			`SELECT token_hash FROM pending_email_claim_releases WHERE user_id = 1`,
		)
	).rows
	expect(pending?.token_hash).toEqual(expect.any(String))

	const token = 'release-former-email-token'
	await store.pg.query(
		`UPDATE pending_email_claim_releases SET token_hash = $1 WHERE user_id = 1`,
		[await hashVerificationToken(token)],
	)

	// The link is opened signed out: the pre-auth writer sees no pending rows.
	const signedOut = {
		db: store.forUser().db,
		forUser: (userId: string) => store.forUser(userId).db,
	}
	expect(
		await verifyEmailClaimReleaseToken({ ...signedOut, token: 'unknown' }),
	).toEqual({ ok: false, reason: 'invalid_token' })
	const verified = await verifyEmailClaimReleaseToken({ ...signedOut, token })
	expect(verified).toEqual({
		ok: true,
		userId: 1,
		email: formerEmail,
	})
	expect(
		(
			await store.pg.query(
				`SELECT status FROM user_email_claims WHERE user_id = 1 AND email = $1`,
				[formerEmail],
			)
		).rows,
	).toEqual([{ status: 'released' }])
	expect(
		(await store.pg.query(`SELECT stable_user_id FROM users WHERE id = 1`))
			.rows,
	).toEqual([{ stable_user_id: stableUserId }])

	// After release, signup allocation no longer reserves the address and mints
	// a fresh identity. Completing the signup on the new account's writer is
	// the auth-handler batch's scoped account setup.
	const allocated = await allocateSignupIdentity(adminDb, formerEmail)
	expect(allocated).toEqual({ ok: true, stableUserId: expect.any(String) })
	expect(allocated.ok && allocated.stableUserId).not.toBe(stableUserId)
	expect(allocated.ok && allocated.stableUserId).toMatch(/^[a-f0-9]{64}$/)
})

test('release requests are rate limited and refuse another account email', async () => {
	consoleWarn.mockImplementation(() => {})
	await using store = await createTestDb()
	const ownerId = await seedUser(store, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
		password: 'correct-password',
	})
	await seedUser(store, {
		id: 2,
		email: 'other@example.com',
		username: 'other',
		password: 'other-password',
	})
	await store.pg.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (2, 'other@example.com', 'claimed')
	`)
	const handler = createAccountEmailClaimReleaseHandler(
		createAppEnv(store.forUser(ownerId).db),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail('owner@example.com'),
		email: 'owner@example.com',
		rememberMe: false,
	}

	const stranger = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'other@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(stranger.status).toBe(404)

	const first = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'old@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(first.status).toBe(404)

	const second = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'old@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(second.status).toBe(404)

	const limited = await handler.handler({
		request: await createReleaseRequest({
			session,
			email: 'old@example.com',
			password: 'correct-password',
		}),
		url: new URL('http://example.com/account/email-claim-release.json'),
		params: {},
	} as never)
	expect(limited.status).toBe(429)
})

test('refunds the request limiter when the release email cannot be sent', async () => {
	consoleError.mockImplementation(() => {})
	await using store = await createTestDb()
	const ownerId = await seedUser(store, {
		id: 1,
		email: 'owner@example.com',
		username: 'owner',
		password: 'correct-password',
	})
	await store.pg.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (1, 'owner@example.com', 'claimed'), (1, 'old@example.com', 'claimed')
	`)
	const handler = createAccountEmailClaimReleaseHandler(
		createAppEnv(store.forUser(ownerId).db, {
			SENTRY_ENVIRONMENT: 'production',
		}),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail('owner@example.com'),
		email: 'owner@example.com',
		rememberMe: false,
	}

	for (let attempt = 0; attempt < 4; attempt += 1) {
		const response = await handler.handler({
			request: await createReleaseRequest({
				session,
				email: 'old@example.com',
				password: 'correct-password',
			}),
			url: new URL('http://example.com/account/email-claim-release.json'),
			params: {},
		} as never)
		expect(response.status).toBe(502)
	}
	expect(consoleError).toHaveBeenCalled()
	// Every failed send discarded its token.
	expect(
		(
			await store.pg.query(
				`SELECT COUNT(*)::int AS count FROM pending_email_claim_releases`,
			)
		).rows,
	).toEqual([{ count: 0 }])
})
