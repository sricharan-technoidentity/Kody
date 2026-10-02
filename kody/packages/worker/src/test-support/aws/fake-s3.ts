import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
} from '@aws-sdk/client-s3'
import {
	createS3Objects,
	type S3Command,
	type S3Output,
} from '#worker/aws/s3-objects.ts'

type StoredObject = {
	bytes: Uint8Array
	contentType?: string
	cacheControl?: string
	contentDisposition?: string
	contentEncoding?: string
	contentLanguage?: string
	metadata?: Record<string, string>
	etag: string
	lastModified: Date
}

/**
 * In-memory S3 that interprets the commands `aws/s3-objects.ts` sends
 * (Get/Head/Put/Delete/DeleteObjects/ListObjectsV2 with prefix, delimiter and
 * continuation tokens), so caller tests run the production R2-shaped adapter.
 */
export function createFakeS3() {
	const buckets = new Map<string, Map<string, StoredObject>>()
	let version = 0
	const bucketOf = (name: string | undefined) => {
		if (!name) throw new Error('Bucket is required.')
		let bucket = buckets.get(name)
		if (!bucket) buckets.set(name, (bucket = new Map()))
		return bucket
	}
	const notFound = () =>
		Object.assign(new Error('The specified key does not exist.'), {
			name: 'NoSuchKey',
		})
	const head = (object: StoredObject): S3Output => ({
		ContentLength: object.bytes.byteLength,
		ETag: `"${object.etag}"`,
		LastModified: object.lastModified,
		ContentType: object.contentType,
		CacheControl: object.cacheControl,
		ContentDisposition: object.contentDisposition,
		ContentEncoding: object.contentEncoding,
		ContentLanguage: object.contentLanguage,
		Metadata: object.metadata,
	})

	async function send(command: S3Command): Promise<S3Output> {
		const bucket = bucketOf(command.input.Bucket)
		if (command instanceof PutObjectCommand) {
			const input = command.input
			const body = input.Body
			const bytes =
				body instanceof Uint8Array
					? body.slice()
					: new Uint8Array(await new Response(body as BodyInit).arrayBuffer())
			const object: StoredObject = {
				bytes,
				contentType: input.ContentType,
				cacheControl: input.CacheControl,
				contentDisposition: input.ContentDisposition,
				contentEncoding: input.ContentEncoding,
				contentLanguage: input.ContentLanguage,
				metadata: input.Metadata && { ...input.Metadata },
				etag: `etag-${++version}`,
				lastModified: new Date(),
			}
			bucket.set(input.Key!, object)
			return { ETag: `"${object.etag}"` }
		}
		if (
			command instanceof GetObjectCommand ||
			command instanceof HeadObjectCommand
		) {
			const object = bucket.get(command.input.Key!)
			if (!object) throw notFound()
			if (command instanceof HeadObjectCommand) return head(object)
			const bytes = object.bytes.slice()
			return {
				...head(object),
				Body: { transformToByteArray: async () => bytes },
			} as unknown as S3Output
		}
		if (command instanceof DeleteObjectCommand) {
			bucket.delete(command.input.Key!)
			return {}
		}
		if (command instanceof DeleteObjectsCommand) {
			for (const { Key } of command.input.Delete?.Objects ?? []) {
				bucket.delete(Key!)
			}
			return { Errors: [] }
		}
		if (command instanceof ListObjectsV2Command) {
			const {
				Prefix = '',
				Delimiter,
				ContinuationToken,
				MaxKeys = 1000,
			} = command.input
			const prefixes = new Set<string>()
			const contents: Array<{
				Key: string
				Size: number
				ETag: string
				LastModified: Date
			}> = []
			for (const key of [...bucket.keys()].sort()) {
				if (!key.startsWith(Prefix)) continue
				if (ContinuationToken && key <= ContinuationToken) continue
				const rest = key.slice(Prefix.length)
				const cut = Delimiter ? rest.indexOf(Delimiter) : -1
				if (cut >= 0) {
					prefixes.add(Prefix + rest.slice(0, cut + Delimiter!.length))
					continue
				}
				const object = bucket.get(key)!
				contents.push({
					Key: key,
					Size: object.bytes.byteLength,
					ETag: `"${object.etag}"`,
					LastModified: object.lastModified,
				})
			}
			// ponytail: common prefixes are not paged; fine for test-sized buckets.
			const page = contents.slice(0, MaxKeys)
			const truncated = contents.length > MaxKeys
			return {
				Contents: page,
				CommonPrefixes: [...prefixes].map((prefix) => ({ Prefix: prefix })),
				IsTruncated: truncated,
				...(truncated ? { NextContinuationToken: page.at(-1)!.Key } : {}),
			}
		}
		throw new Error('Unsupported S3 command.')
	}

	return {
		send,
		/** Snapshot of one bucket: bytes plus R2-style metadata per key. */
		objects(bucketName: string) {
			return new Map(
				[...bucketOf(bucketName)].map(([key, object]) => [
					key,
					{
						bytes: object.bytes.slice(),
						customMetadata: object.metadata ?? {},
						httpMetadata: {
							contentType: object.contentType,
							cacheControl: object.cacheControl,
						},
					},
				]),
			)
		},
	}
}

/** The production R2-shaped S3 adapter over a fresh fake bucket. */
export function createTestObjectBucket(name = 'kody-test-blobs') {
	const s3 = createFakeS3()
	const bucket = createS3Objects({
		region: 'us-east-1',
		bucket: name,
		send: s3.send,
	})
	return {
		bucket: bucket as unknown as R2Bucket,
		/** Fresh snapshot on every read. */
		get objects() {
			return s3.objects(name)
		},
		s3,
	}
}
