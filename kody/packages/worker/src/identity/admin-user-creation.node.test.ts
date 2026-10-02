import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { adminCreateUserWithPasswordSetup } from './admin-user-creation.ts'
import { hashPasswordResetToken } from './password-reset-tokens.ts'
import { getUserRolesAndPermissions } from './permissions-db.ts'
import { getUsernameValidationError } from './username.ts'

test('admin creation persists a verified account, default role and private seven-day setup token', async () => {
	await using store = await createTestDb()
	const db = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	const forUser = (id: string) => store.forUser(id).db
	const now = new Date('2026-07-05T16:00:00.000Z')
	const created = await adminCreateUserWithPasswordSetup({
		db,
		forUser,
		email: 'Person+Launch@Example.com',
		username: null,
		setupLinkOrigin: 'https://kody.example/admin/users',
		now,
	})
	expect(created.email).toBe('person+launch@example.com')
	expect(created.username).toBe('person-launch')
	const link = new URL(created.setupLink)
	expect(link.origin + link.pathname).toBe(
		'https://kody.example/reset-password',
	)
	const token = link.searchParams.get('token')!
	expect(token).toMatch(/^[0-9a-f]{64}$/)
	expect(created.setupTokenExpiresAt).toBe(
		now.getTime() + 7 * 24 * 60 * 60 * 1000,
	)
	const own = store.forUser(created.stableUserId)
	expect(
		await own.reader
			.prepare(
				'SELECT username, email, email_verified_at, password_hash, plan FROM users',
			)
			.first(),
	).toEqual({
		username: 'person-launch',
		email: 'person+launch@example.com',
		email_verified_at: now.toISOString(),
		password_hash: 'admin_created_no_usable_password',
		plan: 'free',
	})
	expect(
		await getUserRolesAndPermissions(own.reader, created.userId),
	).toMatchObject({ roles: ['user'] })
	expect(
		await own.reader
			.prepare('SELECT token_hash, expires_at FROM password_resets')
			.first(),
	).toEqual({
		token_hash: await hashPasswordResetToken(token),
		expires_at: created.setupTokenExpiresAt,
	})
	expect(
		await own.reader
			.prepare('SELECT email, status FROM user_email_claims')
			.first(),
	).toEqual({ email: created.email, status: 'claimed' })
	await expect(
		db.prepare('SELECT * FROM password_resets').all(),
	).rejects.toThrow('permission denied')
	expect(
		await store
			.forUser('stranger')
			.reader.prepare('SELECT * FROM password_resets')
			.first(),
	).toBeNull()

	for (const [email, username, code] of [
		[created.email, 'different', 'email_exists'],
		['different@example.com', created.username, 'username_exists'],
		['person@example.com', 'postmaster', 'invalid_username'],
	] as const) {
		await expect(
			adminCreateUserWithPasswordSetup({
				db,
				forUser,
				email,
				username,
				setupLinkOrigin: link.origin,
			}),
		).rejects.toMatchObject({ code })
	}
	const generated = await adminCreateUserWithPasswordSetup({
		db,
		forUser,
		email: 'support@example.com',
		setupLinkOrigin: link.origin,
	})
	expect(generated.username.includes('support')).toBe(false)
	expect(getUsernameValidationError(generated.username)).toBeNull()
	const collision = await adminCreateUserWithPasswordSetup({
		db,
		forUser,
		email: 'person+launch@another.com',
		setupLinkOrigin: link.origin,
	})
	expect(collision.username).toBe('person-launch-2')
})

test('admin creation removes partial accounts when default role, email claim or setup token fails', async () => {
	await using store = await createTestDb()
	const db = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	for (const [sqlFragment, code] of [
		['INSERT INTO user_roles', 'default_role_assignment_failed'],
		['INSERT INTO user_email_claims', 'create_failed'],
		['INSERT INTO password_resets', 'setup_token_failed'],
	] as const) {
		const fail = (target: typeof db) =>
			new Proxy(target, {
				get(target, property, receiver) {
					if (property === 'prepare')
						return (sql: string) => {
							if (sql.includes(sqlFragment))
								throw new Error('forced persistence failure')
							return target.prepare(sql)
						}
					return Reflect.get(target, property, receiver)
				},
			})
		await expect(
			adminCreateUserWithPasswordSetup({
				db: fail(db),
				forUser: (id) => fail(store.forUser(id).db),
				email: 'rollback@example.com',
				username: 'rollback',
				setupLinkOrigin: 'https://kody.example',
			}),
		).rejects.toMatchObject({ code })
		expect(
			await db.prepare('SELECT COUNT(*) AS count FROM users').first(),
		).toEqual({ count: 0 })
		expect(
			(await store.pg.query('SELECT COUNT(*)::int AS count FROM user_roles'))
				.rows,
		).toEqual([{ count: 0 }])
		expect(
			(
				await store.pg.query(
					'SELECT COUNT(*)::int AS count FROM user_email_claims',
				)
			).rows,
		).toEqual([{ count: 0 }])
		expect(
			(
				await store.pg.query(
					'SELECT COUNT(*)::int AS count FROM password_resets',
				)
			).rows,
		).toEqual([{ count: 0 }])
	}
})
