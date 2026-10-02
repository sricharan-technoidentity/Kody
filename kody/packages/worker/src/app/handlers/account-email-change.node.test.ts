import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { verifyEmailChangeToken } from '#app/email-change.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createAccountEmailChangeHandler } from './account-email-change.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seedUser(
	store: TestDb,
	input: {
		id: number
		email: string
		username: string
		password: string
		verified?: boolean
	},
) {
	const passwordHash = await createPasswordHash(input.password)
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			input.id,
			input.username,
			input.email,
			stableUserId,
			passwordHash,
			input.verified === false ? null : '2026-01-01T00:00:00.000Z',
		],
	)
	return stableUserId
}

async function query<T>(store: TestDb, sql: string) {
	return (await store.pg.query<T>(sql)).rows
}

function createAppEnv(db: PgDatabase) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAccountEmailChangeHandler>[0]
}

async function createRequest(input: {
	session: AuthSession
	email: string
	password: string
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/email-change.json', {
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

async function runHandler(
	handler: ReturnType<typeof createAccountEmailChangeHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('email change requests require the current password and create a pending verification', async () => {
	// No email sender is configured in this test env, so the skipped
	// verification send logs a warning.
	consoleWarn.mockImplementation(() => {})
	await using store = await createTestDb()
	const ownerId = await seedUser(store, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
	})
	const handler = createAccountEmailChangeHandler(
		createAppEnv(store.forUser(ownerId).db),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail('old@example.com'),
		email: 'old@example.com',
		rememberMe: false,
	}

	const wrongPasswordResponse = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'new@example.com',
			password: 'wrong-password',
		}),
	)
	expect(wrongPasswordResponse.status).toBe(401)
	expect(await wrongPasswordResponse.json()).toEqual({
		ok: false,
		code: 'invalid_password',
		error: 'Password is incorrect.',
	})
	expect(
		await query(
			store,
			`SELECT COUNT(*)::int AS count FROM pending_email_changes`,
		),
	).toEqual([{ count: 0 }])

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'New@Example.com',
			password: 'correct-password',
		}),
	)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		formerEmailRemainsClaimed: true,
		message:
			'Verification email sent to your new address. After you confirm, your current address stays tied to this account until you release it from Former addresses.',
	})
	const [firstPending] = await query<{
		user_id: number
		new_email: string
		token_hash: string
	}>(
		store,
		`SELECT user_id::int AS user_id, new_email, token_hash FROM pending_email_changes`,
	)
	expect(firstPending).toMatchObject({
		user_id: 1,
		new_email: 'new@example.com',
		token_hash: expect.any(String),
	})
	const firstPendingToken = firstPending!.token_hash

	const resendResponse = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'new@example.com',
			password: 'correct-password',
		}),
	)
	expect(resendResponse.status).toBe(200)
	const pendingRows = await query<{ new_email: string; token_hash: string }>(
		store,
		`SELECT new_email, token_hash FROM pending_email_changes`,
	)
	expect(pendingRows).toHaveLength(1)
	expect(pendingRows[0]).toMatchObject({
		new_email: 'new@example.com',
		token_hash: expect.any(String),
	})
	expect(pendingRows[0]?.token_hash).not.toBe(firstPendingToken)
	expect(consoleWarn).toHaveBeenCalledWith('email-change-send-skipped', 1)
})

test('unverified accounts cannot start an email change', async () => {
	await using store = await createTestDb()
	const ownerId = await seedUser(store, {
		id: 1,
		email: 'unverified@example.com',
		username: 'unverified-user',
		password: 'correct-password',
		verified: false,
	})
	const handler = createAccountEmailChangeHandler(
		createAppEnv(store.forUser(ownerId).db),
	)

	const response = await runHandler(
		handler,
		await createRequest({
			session: {
				stableUserId: testStableUserIdFromEmail('unverified@example.com'),
				email: 'unverified@example.com',
				rememberMe: false,
			},
			email: 'new@example.com',
			password: 'correct-password',
		}),
	)
	expect(response.status).toBe(403)
	expect(await response.json()).toEqual({
		ok: false,
		error: 'Verify your current email address before changing it.',
	})
	expect(
		await query(
			store,
			`SELECT COUNT(*)::int AS count FROM pending_email_changes`,
		),
	).toEqual([{ count: 0 }])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'email_change_request',
			result: 'failure',
			reason: 'email_unverified',
		}),
	)
	expect(auditEventSummaries()).toEqual(['email_change_request:failure'])
})

test('email change requests reject addresses another account signs in with or still claims', async () => {
	consoleWarn.mockImplementation(() => {})
	await using store = await createTestDb()
	const ownerId = await seedUser(store, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
	})
	await seedUser(store, {
		id: 2,
		email: 'taken@example.com',
		username: 'taken-user',
		password: 'taken-password',
	})
	await store.pg.exec(`
		INSERT INTO user_email_claims (user_id, email, status)
		VALUES (2, 'former@example.com', 'claimed'),
		       (2, 'released@example.com', 'released')
	`)
	// The owner's writer cannot see account 2; the directory definer answers.
	const handler = createAccountEmailChangeHandler(
		createAppEnv(store.forUser(ownerId).db),
	)
	const session = {
		stableUserId: testStableUserIdFromEmail('old@example.com'),
		email: 'old@example.com',
		rememberMe: false,
	}

	for (const email of ['taken@example.com', 'Former@Example.com']) {
		const response = await runHandler(
			handler,
			await createRequest({ session, email, password: 'correct-password' }),
		)
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({
			ok: false,
			error: 'Email already registered.',
		})
	}
	await expect(
		store
			.forUser(ownerId)
			.reader.prepare(`SELECT kody_email_reserved_for_other(?, ?) AS reserved`)
			.bind('taken@example.com', 1)
			.first(),
	).rejects.toThrow(/permission denied/)
	const released = await runHandler(
		handler,
		await createRequest({
			session,
			email: 'released@example.com',
			password: 'correct-password',
		}),
	)
	expect(released.status).toBe(200)
	expect(
		await query(store, `SELECT new_email FROM pending_email_changes`),
	).toEqual([{ new_email: 'released@example.com' }])
})

test('signed-out email change link resolves its owner, updates email, and preserves stable user id', async () => {
	await using store = await createTestDb()
	const oldStableUserId = await seedUser(store, {
		id: 1,
		email: 'old@example.com',
		username: 'old-user',
		password: 'correct-password',
		verified: false,
	})
	await seedUser(store, {
		id: 2,
		email: 'other@example.com',
		username: 'other-user',
		password: 'other-password',
	})
	const token = 'verify-email-change-token'
	const conflictToken = 'conflicting-email-change-token'
	const now = new Date('2026-07-06T00:00:00.000Z')
	const expiresAt = now.getTime() + 60_000
	await store.pg.query(
		`INSERT INTO email_verifications (user_id, token_hash, expires_at)
		 VALUES (1, 'old-account-token', $1), (2, 'other-account-token', $1)`,
		[expiresAt],
	)
	await store.pg.query(
		`INSERT INTO pending_email_changes (user_id, new_email, token_hash, expires_at)
		 VALUES (1, 'new@example.com', $1, $3), (2, 'old@example.com', $2, $3)`,
		[
			await hashVerificationToken(token),
			await hashVerificationToken(conflictToken),
			expiresAt,
		],
	)
	// Pre-auth writer: no account context, so RLS shows it no pending changes.
	const signedOut = {
		db: store.forUser().db,
		forUser: (userId: string) => store.forUser(userId).db,
	}

	expect(
		await verifyEmailChangeToken({ ...signedOut, token: 'unknown', now }),
	).toEqual({ ok: false, reason: 'invalid_token' })
	await expect(
		verifyEmailChangeToken({ db: store.forUser().db, token, now }),
	).rejects.toThrow("email_change needs the token owner's writer")

	const result = await verifyEmailChangeToken({ ...signedOut, token, now })
	expect(result).toEqual({
		ok: true,
		userId: 1,
		stableUserId: oldStableUserId,
		oldEmail: 'old@example.com',
		newEmail: 'new@example.com',
	})
	expect(
		await query(
			store,
			`SELECT email, stable_user_id, email_verified_at FROM users WHERE id = 1`,
		),
	).toEqual([
		{
			email: 'new@example.com',
			stable_user_id: oldStableUserId,
			email_verified_at: '2026-07-06T00:00:00.000Z',
		},
	])
	expect(
		await query(
			store,
			`SELECT user_id::int AS user_id FROM pending_email_changes`,
		),
	).toEqual([{ user_id: 2 }])
	expect(
		await query(
			store,
			`SELECT user_id::int AS user_id FROM email_verifications`,
		),
	).toEqual([{ user_id: 2 }])
	expect(
		await query(
			store,
			`SELECT email, status FROM user_email_claims WHERE user_id = 1 ORDER BY email`,
		),
	).toEqual([
		{ email: 'new@example.com', status: 'claimed' },
		{ email: 'old@example.com', status: 'claimed' },
	])

	// Account 2 asked for the address account 1 still claims as a former email.
	expect(
		await verifyEmailChangeToken({ ...signedOut, token: conflictToken, now }),
	).toEqual({ ok: false, reason: 'email_conflict' })
	expect(await query(store, `SELECT email FROM users WHERE id = 2`)).toEqual([
		{ email: 'other@example.com' },
	])
})
