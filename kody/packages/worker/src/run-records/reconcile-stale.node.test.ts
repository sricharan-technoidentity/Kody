import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import {
	createRunRow,
	createTestRunRecords,
} from '#worker/test-support/run-records.ts'
import { reconcileStaleRunRecords } from './reconcile-stale.ts'

test('paged fleet sweep heals unvisited stale running records using each owner partition and skips deleting accounts', async () => {
	await using database = await createTestDb()
	await database.pg.exec(
		`INSERT INTO users (id,username,email,password_hash,created_at,updated_at,stable_user_id,deleting_at) VALUES (1,'alice','alice@example.com','hash','2026-10-01','2026-10-01','alice',NULL),(2,'bob','bob@example.com','hash','2026-10-01','2026-10-01','bob',NULL),(3,'deleted','deleted@example.com','hash','2026-10-01','2026-10-01','deleted','2026-10-01')`,
	)
	const store = createTestRunRecords()
	const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
	for (const userId of ['alice', 'bob', 'deleted']) {
		for (const id of ['one', 'two'])
			await store
				.forUser(userId)
				.startRun({ run: createRunRow({ id, startedAt: stale }) })
	}
	await store.forUser('alice').startRun({
		run: createRunRow({ id: 'live', startedAt: new Date().toISOString() }),
	})
	const result = await reconcileStaleRunRecords({
		db: createPgDatabase({ connection: database.pg, role: 'kody_admin' }),
		records: store.records,
		pageSize: 1,
	})
	expect(result.usersVisited).toBe(2)
	expect(result.pagesVisited).toBeGreaterThanOrEqual(4)
	// Inspect raw rows so assertions themselves cannot heal an omitted partition.
	const item = (userId: string, id: string) =>
		store.dynamo
			.items(store.tableName)
			.find((row) => row.pk?.S === userId && row.sk?.S === `run#${id}`)
	expect(item('alice', 'one')?.status?.S).toBe('error')
	expect(item('alice', 'two')?.status?.S).toBe('error')
	expect(item('bob', 'two')?.status?.S).toBe('error')
	expect(item('alice', 'live')?.status?.S).toBe('running')
	expect(item('deleted', 'one')?.status?.S).toBe('running')
})
