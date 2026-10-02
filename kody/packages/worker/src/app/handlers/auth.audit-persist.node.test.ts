import { createTestAuditDb } from '#worker/test-support/aws/test-audit-db.ts'
import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import { expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

vi.unmock('#worker/audit-log.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

/** Signed-out requests: a writer with no account context plus each owner's writer. */
function createHandler(
	app: Awaited<ReturnType<typeof createTestDb>>,
	auditDb: Pick<SqlDatabase, 'prepare'>,
) {
	return createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: app.forUser().db,
		APP_DB_FOR_USER: (stableUserId: string) => app.forUser(stableUserId).db,
		AUDIT_DB: auditDb,
		SENTRY_ENVIRONMENT: 'production',
	} as unknown as Parameters<typeof createAuthHandler>[0])
}

async function postAuth(
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

async function readAuditActions(db: Pick<SqlDatabase, 'prepare'>) {
	return (
		await db
			.prepare('SELECT action, result FROM audit_events ORDER BY id')
			.all()
	).results
}

test('auth handler persists signup failure and login success to AUDIT_DB', async () => {
	setAuthSessionSecret(testCookieSecret)
	const email = 'session-user@example.com'
	const stableUserId = await createStableUserIdFromEmail(email)
	await using app = await createTestDb({ userId: stableUserId })
	await using audit = await createTestAuditDb()
	const handler = createHandler(app, audit.db)
	await app.db
		.prepare(`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (1, 'session-user', ?, ?, ?, ?)`)
		.bind(
			email,
			stableUserId,
			await createPasswordHash('secret123'),
			new Date().toISOString(),
		)
		.run()

	const signupFailure = await postAuth(handler, {
		email: 'weak@example.com',
		username: 'weak-jane',
		password: 'short',
		mode: 'signup',
	})
	expect(signupFailure.status).toBe(400)
	expect(await signupFailure.json()).toEqual({
		error: 'Password must be at least 8 characters.',
	})
	await vi.waitFor(async () => {
		expect(await readAuditActions(audit.reader)).toEqual([
			{ action: 'signup', result: 'failure' },
		])
	})

	const loginSuccess = await postAuth(handler, {
		email: 'session-user@example.com',
		password: 'secret123',
		mode: 'login',
	})
	expect(loginSuccess.status).toBe(200)
	expect(await loginSuccess.json()).toEqual({ ok: true, mode: 'login' })
	await vi.waitFor(async () => {
		expect(await readAuditActions(audit.reader)).toEqual([
			{ action: 'signup', result: 'failure' },
			{ action: 'login', result: 'success' },
		])
	})
})
