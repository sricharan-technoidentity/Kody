import { type SqlDatabase } from '@kody-internal/shared/sql-database.ts'
import { expect, test } from 'vitest'
import { createPgDatabase } from '#worker/aws/pg-database.ts'
import { replaceRepoSessionDueOwner } from '#worker/repo/repo-session-due-owners.ts'
import { type RepoSessionRow } from '#worker/repo/types.ts'
import { createTestDb } from '#worker/test-support/aws/test-db.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-catalog.ts'
import { readRepoSessionStorageBucketCursor } from './repo-session-storage-bucket-cursor.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	flushStorageBucketRegistrationsForTests,
	listPlatformStorageBuckets,
	listUserStorageBucketEstimates,
	listUserStorageBucketIds,
	maybeRefreshStorageBucketEstimate,
	recordStorageBucketEstimate,
	registerMissingRepoSessionStorageBuckets,
	registerStorageBucket,
	repoSessionStorageBucketId,
	storageBucketKindFromStorageId,
} from './service.ts'

/** Owner writers per user plus the operator (`kody_admin`) the sweeps list with. */
async function createStorageBucketsDb() {
	const database = await createTestDb()
	const admin = createPgDatabase({
		connection: database.pg,
		role: 'kody_admin',
	})
	const envFor = (userId: string) =>
		({ APP_DB: database.forUser(userId).db }) as unknown as Env
	return {
		database,
		admin: admin as unknown as SqlDatabase,
		envFor,
		operatorEnv: {
			APP_DB: admin,
			APP_DB_FOR_USER: (userId: string) => database.forUser(userId).db,
		} as unknown as Env,
		[Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
		async count() {
			const { rows } = await database.pg.query<{ count: number }>(
				'SELECT COUNT(*)::int AS count FROM user_storage_buckets',
			)
			return rows[0]!.count
		},
	}
}

test('storage bucket registration soft-fails, dedupes, and lists by user', async () => {
	expect(storageBucketKindFromStorageId('job:abc')).toBe('job')
	expect(storageBucketKindFromStorageId('exec:abc')).toBe('execute')
	expect(storageBucketKindFromStorageId('package:abc')).toBe('package')
	expect(storageBucketKindFromStorageId('adhoc-bucket')).toBe('unknown')

	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()
	expect(() =>
		registerStorageBucket({
			env: {} as Env,
			userId: 'user-a',
			storageId: 'bucket-a',
		}),
	).not.toThrow()
	await using buckets = await createStorageBucketsDb()
	expect(() =>
		registerStorageBucket({
			// A read-only connection rejects the upsert.
			env: {
				APP_DB: buckets.database.forUser('user-a').reader,
			} as unknown as Env,
			userId: 'user-a',
			storageId: 'bucket-a',
			kind: 'execute',
		}),
	).not.toThrow()
	await flushStorageBucketRegistrationsForTests()
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-register-failed',
		expect.any(Error),
	)

	clearStorageBucketRegistrationDedupeForTests()
	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}
	for (let index = 0; index < 5; index += 1) {
		registerStorageBucket({
			env: buckets.envFor('user-a'),
			userId: 'user-a',
			storageId: 'exec:same',
			kind: 'execute',
			waitUntil,
		})
	}
	registerStorageBucket({
		env: buckets.envFor('user-a'),
		userId: 'user-a',
		storageId: 'bucket-a',
		waitUntil,
	})
	registerStorageBucket({
		env: buckets.envFor('user-b'),
		userId: 'user-b',
		storageId: 'bucket-b',
		waitUntil,
	})
	await Promise.all(pending)

	expect(await buckets.count()).toBe(3)
	await expect(
		listUserStorageBucketIds({
			env: buckets.envFor('user-a'),
			userId: 'user-a',
		}),
	).resolves.toEqual(['bucket-a', 'exec:same'])
	// RLS: another user's writer sees nothing even when asking for user-a.
	await expect(
		listUserStorageBucketIds({
			env: buckets.envFor('user-b'),
			userId: 'user-a',
		}),
	).resolves.toEqual([])
	await expect(
		listUserStorageBucketIds({
			env: buckets.envFor('user-b'),
			userId: 'user-b',
		}),
	).resolves.toEqual(['bucket-b'])
	await expect(
		listPlatformStorageBuckets({ db: buckets.admin }),
	).resolves.toEqual([
		{ userId: 'user-a', storageId: 'bucket-a' },
		{ userId: 'user-a', storageId: 'exec:same' },
		{ userId: 'user-b', storageId: 'bucket-b' },
	])
})

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

test('index-backed storage-bucket reconcile pages owners with a persisted cursor', async () => {
	await using buckets = await createStorageBucketsDb()
	const db = buckets.admin
	const indexEnv = {
		...buckets.operatorEnv,
		...createInMemoryRepoSessionIndexEnv(db),
	}
	const now = new Date('2026-06-24T20:00:00.000Z')
	const users = ['user-a', 'user-b', 'user-c'] as const
	for (const userId of users) {
		await replaceRepoSessionDueOwner({
			db: buckets.envFor(userId).APP_DB,
			userId,
			dueAt: '2099-01-01T00:00:00.000Z',
			now,
		})
		await indexEnv.REPO_SESSION_CATALOG(userId).insertSession({
			ownerId: userId,
			row: catalogSessionRow({
				id: `${userId}-active`,
				user_id: userId,
			}),
		})
	}
	await indexEnv.REPO_SESSION_CATALOG('user-a').insertSession({
		ownerId: 'user-a',
		row: catalogSessionRow({
			id: 'user-a-discarded',
			user_id: 'user-a',
			status: 'discarded',
		}),
	})

	const first = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(first).toBe(2)
	// Insert limit filled on user-b, so the cursor stays on the last fully
	// processed owner and the next tick retries user-b instead of skipping
	// any remaining sessions.
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('user-a')
	await expect(
		listUserStorageBucketEstimates({
			env: buckets.envFor('user-a'),
			userId: 'user-a',
		}),
	).resolves.toEqual([
		{
			storageId: repoSessionStorageBucketId('user-a-active'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])
	await expect(
		listUserStorageBucketEstimates({
			env: buckets.envFor('user-b'),
			userId: 'user-b',
		}),
	).resolves.toEqual([
		{
			storageId: repoSessionStorageBucketId('user-b-active'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])
	await expect(
		listUserStorageBucketEstimates({
			env: buckets.envFor('user-c'),
			userId: 'user-c',
		}),
	).resolves.toEqual([])

	const second = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(second).toBe(1)
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('user-c')
	await expect(
		listUserStorageBucketEstimates({
			env: buckets.envFor('user-c'),
			userId: 'user-c',
		}),
	).resolves.toEqual([
		{
			storageId: repoSessionStorageBucketId('user-c-active'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])

	const wrapped = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(wrapped).toBe(0)
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('')

	const steady = await registerMissingRepoSessionStorageBuckets({
		db,
		env: indexEnv,
		limit: 2,
		now,
	})
	expect(steady).toBe(0)
	expect(await readRepoSessionStorageBucketCursor(db)).toBe('user-b')
})

test('inventory CHECK, repo-session exclusion, UPDATE-only estimates and the refresh throttle', async () => {
	consoleWarn.mockImplementation(() => {})
	clearStorageBucketRegistrationDedupeForTests()
	await using buckets = await createStorageBucketsDb()
	const userId = 'usb-estimate'
	const env = buckets.envFor(userId)
	await expect(
		env.APP_DB.prepare(
			`INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at
			) VALUES (?, 'service:retired', 'service', 'now', 'now')`,
		)
			.bind(userId)
			.run(),
	).rejects.toThrow(/check constraint/i)

	const pending: Array<Promise<unknown>> = []
	const waitUntil = (promise: Promise<unknown>) => {
		pending.push(promise)
	}
	registerStorageBucket({
		env,
		userId,
		storageId: 'exec:registered',
		kind: 'execute',
		waitUntil,
	})
	registerStorageBucket({
		env,
		userId,
		storageId: repoSessionStorageBucketId('session-1'),
		kind: 'repo_session',
		waitUntil,
	})
	await Promise.all(pending)
	await expect(listUserStorageBucketIds({ env, userId })).resolves.toEqual([
		'exec:registered',
	])
	expect(await listPlatformStorageBuckets({ db: buckets.admin })).toEqual([
		{ userId, storageId: 'exec:registered' },
	])

	recordStorageBucketEstimate({
		env,
		userId,
		storageId: 'exec:registered',
		estimatedBytes: 4096,
		waitUntil,
	})
	// UPDATE-only: an estimate never creates an ownership row.
	recordStorageBucketEstimate({
		env,
		userId,
		storageId: 'exec:unregistered',
		estimatedBytes: 123,
		waitUntil,
	})
	await Promise.all(pending)
	await expect(
		listUserStorageBucketEstimates({ env, userId }),
	).resolves.toEqual([
		{ storageId: 'exec:registered', kind: 'execute', estimatedBytes: 4096 },
		{
			storageId: repoSessionStorageBucketId('session-1'),
			kind: 'repo_session',
			estimatedBytes: null,
		},
	])

	let reads = 0
	const readEstimatedBytes = async () => {
		reads += 1
		if (reads === 1) throw new Error('simulated estimate read failure')
		return 8192
	}
	const refresh = () =>
		maybeRefreshStorageBucketEstimate({
			env,
			userId,
			storageId: 'exec:registered',
			readEstimatedBytes,
			waitUntil,
		})
	refresh()
	await Promise.all(pending)
	expect(consoleWarn).toHaveBeenCalledWith(
		'storage-bucket-estimate-refresh-failed',
		expect.any(Error),
	)
	// A failed attempt does not consume the window; a success does.
	refresh()
	refresh()
	await Promise.all(pending)
	expect(reads).toBe(2)
	expect(
		(await listUserStorageBucketEstimates({ env, userId }))[0]?.estimatedBytes,
	).toBe(8192)
})
