import { expect, test } from 'vitest'
import { createPgDatabase, type SqlDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { hashVerificationToken } from './email-verification-tokens.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from './email-verification-admin.ts'

const email = 'member@example.com'
const stableUserId = testStableUserIdFromEmail(email)

/** Operator role for `users`; the member's own writer for token rows. */
async function createAdminVerifyTestDb() {
	const store = await createTestDb()
	await store.pg.query(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id)
		 VALUES (1, 'member', $1, 'hash', $2)`,
		[email, stableUserId],
	)
	await store.pg.query(
		`INSERT INTO user_roles (user_id, role_id)
		 SELECT 1, id FROM roles WHERE name = 'user'`,
	)
	return {
		store,
		admin: createPgDatabase({ connection: store.pg, role: 'kody_admin' }),
		forUser: (userId: string) => store.forUser(userId).db,
		async tokenHashes() {
			return (
				await store.pg.query<{ token_hash: string }>(
					`SELECT token_hash FROM email_verifications`,
				)
			).rows.map((row) => row.token_hash)
		},
	}
}

test('admin mark verified and mint verify url cover the operator unblock path', async () => {
	const { store, admin, forUser, tokenHashes } = await createAdminVerifyTestDb()
	await using _store = store
	const now = new Date('2026-08-28T00:00:00.000Z')
	await store.pg.query(
		`INSERT INTO email_verifications (user_id, token_hash, expires_at)
		 VALUES (1, 'stale-token', 1)`,
	)

	const minted = await mintAdminEmailVerificationUrl({
		db: admin,
		forUser,
		appBaseUrl: 'https://kody.codes',
		target: { email: 'MEMBER@example.com' },
		now,
	})
	expect(minted.user).toMatchObject({ email_verified: false, roles: ['user'] })
	expect(minted.verifyUrl).toMatch(
		/^https:\/\/kody.codes\/verify-email\?token=/,
	)
	expect(minted.expiresAt).toBeGreaterThan(now.getTime())
	const token = new URL(minted.verifyUrl).searchParams.get('token')
	expect(await tokenHashes()).toEqual([await hashVerificationToken(token!)])

	await store.pg.query(
		`UPDATE users SET email_verification_delivery_status = 'bounced',
		 email_verification_delivery_at = '2026-08-27T00:00:00.000Z' WHERE id = 1`,
	)
	const verified = await markAdminUserEmailVerified(admin, {
		stableUserId,
		forUser,
		now,
	})
	expect(verified.email_verified).toBe(true)
	expect(verified.email_verified_at).toBe(now.toISOString())
	expect(verified.email_verification_delivery).toBeNull()
	expect(await tokenHashes()).toEqual([])

	await expect(
		mintAdminEmailVerificationUrl({
			db: admin,
			forUser,
			appBaseUrl: 'https://kody.codes',
			target: { username: 'MEMBER' },
		}),
	).rejects.toBeInstanceOf(AdminEmailVerificationError)

	const again = await markAdminUserEmailVerified(admin, { email, forUser })
	expect(again.email_verified_at).toBe(now.toISOString())

	await expect(
		markAdminUserEmailVerified(admin, {
			email: 'missing@example.com',
			forUser,
		}),
	).rejects.toMatchObject({ code: 'not_found' })
})

test('admin verification never reaches token rows outside the target account', async () => {
	const { store, admin, forUser, tokenHashes } = await createAdminVerifyTestDb()
	await using _store = store
	await expect(
		mintAdminEmailVerificationUrl({
			db: admin,
			forUser: () => forUser('someone-else'),
			appBaseUrl: 'https://kody.codes',
			target: { stableUserId },
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(await tokenHashes()).toEqual([])
	await expect(
		admin.prepare(`SELECT token_hash FROM email_verifications`).all(),
	).rejects.toThrow(/permission denied/)
})

test('admin mark verified and mint verify url refuse a fenced account', async () => {
	const { store, admin, forUser, tokenHashes } = await createAdminVerifyTestDb()
	await using _store = store
	await store.pg.query(
		`UPDATE users SET deleting_at = '2026-09-02 12:00:00' WHERE id = 1`,
	)

	await expect(
		markAdminUserEmailVerified(admin, { email, forUser }),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	await expect(
		mintAdminEmailVerificationUrl({
			db: admin,
			forUser,
			appBaseUrl: 'https://kody.codes',
			target: { email },
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		(await store.pg.query(`SELECT email_verified_at FROM users WHERE id = 1`))
			.rows,
	).toEqual([{ email_verified_at: null }])
	expect(await tokenHashes()).toEqual([])
})

function withDeletingAtAfterWritableCheck(
	db: SqlDatabase,
	deletingAt: string,
): SqlDatabase {
	const originalPrepare = db.prepare.bind(db)
	return {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			const normalized = query.replace(/\s+/g, ' ').toLowerCase()
			if (
				!normalized.includes('select deleting_at from users') ||
				!normalized.includes('stable_user_id')
			) {
				return statement
			}
			return {
				...statement,
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async first<T>() {
							const row = await bound.first<T>()
							await originalPrepare(
								`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
							)
								.bind(deletingAt, params[0])
								.run()
							return row
						},
					}
				},
			}
		},
	}
}

test('admin mark verified and mint verify url refuse a purge claim that lands after the writable check', async () => {
	const { store, admin, forUser, tokenHashes } = await createAdminVerifyTestDb()
	await using _store = store
	const db = withDeletingAtAfterWritableCheck(admin, '2026-09-02 12:00:00')

	await expect(
		markAdminUserEmailVerified(db, { email, forUser }),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(
		(
			await store.pg.query(
				`SELECT email_verified_at, deleting_at FROM users WHERE id = 1`,
			)
		).rows,
	).toEqual([{ email_verified_at: null, deleting_at: '2026-09-02 12:00:00' }])

	await store.pg.query(`UPDATE users SET deleting_at = NULL WHERE id = 1`)
	await expect(
		mintAdminEmailVerificationUrl({
			db,
			forUser,
			appBaseUrl: 'https://kody.codes',
			target: { email },
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(await tokenHashes()).toEqual([])
})
