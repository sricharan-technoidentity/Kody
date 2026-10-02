import { expect, test } from 'vitest'
import { createS3Objects, type S3Output } from './s3-objects.ts'

function createBucket(outputs: Array<S3Output | Error> = []) {
	const calls: Array<{ name: string; input: unknown }> = []
	const bucket = createS3Objects({
		region: 'us-east-1',
		bucket: 'kody-test-blobs',
		send: async (command) => {
			calls.push({ name: command.constructor.name, input: command.input })
			const output = outputs.shift() ?? {}
			if (output instanceof Error) throw output
			return output
		},
	})
	return { bucket, calls }
}

const notFound = (name: string) => Object.assign(new Error(name), { name })

test('S3 objects keep R2 keys and metadata through put, get, head and delete', async () => {
	const bytes = new TextEncoder().encode('{"ok":true}')
	const { bucket, calls } = createBucket([
		{ ETag: '"abc"' },
		{
			Body: { transformToByteArray: async () => bytes } as S3Output['Body'],
			ContentLength: bytes.byteLength,
			ContentType: 'application/json',
			CacheControl: 'public, max-age=60',
			Metadata: { stableUserId: 'alice' },
			ETag: '"abc"',
		},
		notFound('NoSuchKey'),
		notFound('NotFound'),
		{},
		{},
		{ Errors: [{ Key: 'b' }] },
	])
	const key = 'user-avatars/alice/hash.webp'
	expect(
		await bucket.put(key, '{"ok":true}', {
			httpMetadata: {
				contentType: 'application/json',
				cacheControl: 'public, max-age=60',
			},
			customMetadata: { stableUserId: 'alice' },
		}),
	).toMatchObject({ key, size: bytes.byteLength, etag: 'abc' })
	const object = await bucket.get(key)
	expect(object).toMatchObject({
		key,
		size: bytes.byteLength,
		httpMetadata: {
			contentType: 'application/json',
			cacheControl: 'public, max-age=60',
		},
		customMetadata: { stableUserId: 'alice' },
	})
	expect(await object!.json()).toEqual({ ok: true })
	expect(await new Response(object!.body).text()).toBe('{"ok":true}')
	expect(await bucket.get('missing')).toBeNull()
	expect(await bucket.head('missing')).toBeNull()
	await bucket.delete(key)
	await bucket.delete(['a', 'b'])
	await expect(bucket.delete(['a', 'b'])).rejects.toThrow(
		'S3 delete failed for b',
	)
	const Bucket = 'kody-test-blobs'
	expect(calls.slice(0, 6)).toEqual([
		{
			name: 'PutObjectCommand',
			input: {
				Bucket,
				Key: key,
				Body: bytes,
				ContentType: 'application/json',
				CacheControl: 'public, max-age=60',
				Metadata: { stableUserId: 'alice' },
			},
		},
		{ name: 'GetObjectCommand', input: { Bucket, Key: key } },
		{ name: 'GetObjectCommand', input: { Bucket, Key: 'missing' } },
		{ name: 'HeadObjectCommand', input: { Bucket, Key: 'missing' } },
		{ name: 'DeleteObjectCommand', input: { Bucket, Key: key } },
		{
			name: 'DeleteObjectsCommand',
			input: {
				Bucket,
				Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }], Quiet: true },
			},
		},
	])
	const unavailable = createBucket([new Error('SlowDown')])
	await expect(unavailable.bucket.get(key)).rejects.toThrow('SlowDown')
})

test('S3 list maps prefix pages to R2 cursors and truncation', async () => {
	const uploaded = new Date('2026-10-01T00:00:00Z')
	const { bucket, calls } = createBucket([
		{
			Contents: [
				{
					Key: 'email-raw:v1:alice/m1',
					Size: 3,
					ETag: '"e1"',
					LastModified: uploaded,
				},
			],
			IsTruncated: true,
			NextContinuationToken: 'token-2',
		},
		{ Contents: [], IsTruncated: false },
	])
	expect(
		await bucket.list({ prefix: 'email-raw:v1:alice/', limit: 1 }),
	).toEqual({
		objects: [
			{
				key: 'email-raw:v1:alice/m1',
				size: 3,
				etag: 'e1',
				httpEtag: '"e1"',
				uploaded,
				httpMetadata: {},
				customMetadata: {},
			},
		],
		truncated: true,
		cursor: 'token-2',
		delimitedPrefixes: [],
	})
	expect(
		await bucket.list({ prefix: 'email-raw:v1:alice/', cursor: 'token-2' }),
	).toEqual({ objects: [], truncated: false, delimitedPrefixes: [] })
	expect(calls.map((call) => call.input)).toEqual([
		{ Bucket: 'kody-test-blobs', Prefix: 'email-raw:v1:alice/', MaxKeys: 1 },
		{
			Bucket: 'kody-test-blobs',
			Prefix: 'email-raw:v1:alice/',
			ContinuationToken: 'token-2',
			MaxKeys: 1000,
		},
	])
})
