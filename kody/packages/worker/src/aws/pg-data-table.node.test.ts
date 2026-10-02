import { expect, test } from 'vitest'
import { ilike } from 'remix/data-table/operators'
import { createDb, usersTable } from '#worker/db.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

test('Remix account queries use PostgreSQL returning, filters and owner isolation', async () => {
	await using fixture = await createTestDb({ userId: 'alice' })
	const db = createDb(fixture.db)
	expect(await db.hasTable({ name: 'users' })).toBe(true)
	expect(await db.hasColumn({ name: 'users' }, 'password_hash')).toBe(true)
	const alice = await db.create(
		usersTable,
		{
			username: 'Alice',
			email: 'alice@example.com',
			stable_user_id: 'alice',
			password_hash: 'hash',
		},
		{ returnRow: true },
	)
	expect(alice.id).toBeGreaterThan(0)
	expect(await db.count(usersTable)).toBe(1)
	expect(
		await db.query(usersTable).where(ilike('username', 'ali%')).first(),
	).toMatchObject({ id: alice.id })
	await fixture.pg
		.query(`INSERT INTO users (username, email, stable_user_id, password_hash)
		VALUES ('bob', 'bob@example.com', 'bob', 'hash')`)
	expect(
		await db.findOne(usersTable, { where: { email: 'bob@example.com' } }),
	).toBeNull()
	expect(
		await db.update(usersTable, alice.id, { display_name: 'Alice Example' }),
	).toMatchObject({ id: alice.id, display_name: 'Alice Example' })
	expect(await db.find(usersTable, alice.id)).toMatchObject({
		display_name: 'Alice Example',
	})
	const reader = createDb(fixture.reader)
	expect(await reader.find(usersTable, alice.id)).toMatchObject({
		username: 'Alice',
	})
	await expect(
		reader.update(usersTable, alice.id, { display_name: 'changed' }),
	).rejects.toMatchObject({ cause: expect.objectContaining({ code: '25006' }) })
	await expect(
		db.create(usersTable, {
			username: 'intruder',
			email: 'intruder@example.com',
			stable_user_id: 'bob',
			password_hash: 'hash',
		}),
	).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) })
	await expect(db.exec('SET ROLE kody_admin')).rejects.toThrow(
		'Database execution failed',
	)
	await expect(db.transaction((tx) => tx.count(usersTable))).rejects.toThrow(
		'session and schema control is not allowed',
	)
	expect(await db.count(usersTable)).toBe(1)
	await db.delete(usersTable, alice.id)
	expect(await db.count(usersTable)).toBe(0)
})

test('Remix queries share the scoped facade transaction and roll back as one unit', async () => {
	await using fixture = await createTestDb({ userId: 'alice' })
	await expect(
		fixture.db.transaction(async (tx) => {
			const db = createDb(tx)
			await db.create(
				usersTable,
				{
					username: 'alice',
					email: 'alice@example.com',
					stable_user_id: 'alice',
					password_hash: 'hash',
				},
				{ returnRow: true },
			)
			expect(await db.count(usersTable)).toBe(1)
			throw new Error('cancel account setup')
		}),
	).rejects.toThrow('cancel account setup')
	expect(
		await fixture.db.prepare('SELECT count(*) AS count FROM users').first(),
	).toEqual({ count: 0 })
})
