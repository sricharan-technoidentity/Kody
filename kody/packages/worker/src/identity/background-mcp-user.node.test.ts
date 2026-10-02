import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { emailVerificationRequiredMessage } from './email-verification-state.ts'
import {
	AccountSuspendedError,
	accountSuspendedMessage,
} from '#worker/account/account-suspension.ts'
import { resolveBackgroundMcpUser } from './background-mcp-user.ts'

test('resolveBackgroundMcpUser loads admin roles only for assigned accounts', async () => {
	await using database = await createTestDb()
	const { pg, forUser } = database

	const adminEmail = `bg-admin-${crypto.randomUUID()}@example.com`
	const adminStableUserId = await createStableUserIdFromEmail(adminEmail)
	await pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES (1, 'admin', $1, $2, 'x', '2026-09-30T00:00:00.000Z')`,
		[adminEmail, adminStableUserId],
	)
	await pg.query(
		`INSERT INTO user_roles (user_id, role_id) SELECT 1, id FROM roles WHERE name = 'admin'`,
	)
	const admin = await resolveBackgroundMcpUser(
		forUser(adminStableUserId).reader,
		adminStableUserId,
	)
	expect(admin).toMatchObject({
		userId: adminStableUserId,
		email: adminEmail,
		roles: expect.arrayContaining(['admin']),
	})

	const userEmail = `bg-user-${crypto.randomUUID()}@example.com`
	const userStableUserId = await createStableUserIdFromEmail(userEmail)
	await pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES (2, 'user', $1, $2, 'x', '2026-09-30T00:00:00.000Z')`,
		[userEmail, userStableUserId],
	)
	await pg.query(
		`INSERT INTO user_roles (user_id, role_id) SELECT 2, id FROM roles WHERE name = 'user'`,
	)
	const userDb = forUser(userStableUserId).reader
	const user = await resolveBackgroundMcpUser(userDb, userStableUserId)
	expect(user.userId).toBe(userStableUserId)
	expect(user.roles).toEqual(['user'])
	expect(user.permissions).toContain('read:user:own')
	expect(admin.permissions).toContain('read:user:any')
	await expect(
		resolveBackgroundMcpUser(userDb, adminStableUserId),
	).rejects.toThrow('was not found')
})

test('resolveBackgroundMcpUser rejects blocked accounts and recovers after unsuspension or verification', async () => {
	await using database = await createTestDb()
	const { pg, forUser } = database

	const email = `bg-suspended-${crypto.randomUUID()}@example.com`
	const stableUserId = await createStableUserIdFromEmail(email)
	await pg.query(
		`INSERT INTO users (username, email, stable_user_id, password_hash, email_verified_at)
		 VALUES ('suspended', $1, $2, 'x', '2026-09-30T00:00:00.000Z')`,
		[email, stableUserId],
	)
	const db = forUser(stableUserId).db
	const setSuspendedAt = async (suspendedAt: string | null) =>
		await db
			.prepare(`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`)
			.bind(suspendedAt, stableUserId)
			.run()

	await setSuspendedAt(new Date().toISOString())
	const error = await resolveBackgroundMcpUser(db, stableUserId).catch(
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(AccountSuspendedError)
	expect(error).toMatchObject({
		code: 'account_suspended',
		message: accountSuspendedMessage,
	})

	// Rejections are not cached, so lifting the suspension resumes at once.
	await setSuspendedAt(null)
	await expect(
		resolveBackgroundMcpUser(db, stableUserId),
	).resolves.toMatchObject({ userId: stableUserId, email })

	await pg.query(`INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES ('unverified', 'unverified@example.test', 'unverified', 'x')`)
	const unverifiedDb = forUser('unverified').db
	await expect(
		resolveBackgroundMcpUser(unverifiedDb, 'unverified'),
	).rejects.toThrow(emailVerificationRequiredMessage)
	await unverifiedDb
		.prepare('UPDATE users SET email_verified_at = ? WHERE stable_user_id = ?')
		.bind('2026-09-30T00:00:00.000Z', 'unverified')
		.run()
	await expect(
		resolveBackgroundMcpUser(unverifiedDb, 'unverified'),
	).resolves.toMatchObject({ userId: 'unverified' })
})
