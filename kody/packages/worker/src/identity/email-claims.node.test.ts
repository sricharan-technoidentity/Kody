import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
	isEmailReservedForOtherAccount,
	listFormerEmailClaims,
	releaseAccountEmailClaim,
	resolveReleasableEmailClaim,
} from './email-claims.ts'

async function insertUser(
	pg: Awaited<ReturnType<typeof createTestDb>>['pg'],
	input: { id: number; email: string; username: string; stableUserId?: string },
) {
	const stableUserId =
		input.stableUserId ?? (await createStableUserIdFromEmail(input.email))
	await pg.query(
		`INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES ($1, $2, $3, $4, 'hash')`,
		[input.id, input.username, input.email, stableUserId],
	)
	return stableUserId
}

test('email claims reserve former addresses without reminting identity', async () => {
	await using store = await createTestDb()
	const { pg } = store
	const db = createPgDatabase({ connection: pg, role: 'kody_admin' })
	const originalStableUserId = await insertUser(pg, {
		id: 1,
		email: 'first@example.com',
		username: 'jamie',
	})
	await claimAccountEmail(store.forUser(originalStableUserId).db, {
		userId: 1,
		email: 'first@example.com',
	})

	await store
		.forUser(originalStableUserId)
		.db.prepare("UPDATE users SET email = 'work@example.com' WHERE id = 1")
		.run()
	await claimAccountEmail(store.forUser(originalStableUserId).db, {
		userId: 1,
		email: 'work@example.com',
	})

	expect(
		await listFormerEmailClaims(store.forUser(originalStableUserId).reader, {
			userId: 1,
			currentEmail: 'work@example.com',
		}),
	).toEqual([
		{
			email: 'first@example.com',
			claimedAt: expect.any(String),
		},
	])
	expect(await isEmailReservedForOtherAccount(db, 'first@example.com')).toBe(
		true,
	)
	expect(await allocateSignupIdentity(db, 'first@example.com')).toEqual({
		ok: false,
		reason: 'former_email_claimed',
	})

	const implicit = await resolveReleasableEmailClaim({
		db,
		userId: 1,
		stableUserId: originalStableUserId,
		currentEmail: 'work@example.com',
		email: 'first@example.com',
	})
	expect(implicit).toEqual({ ok: true, email: 'first@example.com' })

	await releaseAccountEmailClaim(store.forUser(originalStableUserId).db, {
		userId: 1,
		email: 'first@example.com',
	})
	expect(
		await listFormerEmailClaims(store.forUser(originalStableUserId).reader, {
			userId: 1,
			currentEmail: 'work@example.com',
		}),
	).toEqual([])
	expect(await isEmailReservedForOtherAccount(db, 'first@example.com')).toBe(
		false,
	)

	const allocated = await allocateSignupIdentity(db, 'first@example.com')
	expect(allocated.ok).toBe(true)
	if (!allocated.ok) throw new Error('expected allocation')
	expect(allocated.stableUserId).not.toBe(originalStableUserId)
	expect(allocated.stableUserId).toMatch(/^[a-f0-9]{64}$/)

	expect(
		await store
			.forUser(originalStableUserId)
			.reader.prepare('SELECT stable_user_id FROM users WHERE id = 1')
			.first(),
	).toEqual({ stable_user_id: originalStableUserId })

	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 1,
			stableUserId: originalStableUserId,
			currentEmail: 'work@example.com',
			email: 'work@example.com',
		}),
	).toEqual({ ok: false, reason: 'current_email' })
	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 1,
			stableUserId: originalStableUserId,
			currentEmail: 'work@example.com',
			email: 'stranger@example.com',
		}),
	).toEqual({ ok: false, reason: 'not_claimed' })
})

test('implicit sha256 reservation is releasable before a claim row exists', async () => {
	await using store = await createTestDb()
	const { pg } = store
	const db = createPgDatabase({ connection: pg, role: 'kody_admin' })
	const originalEmail = 'legacy@example.com'
	const stableUserId = await insertUser(pg, {
		id: 2,
		email: 'now@example.com',
		username: 'legacy',
		stableUserId: await createStableUserIdFromEmail(originalEmail),
	})

	expect(await isEmailReservedForOtherAccount(db, originalEmail)).toBe(true)
	expect(await allocateSignupIdentity(db, originalEmail)).toEqual({
		ok: false,
		reason: 'former_email_claimed',
	})
	expect(
		await resolveReleasableEmailClaim({
			db,
			userId: 2,
			stableUserId,
			currentEmail: 'now@example.com',
			email: originalEmail,
		}),
	).toEqual({ ok: true, email: originalEmail })
})
