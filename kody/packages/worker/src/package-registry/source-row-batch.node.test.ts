import { expect, test, vi } from 'vitest'
import { type PgDatabase } from '#worker/aws/pg-database.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntitySource: vi.fn(),
	loadPublishedEntityManifest: vi.fn(async (input: { sourceId: string }) => ({
		content: JSON.stringify({
			name: `@kentcdodds/${input.sourceId}`,
			exports: { '.': './index.js' },
			kody: {
				id: input.sourceId,
				description: 'Batched source fixture',
			},
		}),
	})),
}))

const {
	loadPackageManifestBySourceId,
	loadPackageSourceRowForUser,
	loadPackageSourceRowsForUser,
} = await import('./source.ts')

async function insertSource(
	store: Awaited<ReturnType<typeof createTestDb>>,
	input: { id: string; userId: string },
) {
	await store.pg.query(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit,
			manifest_path, source_root, last_external_check_at, external_check_until,
			created_at, updated_at
		) VALUES ($1, $2, 'package', $3, $4, 'commit-1', NULL, 'package.json', '/', NULL, NULL,
			'2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
		[input.id, input.userId, `package-${input.id}`, `repo-${input.id}`],
	)
}

function recordQueries(db: PgDatabase, queries: Array<string>): PgDatabase {
	return {
		...db,
		prepare(sql: string) {
			queries.push(sql.replace(/\s+/g, ' ').trim())
			return db.prepare(sql)
		},
	}
}

function createLoadEnv(db: PgDatabase) {
	return {
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: {
				get: vi.fn(async () => null),
				put: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			} as unknown as KVNamespace,
		} as unknown as Env,
		baseUrl: 'https://heykody.dev',
	}
}

test('queue-style concurrent manifest loads issue one entity_sources IN query', async () => {
	await using store = await createTestDb()
	await insertSource(store, { id: 'source-a', userId: 'user-1' })
	await insertSource(store, { id: 'source-b', userId: 'user-1' })
	await insertSource(store, { id: 'source-c', userId: 'user-1' })
	await insertSource(store, { id: 'source-other', userId: 'user-2' })

	const queries: Array<string> = []
	// user-1 loads through its own writer; user-2's source is hidden by RLS.
	const db = recordQueries(store.forUser('user-1').db, queries)
	const loadEnv = createLoadEnv(db)

	const [first, second, third] = await Promise.all([
		loadPackageManifestBySourceId({
			...loadEnv,
			userId: 'user-1',
			sourceId: 'source-a',
		}),
		loadPackageManifestBySourceId({
			...loadEnv,
			userId: 'user-1',
			sourceId: 'source-b',
		}),
		loadPackageManifestBySourceId({
			...loadEnv,
			userId: 'user-1',
			sourceId: 'source-c',
		}),
	])

	expect([first.source.id, second.source.id, third.source.id]).toEqual([
		'source-a',
		'source-b',
		'source-c',
	])
	expect(first.manifest.kody.id).toBe('source-a')
	const sourceQueries = queries.filter((query) =>
		query.includes('FROM entity_sources'),
	)
	expect(sourceQueries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?)',
	])

	await expect(
		loadPackageSourceRowForUser({
			env: loadEnv.env,
			userId: 'user-1',
			sourceId: 'source-other',
		}),
	).rejects.toThrow('was not found')
	await expect(
		loadPackageSourceRowForUser({
			env: loadEnv.env,
			userId: 'user-1',
			sourceId: 'source-missing',
		}),
	).rejects.toThrow('was not found')

	const loneQueriesStart = queries.length
	const lone = await loadPackageSourceRowForUser({
		env: loadEnv.env,
		userId: 'user-1',
		sourceId: 'source-a',
	})
	expect(lone.id).toBe('source-a')
	expect(queries.slice(loneQueriesStart)).toEqual([
		'SELECT * FROM entity_sources WHERE id = ?',
	])

	const explicit = await loadPackageSourceRowsForUser({
		env: loadEnv.env,
		userId: 'user-1',
		sourceIds: ['source-a', 'source-c', 'source-other', 'source-a', 'missing'],
	})
	expect([...explicit.keys()].sort()).toEqual(['source-a', 'source-c'])
	expect(
		queries.filter((query) => query.includes('WHERE id IN (')).at(-1),
	).toBe('SELECT * FROM entity_sources WHERE id IN (?, ?, ?, ?)')
})
