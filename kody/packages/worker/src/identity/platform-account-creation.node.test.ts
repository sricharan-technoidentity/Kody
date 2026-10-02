import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPlatformAccount } from './platform-account-creation.ts'

test('platform creation requires a reserved username, preserves identity claims and rolls back failed claims', async () => {
	await using store = await createTestDb()
	const db = createPgDatabase({ connection: store.pg, role: 'kody_admin' })
	const forUser = (id: string) => store.forUser(id).db
	await expect(
		createPlatformAccount({
			db,
			forUser,
			email: 'platform@example.com',
			username: 'ordinary',
		}),
	).rejects.toMatchObject({ code: 'invalid_username' })
	const created = await createPlatformAccount({
		db,
		forUser,
		email: 'Platform@Example.com',
		username: 'kody',
	})
	expect(
		await store
			.forUser(created.stableUserId)
			.reader.prepare(
				'SELECT email, username, account_type, password_hash, plan FROM users',
			)
			.first(),
	).toEqual({
		email: 'platform@example.com',
		username: 'kody',
		account_type: 'platform',
		password_hash: 'platform_account_no_usable_password',
		plan: 'free',
	})
	expect(
		await store
			.forUser(created.stableUserId)
			.reader.prepare('SELECT email, status FROM user_email_claims')
			.first(),
	).toEqual({ email: created.email, status: 'claimed' })
	await expect(
		createPlatformAccount({
			db,
			forUser,
			email: created.email,
			username: 'support',
		}),
	).rejects.toMatchObject({ code: 'email_exists' })
	await expect(
		createPlatformAccount({
			db,
			forUser,
			email: 'other@example.com',
			username: 'kody',
		}),
	).rejects.toMatchObject({ code: 'username_exists' })
	await expect(
		createPlatformAccount({
			db,
			email: 'rollback@example.com',
			username: 'support',
			forUser: (id) =>
				new Proxy(forUser(id), {
					get(target, property, receiver) {
						if (property === 'prepare')
							return (sql: string) => {
								if (sql.includes('INSERT INTO user_email_claims'))
									throw new Error('forced claim failure')
								return target.prepare(sql)
							}
						return Reflect.get(target, property, receiver)
					},
				}),
		}),
	).rejects.toMatchObject({ code: 'create_failed' })
	expect(
		await db.prepare('SELECT COUNT(*) AS count FROM users').first(),
	).toEqual({ count: 1 })
	expect(
		await db.prepare('SELECT COUNT(*) AS count FROM user_email_claims').first(),
	).toEqual({ count: 1 })
})
