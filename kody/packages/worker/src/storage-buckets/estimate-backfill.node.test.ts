import { createStorageTestEnv } from '#worker/test-support/storage.ts'
import { expect, test } from 'vitest'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { backfillStorageBucketEstimates } from './estimate-backfill.ts'
import {
	clearStorageBucketRegistrationDedupeForTests,
	listUserStorageBucketEstimates,
	registerStorageBucket,
} from './service.ts'

const testTimeout = 30_000

test(
	'backfill seeds stored estimates for unmeasured buckets in bounded batches',
	{ timeout: testTimeout },
	async () => {
		await using fixture = await createStorageTestEnv()
		const env = fixture.env
		clearStorageBucketRegistrationDedupeForTests()
		const userId = `usb-backfill-${crypto.randomUUID()}`
		fixture.scope(userId)
		const bucketA = `exec:${crypto.randomUUID()}`
		const bucketB = `package:${crypto.randomUUID()}`
		const sessionId = crypto.randomUUID()
		const sessionBucket = `repo-session:${sessionId}`
		// The probe keeps the bucket unregistered until its first write.
		await storageRunnerRpc({
			env,
			userId,
			storageId: bucketA,
		}).getEstimatedBytes()
		await fixture.seedRepoSession(sessionId)
		const sessionEstimate = (
			await repoSessionRpc(env, sessionId).getEstimatedBytes()
		).estimatedBytes
		const pending: Array<Promise<unknown>> = []
		const waitUntil = (promise: Promise<unknown>) => {
			pending.push(promise)
		}
		registerStorageBucket({
			env,
			userId,
			storageId: bucketA,
			kind: 'execute',
			waitUntil,
		})
		registerStorageBucket({
			env,
			userId,
			storageId: sessionBucket,
			kind: 'repo_session',
			waitUntil,
		})
		registerStorageBucket({
			env,
			userId,
			storageId: bucketB,
			kind: 'package',
			waitUntil,
		})
		await Promise.all(pending)

		// Registration alone leaves estimates NULL (unmeasured).
		await expect(
			listUserStorageBucketEstimates({ env, userId }),
		).resolves.toEqual(
			[bucketA, bucketB, sessionBucket]
				.sort()
				.map((storageId) => ({
					storageId,
					kind: storageId === sessionBucket ? 'repo_session' : undefined,
					estimatedBytes: null,
				}))
				.map((row) => ({
					...row,
					kind:
						row.kind ??
						(row.storageId.startsWith('exec:') ? 'execute' : 'package'),
				})),
		)

		// The bound is respected: batchSize 1 measures exactly one bucket.
		await expect(
			backfillStorageBucketEstimates({ env: fixture.operator(), batchSize: 1 }),
		).resolves.toEqual({ scanned: 1, updated: 1, failed: 0 })

		// The next sweep finishes the rest; both buckets end up measured at
		// the empty SQLite baseline.
		await expect(
			backfillStorageBucketEstimates({ env: fixture.operator() }),
		).resolves.toEqual({
			scanned: 2,
			updated: 2,
			failed: 0,
		})
		await expect(
			listUserStorageBucketEstimates({ env, userId }),
		).resolves.toEqual(
			[bucketA, bucketB, sessionBucket].sort().map((storageId) => ({
				storageId,
				kind:
					storageId === sessionBucket
						? 'repo_session'
						: storageId.startsWith('exec:')
							? 'execute'
							: 'package',
				estimatedBytes:
					storageId === sessionBucket
						? sessionEstimate
						: emptyStorageRunnerEstimatedBytes,
			})),
		)

		// Converged inventories make the lane a cheap no-op.
		await expect(
			backfillStorageBucketEstimates({ env: fixture.operator() }),
		).resolves.toEqual({
			scanned: 0,
			updated: 0,
			failed: 0,
		})
	},
)
