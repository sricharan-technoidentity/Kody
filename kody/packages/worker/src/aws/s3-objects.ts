import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type DeleteObjectsCommandOutput,
	type GetObjectCommandOutput,
	type ListObjectsV2CommandOutput,
	type PutObjectCommandOutput,
} from '@aws-sdk/client-s3'

export type S3Command =
	| GetObjectCommand
	| HeadObjectCommand
	| PutObjectCommand
	| DeleteObjectCommand
	| DeleteObjectsCommand
	| ListObjectsV2Command

export type S3Output = Partial<
	GetObjectCommandOutput &
		PutObjectCommandOutput &
		ListObjectsV2CommandOutput &
		DeleteObjectsCommandOutput
>

export type S3Send = (
	command: S3Command,
	options?: { abortSignal?: AbortSignal },
) => Promise<S3Output>

type HttpMetadata = {
	contentType?: string
	contentLanguage?: string
	contentDisposition?: string
	contentEncoding?: string
	cacheControl?: string
}

const isNotFound = (error: unknown) =>
	error instanceof Error &&
	(error.name === 'NoSuchKey' || error.name === 'NotFound')

const defined = <T extends object>(value: T) =>
	Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined),
	) as T

function objectHead(key: string, output: S3Output, size?: number) {
	return {
		key,
		size: output.ContentLength ?? size ?? 0,
		etag: output.ETag?.replaceAll('"', '') ?? '',
		httpEtag: output.ETag ?? '',
		uploaded: output.LastModified ?? new Date(),
		httpMetadata: defined<HttpMetadata>({
			contentType: output.ContentType,
			contentLanguage: output.ContentLanguage,
			contentDisposition: output.ContentDisposition,
			contentEncoding: output.ContentEncoding,
			cacheControl: output.CacheControl,
		}),
		customMetadata: output.Metadata ?? {},
	}
}

/**
 * R2-shaped get/head/put/delete/list over one S3 bucket. Object keys are the
 * R2 keys unchanged (frozen-key contract).
 */
export function createS3Objects(input: {
	region: string
	bucket: string
	send?: S3Send
}) {
	const client = input.send ? undefined : new S3Client({ region: input.region })
	const send: S3Send =
		input.send ??
		((command, options) => client!.send(command as GetObjectCommand, options))
	const Bucket = input.bucket
	return {
		async head(key: string) {
			try {
				return objectHead(
					key,
					await send(new HeadObjectCommand({ Bucket, Key: key })),
				)
			} catch (error) {
				if (isNotFound(error)) return null
				throw error
			}
		},
		async get(
			key: string,
			options?: { signal?: AbortSignal; maxBytes?: number },
		) {
			let output: S3Output
			try {
				const command = new GetObjectCommand({ Bucket, Key: key })
				output = options?.signal
					? await send(command, { abortSignal: options.signal })
					: await send(command)
			} catch (error) {
				if (isNotFound(error)) return null
				throw error
			}
			// ponytail: buffers the whole object in memory; stream `output.Body` instead if objects outgrow a few MB.
			if (
				options?.maxBytes !== undefined &&
				(output.ContentLength === undefined ||
					output.ContentLength > options.maxBytes)
			)
				throw new Error('S3 object exceeds the bounded read limit.')
			const bytes =
				(await output.Body?.transformToByteArray()) ?? new Uint8Array()
			options?.signal?.throwIfAborted()
			if (
				options?.maxBytes !== undefined &&
				bytes.byteLength > options.maxBytes
			)
				throw new Error('S3 object exceeds the bounded read limit.')
			return {
				...objectHead(key, output, bytes.byteLength),
				get body() {
					return new Response(bytes.slice()).body!
				},
				bodyUsed: false,
				arrayBuffer: async () => bytes.slice().buffer,
				bytes: async () => bytes.slice(),
				text: async () => new TextDecoder().decode(bytes),
				json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
			}
		},
		async put(
			key: string,
			value:
				| string
				| ArrayBuffer
				| ArrayBufferView
				| ReadableStream
				| Blob
				| null,
			options: {
				httpMetadata?: HttpMetadata
				customMetadata?: Record<string, string>
			} = {},
		) {
			const bytes = new Uint8Array(
				await new Response(value as BodyInit | null).arrayBuffer(),
			)
			const http = options.httpMetadata ?? {}
			const output = await send(
				new PutObjectCommand(
					defined({
						Bucket,
						Key: key,
						Body: bytes,
						ContentType: http.contentType,
						ContentLanguage: http.contentLanguage,
						ContentDisposition: http.contentDisposition,
						ContentEncoding: http.contentEncoding,
						CacheControl: http.cacheControl,
						Metadata: options.customMetadata,
					}),
				),
			)
			return {
				...objectHead(key, output, bytes.byteLength),
				httpMetadata: http,
				customMetadata: options.customMetadata ?? {},
			}
		},
		async delete(keys: string | string[]) {
			if (typeof keys === 'string') {
				await send(new DeleteObjectCommand({ Bucket, Key: keys }))
				return
			}
			for (let start = 0; start < keys.length; start += 1000) {
				const output = await send(
					new DeleteObjectsCommand({
						Bucket,
						Delete: {
							Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })),
							Quiet: true,
						},
					}),
				)
				if (output.Errors?.length) {
					throw new Error(
						`S3 delete failed for ${output.Errors.map((entry) => entry.Key).join(', ')}.`,
					)
				}
			}
		},
		async list(
			options: {
				prefix?: string
				cursor?: string
				limit?: number
				delimiter?: string
			} = {},
		) {
			const output = await send(
				new ListObjectsV2Command(
					defined({
						Bucket,
						Prefix: options.prefix,
						ContinuationToken: options.cursor,
						MaxKeys: options.limit ?? 1000,
						Delimiter: options.delimiter,
					}),
				),
			)
			const objects = (output.Contents ?? []).map((entry) =>
				objectHead(entry.Key!, {
					ContentLength: entry.Size,
					ETag: entry.ETag,
					LastModified: entry.LastModified,
				}),
			)
			const delimitedPrefixes = (output.CommonPrefixes ?? []).map(
				(entry) => entry.Prefix!,
			)
			return output.IsTruncated && output.NextContinuationToken
				? {
						objects,
						truncated: true as const,
						cursor: output.NextContinuationToken,
						delimitedPrefixes,
					}
				: { objects, truncated: false as const, delimitedPrefixes }
		},
	}
}
