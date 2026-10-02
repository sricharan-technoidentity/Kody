import { RequestContext } from 'remix/router'
import { expect, test, vi } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase, type SqlDatabase } from '#worker/aws/pg-database.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import {
	formerEmailClaimedSignupCode,
	formerEmailClaimedSignupMessage,
} from '#universal/email-claim-errors.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const conflictMessage = formerEmailClaimedSignupMessage

function createHandler(db: SqlDatabase) {
	return createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: db,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof createAuthHandler>[0])
}

async function signup(
	handler: ReturnType<typeof createAuthHandler>,
	body: Record<string, unknown>,
) {
	const request = new Request('http://example.com/auth', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	return handler.handler(new RequestContext(request))
}

test('signup returns 409 when sha256(email) collides with an existing stable_user_id', async () => {
	setAuthSessionSecret(testCookieSecret)
	const victimEmail = 'victim@example.com'
	const victimStableUserId = await createStableUserIdFromEmail(victimEmail)
	await using fixture = await createTestDb()
	// Identity allocation is a trusted account-administration operation.
	const db = createPgDatabase({ connection: fixture.pg, role: 'kody_admin' })
	await db
		.prepare(`INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES ('attacker', 'attacker@example.com', ?, 'oauth_created_no_usable_password')`)
		.bind(victimStableUserId)
		.run()
	const openHandler = createHandler(db)

	const openResponse = await signup(openHandler, {
		email: victimEmail,
		username: 'victim-jane',
		password: 'password123',
		mode: 'signup',
	})
	expect(openResponse.status).toBe(409)
	expect(await openResponse.json()).toEqual({
		error: conflictMessage,
		code: formerEmailClaimedSignupCode,
	})
	expect(
		await db.prepare('SELECT COUNT(*) AS count FROM users').first(),
	).toEqual({
		count: 1,
	})
	expect(lifecycleMocks.scheduleUserCreatedEvent).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'signup',
			result: 'failure',
			reason: 'former_email_claimed',
		}),
	)
	expect(auditEventSummaries()).toEqual(['signup:failure'])
})
