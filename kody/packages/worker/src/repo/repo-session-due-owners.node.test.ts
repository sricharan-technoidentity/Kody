import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import {
	listDueRepoSessionOwners,
	listRepoSessionDueOwnersPage,
	replaceRepoSessionDueOwner,
} from './repo-session-due-owners.ts'

test('due-owners upsert, page, and delete stay one row per user', async () => {
	await using database = await createTestDb()
	const db = createPgDatabase({ connection: database.pg, role: 'kody_admin' })
	const now = new Date('2026-06-24T20:00:00.000Z')

	await replaceRepoSessionDueOwner({
		db: database.forUser('user-b').db,
		userId: 'user-b',
		dueAt: '2026-06-24T21:00:00.000Z',
		now,
	})
	await replaceRepoSessionDueOwner({
		db: database.forUser('user-a').db,
		userId: 'user-a',
		dueAt: '2026-06-24T19:00:00.000Z',
		now,
	})
	await replaceRepoSessionDueOwner({
		db: database.forUser('user-a').db,
		userId: 'user-a',
		dueAt: '2026-06-24T18:00:00.000Z',
		now,
	})

	expect(
		await listDueRepoSessionOwners({
			db,
			now,
			limit: 10,
		}),
	).toEqual([{ userId: 'user-a', dueAt: '2026-06-24T18:00:00.000Z' }])
	expect(await listRepoSessionDueOwnersPage({ db, limit: 10 })).toEqual([
		{ userId: 'user-a', dueAt: '2026-06-24T18:00:00.000Z' },
		{ userId: 'user-b', dueAt: '2026-06-24T21:00:00.000Z' },
	])

	await replaceRepoSessionDueOwner({
		db: database.forUser('user-a').db,
		userId: 'user-a',
		dueAt: null,
		now,
	})
	expect(await listRepoSessionDueOwnersPage({ db, limit: 10 })).toEqual([
		{ userId: 'user-b', dueAt: '2026-06-24T21:00:00.000Z' },
	])
})
