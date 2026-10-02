import { expect, test } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from './pg-database.ts'
import { createPgSearchIndex } from './pg-search-index.ts'

const vector = (column: number) =>
	Array.from({ length: 1024 }, (_, i) => (i === column ? 1 : 0))

test('vector and full-text search share owner isolation, builtins and immutable metadata keys', async () => {
	const { pg, db, reader, forUser } = await createTestDb({ userId: 'alice' })
	try {
		const alice = createPgSearchIndex({ db, reader, userId: 'alice' })
		const bob = createPgSearchIndex({ ...forUser('bob'), userId: 'bob' })
		const builtinDb = createPgDatabase({
			connection: pg,
			role: 'kody_indexer',
			userId: '__kody_builtin__',
		})
		const builtins = createPgSearchIndex({
			db: builtinDb,
			reader: builtinDb,
			userId: '__kody_builtin__',
		})
		await builtins.upsert([
			{
				id: 'guide',
				namespace: '__kody_builtin__',
				values: vector(0),
				metadata: { kind: 'guide', text: 'reading garden notes' },
			},
		])
		await alice.upsert([
			{
				id: 'same',
				namespace: 'alice',
				values: vector(0),
				metadata: { kind: 'memory', userId: 'alice', text: 'garden notes' },
			},
		])
		await bob.upsert([
			{
				id: 'same',
				namespace: 'bob',
				values: vector(1),
				metadata: { kind: 'memory', userId: 'bob', text: 'secret garden' },
			},
		])
		const result = await alice.query(vector(0), {
			namespace: 'alice',
			topK: 10,
			returnMetadata: 'all',
		})
		expect(
			result.matches.map((m) => [m.id, m.score, m.metadata?.userId]),
		).toEqual([['same', 1, 'alice']])
		expect(
			(
				await alice.query(vector(0), {
					namespace: '__kody_builtin__',
					topK: 10,
				})
			).matches[0]?.id,
		).toBe('guide')
		await expect(alice.query(vector(0), { namespace: 'bob' })).rejects.toThrow(
			'cross-user',
		)
		await expect(
			alice.upsert([{ id: 'stolen', namespace: 'bob', values: vector(0) }]),
		).rejects.toThrow('cross-user')
		await expect(
			alice.upsert([
				{ id: 'guide', namespace: '__kody_builtin__', values: vector(0) },
			]),
		).rejects.toThrow('cross-user')
		expect(
			(await alice.fullText('garden', { namespace: 'alice' })).map((m) => m.id),
		).toEqual(['same'])
		expect(await alice.fullText('secret', { namespace: 'alice' })).toEqual([])
		expect(
			(
				await alice.query(vector(0), {
					filter: { kind: { $eq: 'memory' }, userId: { $in: ['alice'] } },
					returnMetadata: 'all',
				})
			).matches.map((m) => m.id),
		).toEqual(['same'])
		expect(
			(await alice.query(vector(0), { filter: { userId: { $eq: 'bob' } } }))
				.matches,
		).toEqual([])
		await alice.deleteByIds(['same'])
		expect(await alice.getByIds(['same'])).toEqual([])
		expect((await bob.getByIds(['same']))[0]?.metadata?.userId).toBe('bob')
		await expect(alice.upsert([{ id: 'bad', values: [1, 2] }])).rejects.toThrow(
			'dimensions',
		)
	} finally {
		await pg.close()
	}
})
