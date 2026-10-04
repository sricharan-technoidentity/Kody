import { expect, test, vi } from 'vitest'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-catalog.ts'
import { type RepoSessionRow } from './types.ts'
import {
	deleteEntitySource,
	externalReconcileGraceMs,
	listEntitySourcesByIds,
	listEntitySourcesForExternalReconcile,
	markEntitySourcePendingExternalReconcile,
} from './entity-sources.ts'

function catalogSessionRow(
	overrides: Partial<RepoSessionRow> & Pick<RepoSessionRow, 'id' | 'user_id'>,
): RepoSessionRow {
	return {
		source_id: 'source-1',
		source_repo_id: 'repo-1',
		session_branch: `sessions/${overrides.id}`,
		source_branch: 'main',
		base_commit: 'commit',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-06-24T19:00:00.000Z',
		updated_at: '2026-06-24T19:00:00.000Z',
		...overrides,
	}
}

test('source deletion removes only its repo-session storage inventory', async () => {
	await using database = await createTestDb({ userId: 'user-a' })
	await database.pg.exec(`
		INSERT INTO entity_sources (id,user_id,entity_kind,entity_id,repo_id,created_at,updated_at) VALUES ('source-a','user-a','repo','repo-a','repo-a','2026-01-01','2026-01-01'),('source-b','user-b','repo','repo-b','repo-b','2026-01-01','2026-01-01');
		INSERT INTO user_storage_buckets (user_id,storage_id,kind,created_at,last_seen_at) VALUES
			('user-a', 'repo-session:session-a', 'repo_session','2026-01-01','2026-01-01'),
			('user-a', 'exec:keep', 'execute','2026-01-01','2026-01-01'),
			('user-b', 'repo-session:session-b', 'repo_session','2026-01-01','2026-01-01');
	`)
	const db = database.db
	const indexEnv = createInMemoryRepoSessionIndexEnv(db)
	await indexEnv.REPO_SESSION_CATALOG!('user-a').insertSession({
		ownerId: 'user-a',
		row: catalogSessionRow({
			id: 'session-a',
			user_id: 'user-a',
			source_id: 'source-a',
		}),
	})
	await indexEnv.REPO_SESSION_CATALOG!('user-b').insertSession({
		ownerId: 'user-b',
		row: catalogSessionRow({
			id: 'session-b',
			user_id: 'user-b',
			source_id: 'source-b',
		}),
	})

	await expect(
		deleteEntitySource(
			{ APP_DB: db, REPO_SESSION_CATALOG: indexEnv.REPO_SESSION_CATALOG },
			{ id: 'source-a', userId: 'user-a' },
		),
	).resolves.toBe(true)
	expect(
		(
			await database.pg.query(
				`SELECT user_id,storage_id,kind FROM user_storage_buckets ORDER BY user_id,storage_id`,
			)
		).rows,
	).toEqual([
		{ user_id: 'user-a', storage_id: 'exec:keep', kind: 'execute' },
		{
			user_id: 'user-b',
			storage_id: 'repo-session:session-b',
			kind: 'repo_session',
		},
	])
	expect(
		await indexEnv.REPO_SESSION_CATALOG!('user-a').listByUser({
			ownerId: 'user-a',
		}),
	).toEqual([])
	expect(
		(
			await indexEnv.REPO_SESSION_CATALOG!('user-b').listByUser({
				ownerId: 'user-b',
			})
		).map((row) => row.id),
	).toEqual(['session-b'])
})

test('external reconcile selects token-pending packages and the daily backstop covers the fleet', async () => {
	await using database = await createTestDb({ userId: 'user-a' })
	await database.pg.exec(`
		INSERT INTO entity_sources (id,user_id,entity_kind,entity_id,repo_id,published_commit,indexed_commit,manifest_path,source_root,last_external_check_at,external_check_until,created_at,updated_at) VALUES
			(
				'dormant', 'user-1', 'package', 'package-1', 'repo-1',
				'commit-1', NULL, 'package.json', '/', NULL, NULL,
				'2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
			),
			(
				'pending', 'user-2', 'package', 'package-2', 'repo-2',
				'commit-2', NULL, 'package.json', '/',
				'2026-05-04T01:00:00.000Z', '2026-05-04T04:00:00.000Z',
				'2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z'
			),
			(
				'job', 'user-1', 'job', 'job-1', 'repo-3',
				'commit-3', NULL, 'kody.json', '/', NULL,
				'2026-05-04T04:00:00.000Z',
				'2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z'
			);
	`)
	const db = createPgDatabase({ connection: database.pg, role: 'kody_admin' })
	const before = '2026-05-04T01:55:00.000Z'

	const initial = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
	})
	expect(initial.map((row) => row.id)).toEqual(['pending'])

	const tokenExpiresAt = '2026-05-04T03:00:00.000Z'
	await markEntitySourcePendingExternalReconcile(
		database.forUser('user-1').db,
		{
			id: 'dormant',
			userId: 'user-1',
			tokenExpiresAt,
		},
	)
	const marked = await database
		.forUser('user-1')
		.db.prepare(
			`SELECT external_check_until FROM entity_sources WHERE id = 'dormant' AND user_id = 'user-1'`,
		)
		.first<{ external_check_until: string }>()

	expect(marked!.external_check_until).toBe(
		new Date(
			new Date(tokenExpiresAt).getTime() + externalReconcileGraceMs,
		).toISOString(),
	)

	const afterMint = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
	})
	expect(afterMint.map((row) => row.id)).toEqual(['dormant', 'pending'])

	const dailyBackstop = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
		includeAll: true,
	})
	expect(dailyBackstop.map((row) => row.id)).toEqual(['dormant', 'pending'])
})

test('listEntitySourcesByIds batches ids into IN queries and skips missing rows', async () => {
	await using database = await createTestDb({ userId: 'user-1' })
	await database.pg.exec(`
	`)
	const db = database.db
	for (const id of ['source-a', 'source-b', 'source-c']) {
		await db
			.prepare(
				`INSERT INTO entity_sources (id,user_id,entity_kind,entity_id,repo_id,published_commit,indexed_commit,manifest_path,source_root,last_external_check_at,external_check_until,created_at,updated_at) VALUES (?, 'user-1', 'package', ?, ?, 'commit-1', NULL, 'package.json', '/', NULL, NULL, '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`,
			)
			.bind(id, `package-${id}`, `repo-${id}`)
			.run()
	}
	const queries: string[] = []
	const prepare = db.prepare.bind(db)
	vi.spyOn(db, 'prepare').mockImplementation((query) => {
		queries.push(query)
		return prepare(query)
	})

	expect(await listEntitySourcesByIds(db, [])).toEqual([])
	expect(queries).toEqual([])

	const loaded = await listEntitySourcesByIds(db, [
		'source-b',
		'source-missing',
		'source-a',
		'source-b',
	])
	expect(loaded.map((row) => row.id).sort()).toEqual(['source-a', 'source-b'])
	expect(loaded.find((row) => row.id === 'source-a')?.entity_id).toBe(
		'package-source-a',
	)
	expect(queries).toEqual([
		'SELECT * FROM entity_sources WHERE id IN (?, ?, ?)',
	])

	const manyIds = Array.from({ length: 101 }, (_, index) => `missing-${index}`)
	await listEntitySourcesByIds(db, manyIds)
	expect(
		queries.filter((query) => query.includes('WHERE id IN (')).length,
	).toBe(3)
})
