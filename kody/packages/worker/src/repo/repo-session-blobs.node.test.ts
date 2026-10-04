import { createTestObjectBucket } from '#worker/test-support/aws/fake-s3.ts'
import { expect, test, vi } from 'vitest'
import {
	measureRepoSessionWorkspaceBlobBytes,
	purgeRepoSessionWorkspaceBlobs,
	repoSessionWorkspaceR2ListPrefix,
} from './repo-session-blobs.ts'

function createFakeR2(initial: Record<string, number>) {
	const objects = new Map(
		Object.entries(initial).map(([key, size]) => [key, size]),
	)
	const list = vi.fn(async (options: { prefix: string; cursor?: string }) => {
		const keys = [...objects.keys()]
			.filter((key) => key.startsWith(options.prefix))
			.sort()
		const pageSize = 2
		const start = options.cursor ? Number(options.cursor) : 0
		const pageKeys = keys.slice(start, start + pageSize)
		const next = start + pageSize
		return {
			objects: pageKeys.map((key) => ({ key, size: objects.get(key) ?? 0 })),
			truncated: next < keys.length,
			cursor: next < keys.length ? String(next) : undefined,
		}
	})
	const del = vi.fn(async (keys: string | Array<string>) => {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			objects.delete(key)
		}
	})
	return {
		objects,
		bucket: { list, delete: del } as unknown as R2Bucket,
	}
}

test('purge and measure walk paged R2 listings for one Durable Object prefix', async () => {
	expect(repoSessionWorkspaceR2ListPrefix('do-session-1')).toBe(
		'repo-session:do-session-1/',
	)
	const keepKey = 'repo-session:other-do/default/session/pack.pack'
	const { objects, bucket } = createFakeR2({
		'repo-session:do-session-1/default/session/.git/objects/pack/a.pack': 1_000,
		'repo-session:do-session-1/default/session/.git/objects/pack/b.pack': 2_000,
		'repo-session:do-session-1/default/session/large.bin': 3_000,
		[keepKey]: 9_000,
	})

	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			blobs: bucket,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBe(6_000)

	await purgeRepoSessionWorkspaceBlobs({
		blobs: bucket,
		durableObjectId: 'do-session-1',
	})

	expect([...objects.keys()]).toEqual([keepKey])
	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			blobs: bucket,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBe(0)
})

test('purge and measure no-op when the R2 binding is missing', async () => {
	await expect(
		purgeRepoSessionWorkspaceBlobs({
			blobs: null,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBeUndefined()
	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBe(0)
	await expect(
		purgeRepoSessionWorkspaceBlobs({
			blobs: {} as R2Bucket,
			durableObjectId: 'do-session-1',
		}),
	).resolves.toBeUndefined()
})

test('S3 repo workspace prefix purge preserves another session', async () => {
	const env = { REPO_SESSION_BLOBS: createTestObjectBucket().bucket }
	const durableObjectId = `workers-test-${crypto.randomUUID()}`
	const otherDurableObjectId = `workers-test-${crypto.randomUUID()}`
	const prefix = repoSessionWorkspaceR2ListPrefix(durableObjectId)
	const otherPrefix = repoSessionWorkspaceR2ListPrefix(otherDurableObjectId)
	const keepKey = `${otherPrefix}default/session/keep.bin`
	await env.REPO_SESSION_BLOBS.put(`${prefix}default/session/a.pack`, 'aaaa')
	await env.REPO_SESSION_BLOBS.put(`${prefix}default/session/b.pack`, 'bbbbbb')
	await env.REPO_SESSION_BLOBS.put(keepKey, 'keep-me')

	await expect(
		measureRepoSessionWorkspaceBlobBytes({
			blobs: env.REPO_SESSION_BLOBS,
			durableObjectId,
		}),
	).resolves.toBe(10)

	await purgeRepoSessionWorkspaceBlobs({
		blobs: env.REPO_SESSION_BLOBS,
		durableObjectId,
	})

	expect(
		await env.REPO_SESSION_BLOBS.get(`${prefix}default/session/a.pack`),
	).toBeNull()
	expect(
		await env.REPO_SESSION_BLOBS.get(`${prefix}default/session/b.pack`),
	).toBeNull()
	expect(await env.REPO_SESSION_BLOBS.get(keepKey)).not.toBeNull()
	await env.REPO_SESSION_BLOBS.delete(keepKey)
})
