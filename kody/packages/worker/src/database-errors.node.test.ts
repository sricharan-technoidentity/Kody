import { expect, test } from 'vitest'
import { getUniqueConstraintField } from './database-errors.ts'

test('getUniqueConstraintField reads table columns, named unique indexes, and wrapped causes', () => {
	expect(
		getUniqueConstraintField(
			new Error('UNIQUE constraint failed: users.email'),
		),
	).toBe('email')
	expect(
		getUniqueConstraintField(
			new Error('UNIQUE constraint failed: users.stable_user_id'),
		),
	).toBe('stable_user_id')
	expect(
		getUniqueConstraintField(
			new Error('UNIQUE constraint failed: idx_users_stable_user_id'),
		),
	).toBe('stable_user_id')
	expect(
		getUniqueConstraintField(
			new Error(
				'D1_ERROR: UNIQUE constraint failed: idx_users_stable_user_id: SQLITE_CONSTRAINT',
			),
		),
	).toBe('stable_user_id')

	const wrapped = new Error('D1_ERROR')
	wrapped.cause = new Error(
		'UNIQUE constraint failed: idx_users_stable_user_id',
	)
	expect(getUniqueConstraintField(wrapped)).toBe('stable_user_id')
})

test('Postgres uniqueness errors identify fields through structured diagnostics and wrapped causes', async () => {
	const { createTestDb } = await import('#worker/test-support/aws/test-db.ts')
	await using database = await createTestDb({ userId: 'alice' })
	await database.db
		.prepare(
			"INSERT INTO users (username, email, stable_user_id, password_hash) VALUES ('alice', 'alice@example.test', 'alice', 'x')",
		)
		.run()
	for (const [column, value] of [
		['email', 'alice@example.test'],
		['username', 'alice'],
		['stable_user_id', 'alice'],
	]) {
		try {
			await database.pg.query(
				`INSERT INTO users (username, email, stable_user_id, password_hash) VALUES ($1, $2, $3, 'x')`,
				[
					column === 'username' ? value : 'other',
					column === 'email' ? value : 'other@example.test',
					column === 'stable_user_id' ? value : 'other',
				],
			)
			throw new Error('expected a real uniqueness violation')
		} catch (error) {
			expect(
				getUniqueConstraintField(new Error('wrapped', { cause: error })),
			).toBe(column)
		}
	}
	// Under RLS, PostgreSQL omits the `Key (...)=(...)` detail for rows the
	// caller cannot see; the default `<table>_<column>_key` name still names it.
	const bob = database.forUser('bob').db
	for (const [column, username, email] of [
		['username', 'alice', 'bob@example.test'],
		['email', 'bob', 'alice@example.test'],
	]) {
		const error = await bob
			.prepare(
				`INSERT INTO users (username, email, stable_user_id, password_hash) VALUES (?, ?, 'bob', 'x')`,
			)
			.bind(username, email)
			.run()
			.then(
				() => new Error('expected a real uniqueness violation'),
				(error: unknown) => error,
			)
		expect((error as { detail?: string }).detail).toBeUndefined()
		expect(
			getUniqueConstraintField(new Error('wrapped', { cause: error })),
		).toBe(column)
	}
	expect(
		getUniqueConstraintField(
			Object.assign(new Error('other error'), {
				code: '23503',
				detail: 'Key (email)=(x) is not present',
			}),
		),
	).toBeNull()
})
