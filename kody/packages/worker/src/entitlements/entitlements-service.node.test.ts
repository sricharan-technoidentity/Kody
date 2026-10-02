import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { findUserAccountByStableUserId } from './service.ts'

test('findUserAccountByStableUserId resolves the caller through its own reader and recovers from deletions', async () => {
	const email = 'reverse-lookup@example.com'
	const userId = testStableUserIdFromEmail(email)
	await using database = await createTestDb()
	await database.pg.query(
		`INSERT INTO users (stable_user_id, username, email, password_hash, plan, email_verified_at)
		 VALUES ($1, 'reverse-lookup', $2, 'x', 'pro', '2026-01-01T00:00:00.000Z')`,
		[userId, email],
	)
	const reader = database.forUser(userId).reader as unknown as D1Database

	expect(await findUserAccountByStableUserId(reader, userId)).toEqual({
		email,
		plan: 'pro',
		emailVerified: true,
	})
	// RLS: another account's reader cannot resolve this one.
	expect(
		await findUserAccountByStableUserId(
			database.forUser('someone-else').reader as unknown as D1Database,
			userId,
		),
	).toBeNull()
	// The plan CHECK now rejects unregistered plans at write time.
	await expect(
		database.pg.query(
			`UPDATE users SET plan = 'enterprise-2099' WHERE email = $1`,
			[email],
		),
	).rejects.toThrow(/check constraint/i)
	await database.pg.query(
		`UPDATE users SET email_verified_at = NULL WHERE email = $1`,
		[email],
	)
	expect(await findUserAccountByStableUserId(reader, userId)).toMatchObject({
		emailVerified: false,
	})
	await database.pg.query(`DELETE FROM users WHERE email = $1`, [email])
	expect(await findUserAccountByStableUserId(reader, userId)).toBeNull()
	expect(
		await findUserAccountByStableUserId(reader, `unknown-${userId}`),
	).toBeNull()
	expect(await findUserAccountByStableUserId(reader, '  ')).toBeNull()
})
