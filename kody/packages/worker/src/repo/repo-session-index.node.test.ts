import { expect, test } from 'vitest'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createRepoSessionCatalog } from './repo-session-catalog.ts'
import { type RepoSessionRow } from './types.ts'

function sessionRow(id: string, userId: string): RepoSessionRow {
	const now = new Date().toISOString()
	return {
		id,
		user_id: userId,
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: 'convo-1',
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: now,
		updated_at: now,
	}
}

test('Dynamo repo session catalog persists, pages, expires and enforces owner on every operation', async () => {
	await using db = await createTestDb({ userId: 'alice' })
	const dynamo = createFakeDynamo()
	const factory = (ownerId: string) =>
		createRepoSessionCatalog({
			region: 'us-east-1',
			tableName: 'mock-repo-sessions',
			ownerId,
			db: db.forUser(ownerId).db,
			send: dynamo.send,
			cleanup: async (id) =>
				factory(ownerId).deleteSession({ ownerId, sessionId: id }),
		})
	const alice = factory('alice')
	await alice.insertSession({
		ownerId: 'alice',
		row: sessionRow('one', 'alice'),
	})
	await alice.insertSession({
		ownerId: 'alice',
		row: sessionRow('two', 'alice'),
	})
	expect(await factory('alice').countActive({ ownerId: 'alice' })).toBe(2)
	expect(
		await alice.hasActiveForSource({ ownerId: 'alice', sourceId: 'source-1' }),
	).toBe(true)
	expect(
		(
			await alice.getActiveByConversation({
				ownerId: 'alice',
				conversationId: 'convo-1',
			})
		)?.conversation_id,
	).toBe('convo-1')
	expect(
		await factory('bob').getSessionById({ ownerId: 'bob', sessionId: 'one' }),
	).toBeNull()
	await expect(
		alice.getSessionById({ ownerId: 'bob', sessionId: 'one' }),
	).rejects.toThrow('ownerId mismatch')
	await expect(
		alice.insertSession({
			ownerId: 'alice',
			row: sessionRow('foreign', 'bob'),
		}),
	).rejects.toThrow('different owner')
	await alice.updateSession({
		ownerId: 'alice',
		sessionId: 'two',
		status: 'published',
		expiresAt: '2099-01-01T00:00:00.000Z',
	})
	expect(await alice.countActive({ ownerId: 'alice' })).toBe(1)
	const page = await alice.exportSessions({ ownerId: 'alice', pageSize: 1 })
	expect(page).toMatchObject({
		total: 2,
		truncated: true,
		nextStartAfter: 'one',
	})
	expect(
		(
			await alice.exportSessions({
				ownerId: 'alice',
				startAfter: page.nextStartAfter,
			})
		).rows.map((row) => row.id),
	).toEqual(['two'])
	expect(
		await alice.runDueCleanup({
			ownerId: 'alice',
			now: '2099-01-02T00:00:00.000Z',
		}),
	).toEqual({ checked: 2, deleted: 2, errors: 0 })
	expect(await alice.countAll({ ownerId: 'alice' })).toBe(0)
	await alice.insertSession({
		ownerId: 'alice',
		row: sessionRow('three', 'alice'),
	})
	expect(
		await alice.deleteBySource({ ownerId: 'alice', sourceId: 'source-1' }),
	).toBe(1)
	await alice.purge({ ownerId: 'alice' })
	expect(await alice.listByUser({ ownerId: 'alice' })).toEqual([])
})
