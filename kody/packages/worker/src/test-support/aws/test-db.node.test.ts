import { expect, test } from 'vitest'
import { createTestDb } from './test-db.ts'

test('PGlite facade applies RLS, translates binds, rolls back batches and refuses reader writes', async () => {
	const { db, reader, pg } = await createTestDb({ userId: 'alice' })
	try {
		await db
			.prepare('INSERT INTO isolation_probe VALUES (?, ?, ?)')
			.bind('one', 'alice', 'a?b')
			.run()
		await pg.query('INSERT INTO isolation_probe VALUES ($1, $2, $3)', [
			'two',
			'bob',
			'hidden',
		])
		expect(
			(await db.prepare('SELECT value FROM isolation_probe ORDER BY id').all())
				.results,
		).toEqual([{ value: 'a?b' }])
		expect(
			await db
				.prepare('SELECT value FROM isolation_probe WHERE id = ?')
				.bind('one')
				.first('value'),
		).toBe('a?b')
		expect(await db.prepare('SELECT value FROM isolation_probe').raw()).toEqual(
			[['a?b']],
		)
		await expect(
			reader.prepare('DELETE FROM isolation_probe').run(),
		).rejects.toThrow('read-only transaction')
		await expect(
			db.batch([
				db
					.prepare('INSERT INTO isolation_probe VALUES (?, ?, ?)')
					.bind('three', 'alice', 'ok'),
				db
					.prepare('INSERT INTO isolation_probe VALUES (?, ?, ?)')
					.bind('four', 'bob', 'denied'),
			]),
		).rejects.toThrow('row-level security')
		expect(
			await db
				.prepare('SELECT id FROM isolation_probe WHERE id = ?')
				.bind('three')
				.first(),
		).toBeNull()
	} finally {
		await pg.close()
	}
})
