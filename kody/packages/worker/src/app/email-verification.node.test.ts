import { expect, test } from 'vitest'
import { type SqlDatabase } from '#worker/aws/pg-database.ts'
import {
	buildEmailVerificationUrl,
	hashVerificationToken,
	isAccountEmailVerified,
	verifyEmailToken,
} from '#app/email-verification.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

test('email verification links preserve safe resume targets and reject open redirects', () => {
	const oauthResume = '/oauth/authorize?client_id=demo&state=abc'
	const withResume = buildEmailVerificationUrl({
		appBaseUrl: 'https://kody.example',
		token: 'verify-token',
		redirectTo: oauthResume,
	})
	expect(withResume.pathname).toBe('/verify-email')
	expect(withResume.searchParams.get('token')).toBe('verify-token')
	expect(withResume.searchParams.get('redirectTo')).toBe(oauthResume)

	const withoutResume = buildEmailVerificationUrl({
		appBaseUrl: 'https://kody.example',
		token: 'verify-token',
		redirectTo: 'https://evil.example',
	})
	expect(withoutResume.searchParams.get('token')).toBe('verify-token')
	expect(withoutResume.searchParams.has('redirectTo')).toBe(false)
})

async function createVerificationTestDb() {
	const store = await createTestDb()
	const owner = {
		email: 'owner@example.com',
		stableUserId: await createStableUserIdFromEmail('owner@example.com'),
	}
	const other = {
		email: 'reused@example.com',
		stableUserId: await createStableUserIdFromEmail('other@example.com'),
	}
	await store.pg.query(
		`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at)
		 VALUES (1, 'owner', $1, 'hash', $2, '2026-01-01T00:00:00.000Z'),
		        (2, 'other', $3, 'hash', $4, '2026-01-02T00:00:00.000Z')`,
		[owner.email, owner.stableUserId, other.email, other.stableUserId],
	)
	return {
		store,
		owner,
		other,
		forUser: (stableUserId: string) => store.forUser(stableUserId).db,
		async addToken(token: string, userId = 1, expiresAt = Date.now() + 60_000) {
			await store.pg.query(
				`INSERT INTO email_verifications (user_id, token_hash, expires_at)
				 VALUES ($1, $2, $3)`,
				[userId, await hashVerificationToken(token), expiresAt],
			)
		},
		async user(id: number) {
			return (
				await store.pg.query<{
					email_verified_at: string | null
					deleting_at: string | null
				}>(`SELECT email_verified_at, deleting_at FROM users WHERE id = $1`, [
					id,
				])
			).rows[0]
		},
		async tokenCount() {
			return (
				await store.pg.query<{ count: number }>(
					`SELECT COUNT(*)::int AS count FROM email_verifications`,
				)
			).rows[0]!.count
		},
	}
}

test('isAccountEmailVerified binds email+stable id together and keeps single-key lookup paths', async () => {
	const { store, owner, other } = await createVerificationTestDb()
	await using _store = store
	const { reader } = store.forUser(owner.stableUserId)

	expect(await isAccountEmailVerified({ db: reader, ...owner })).toBe(true)
	// Stale grant email now owned by another verified account must not pass
	// for the original stable id.
	expect(
		await isAccountEmailVerified({
			db: reader,
			email: other.email,
			stableUserId: owner.stableUserId,
		}),
	).toBe(false)
	expect(await isAccountEmailVerified({ db: reader, email: owner.email })).toBe(
		true,
	)
	expect(
		await isAccountEmailVerified({
			db: reader,
			stableUserId: owner.stableUserId,
		}),
	).toBe(true)
	expect(
		await isAccountEmailVerified({ db: reader, email: 'missing@example.com' }),
	).toBe(false)
	expect(
		await isAccountEmailVerified({
			db: reader,
			stableUserId: 'missing-stable-id',
		}),
	).toBe(false)
	// Another account's verification is outside this reader's RLS scope.
	expect(await isAccountEmailVerified({ db: reader, email: other.email })).toBe(
		false,
	)
})

test('verifyEmailToken resolves the link owner before sign-in and works only through their writer', async () => {
	const { store, other, forUser, addToken, user, tokenCount } =
		await createVerificationTestDb()
	await using _store = store
	await store.pg.query(`UPDATE users SET email_verified_at = NULL WHERE id = 2`)
	await addToken('other-verify-token', 2)
	await addToken('other-older-token', 2)
	await addToken('owner-expired-token', 1, Date.now() - 1)
	const preAuth = store.forUser().db

	await expect(
		verifyEmailToken({ db: preAuth, forUser, token: 'unknown-token' }),
	).resolves.toEqual({ ok: false, reason: 'invalid_token' })
	await expect(
		verifyEmailToken({ db: preAuth, forUser, token: 'owner-expired-token' }),
	).resolves.toEqual({ ok: false, reason: 'expired_token' })
	expect(await tokenCount()).toBe(2)
	// The pre-auth writer cannot see token rows or accounts itself.
	await expect(
		verifyEmailToken({ db: preAuth, token: 'other-verify-token' }),
	).rejects.toThrow(/owner/)
	expect(
		(await preAuth.prepare(`SELECT id FROM email_verifications`).all()).results,
	).toEqual([])

	await expect(
		verifyEmailToken({ db: preAuth, forUser, token: 'other-verify-token' }),
	).resolves.toMatchObject({
		ok: true,
		userId: 2,
		email: other.email,
		stableUserId: other.stableUserId,
		newlyVerified: true,
	})
	expect((await user(2))?.email_verified_at).toEqual(expect.any(String))
	expect(await tokenCount()).toBe(0)
})

test('verifyEmailToken treats a fenced account as an invalid token and does not mark it verified', async () => {
	const { store, forUser, addToken, user } = await createVerificationTestDb()
	await using _store = store
	await store.pg.query(
		`UPDATE users SET email_verified_at = NULL, deleting_at = '2026-09-02 12:00:00' WHERE id = 1`,
	)
	await addToken('fenced-verify-token')

	await expect(
		verifyEmailToken({
			db: store.forUser().db,
			forUser,
			token: 'fenced-verify-token',
		}),
	).resolves.toEqual({ ok: false, reason: 'invalid_token' })
	expect((await user(1))?.email_verified_at).toBeNull()
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

test('verifyEmailToken does not mark verified when a purge claim lands between the writable check and the stamp', async () => {
	const { store, forUser, addToken, user, tokenCount } =
		await createVerificationTestDb()
	await using _store = store
	await store.pg.query(`UPDATE users SET email_verified_at = NULL WHERE id = 1`)
	await addToken('race-verify-token')

	await expect(
		verifyEmailToken({
			db: store.forUser().db,
			forUser: (stableUserId) =>
				withDeletingAtAfterWritableCheck(
					forUser(stableUserId),
					'2026-09-02 12:00:00',
				),
			token: 'race-verify-token',
		}),
	).resolves.toEqual({ ok: false, reason: 'invalid_token' })
	expect(await user(1)).toEqual({
		email_verified_at: null,
		deleting_at: '2026-09-02 12:00:00',
	})
	expect(await tokenCount()).toBe(1)
})
