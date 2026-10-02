import { beforeAll, expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'
import { createAccountEmailDestinationsHandler } from './account-email-destinations.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

/** One account, served through its own scoped writer as a signed-in request would be. */
async function createOwnerDb(input: { verified?: boolean } = {}) {
	const email = 'owner@example.com'
	const stableUserId = await createStableUserIdFromEmail(email)
	const store = await createTestDb({ userId: stableUserId })
	await store.pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES (1, 'owner', $1, $2, 'test-password-hash', $3)`,
		[
			email,
			stableUserId,
			input.verified === false ? null : '2026-01-01T00:00:00.000Z',
		],
	)
	return store
}

async function pendingCount(store: Awaited<ReturnType<typeof createTestDb>>) {
	return (
		await store.pg.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM pending_email_destination_verifications`,
		)
	).rows[0]!.count
}

function createAppEnv(db: PgDatabase) {
	return {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAccountEmailDestinationsHandler>[0]
}

async function runHandler(
	handler: ReturnType<typeof createAccountEmailDestinationsHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

async function createRequest(input: {
	session: AuthSession
	method?: 'GET' | 'POST'
	body?: Record<string, string>
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/email-destinations.json', {
		method: input.method ?? 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: input.body ? JSON.stringify(input.body) : undefined,
	})
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account destination API lists identity, adds a pending extra, and blocks unverified accounts from mutating', async () => {
	consoleWarn.mockImplementation(() => {})
	await using store = await createOwnerDb()
	const handler = createAccountEmailDestinationsHandler(createAppEnv(store.db))
	const session = {
		stableUserId: testStableUserIdFromEmail('owner@example.com'),
		email: 'owner@example.com',
		rememberMe: false,
	}

	const listed = await runHandler(
		handler,
		await createRequest({ session, method: 'GET' }),
	)
	expect(listed.status).toBe(200)
	expect(await listed.json()).toMatchObject({
		ok: true,
		additionalLimit: 5,
		additionalRemaining: 5,
		destinations: [
			{
				id: identityEmailDestinationId,
				email: 'owner@example.com',
				kind: 'identity',
				verified: true,
				isDefault: true,
				canRemove: false,
			},
		],
	})

	const added = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'add', email: 'Phone@Example.com' },
		}),
	)
	expect(added.status).toBe(200)
	const addedBody = (await added.json()) as {
		destinations: Array<{ email: string; verified: boolean }>
		message: string
	}
	expect(
		addedBody.destinations.map((destination) => destination.email),
	).toEqual(['owner@example.com', 'phone@example.com'])
	expect(addedBody.destinations[1]?.verified).toBe(false)
	expect(addedBody.message).toContain('Verification email sent')
	expect(await pendingCount(store)).toBe(1)

	const resent = await runHandler(
		handler,
		await createRequest({
			session,
			body: { action: 'add', email: 'phone@example.com' },
		}),
	)
	expect(resent.status).toBe(200)
	const resentBody = (await resent.json()) as { message: string }
	expect(resentBody.message).toContain('sent again')
	expect(await pendingCount(store)).toBe(2)

	await using unverifiedStore = await createOwnerDb({ verified: false })
	const unverifiedHandler = createAccountEmailDestinationsHandler(
		createAppEnv(unverifiedStore.db),
	)
	const unverified = await runHandler(
		unverifiedHandler,
		await createRequest({
			session,
			body: { action: 'add', email: 'other@example.com' },
		}),
	)
	expect(unverified.status).toBe(403)
})
