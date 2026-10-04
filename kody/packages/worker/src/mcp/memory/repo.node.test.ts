import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { pgQuery } from '#worker/test-support/aws/user-test-env.ts'

import { expect, test } from 'vitest'

import { listMemoriesByUserIdPage } from './repo.ts'

async function createMemoryDb() {
	const database = await createTestDb({ userId: 'user-1' })
	const sqlite = database.pg

	return {
		sqlite,
		db: database.db,
		[Symbol.asyncDispose]: database[Symbol.asyncDispose],
	}
}

async function insertMemory(
	sqlite: Awaited<ReturnType<typeof createTestDb>>['pg'],
	row: { id: string; userId: string; status: string; subject: string },
) {
	await pgQuery(sqlite).run(
		`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		row.id,
		row.userId,
		row.status,
		row.subject,
		row.subject,
	)
}

test('listMemoriesByUserIdPage is user-scoped, status-filtered, and keyset-paged', async () => {
	await using harness = await createMemoryDb()
	const { sqlite, db } = harness
	await insertMemory(sqlite, {
		id: 'mem-a',
		userId: 'user-1',
		status: 'active',
		subject: 'Owned active',
	})
	await insertMemory(sqlite, {
		id: 'mem-b',
		userId: 'user-1',
		status: 'deleted',
		subject: 'Owned deleted',
	})
	await insertMemory(sqlite, {
		id: 'mem-c',
		userId: 'user-1',
		status: 'archived',
		subject: 'Owned archived',
	})
	await insertMemory(sqlite, {
		id: 'mem-other',
		userId: 'user-2',
		status: 'active',
		subject: 'Foreign active',
	})

	const firstPage = await listMemoriesByUserIdPage({
		db,
		userId: 'user-1',
		afterId: null,
		limit: 2,
		statuses: ['active', 'archived'],
	})
	expect(firstPage.map((row) => row.id)).toEqual(['mem-a', 'mem-c'])
	expect(firstPage.every((row) => row.user_id === 'user-1')).toBe(true)

	const secondPage = await listMemoriesByUserIdPage({
		db,
		userId: 'user-1',
		afterId: firstPage.at(-1)?.id ?? null,
		limit: 2,
		statuses: ['active', 'archived'],
	})
	expect(secondPage).toEqual([])

	const withDeleted = await listMemoriesByUserIdPage({
		db,
		userId: 'user-1',
		afterId: null,
		limit: 10,
		statuses: ['active', 'archived', 'deleted'],
	})
	expect(withDeleted.map((row) => row.id)).toEqual(['mem-a', 'mem-b', 'mem-c'])
	expect(withDeleted.some((row) => row.user_id !== 'user-1')).toBe(false)
})
