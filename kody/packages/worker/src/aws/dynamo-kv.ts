import {
	DeleteItemCommand,
	GetItemCommand,
	PutItemCommand,
	QueryCommand,
	type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import {
	base64UrlToBytes,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { type DynamoSend, dynamoSend, epochSeconds } from './dynamo.ts'

/** GSI (`ns` hash, `pk` range) that serves `list({ prefix })`. */
export const kvListIndexName = 'ns-pk'

/** DynamoDB caps items at 400 KB including attribute names. */
const maxValueBytes = 390_000

type KvGetType = 'text' | 'json' | 'arrayBuffer' | 'stream'
type Item = Record<string, AttributeValue>

/** Frozen-key contract: the KV key string is the partition key, unchanged. */
export function kvItemKey(key: string) {
	return { pk: key, sk: 'value' } as const
}

const keyAttributes = (key: string) => {
	const { pk, sk } = kvItemKey(key)
	return { pk: { S: pk }, sk: { S: sk } }
}

function decodeCursor(cursor: string): Item {
	try {
		const parsed = JSON.parse(
			new TextDecoder().decode(base64UrlToBytes(cursor)),
		) as unknown
		if (
			parsed &&
			typeof parsed === 'object' &&
			Object.values(parsed).every(
				(value) => typeof (value as { S?: unknown })?.S === 'string',
			)
		) {
			return parsed as Item
		}
	} catch {}
	throw new Error('Invalid KV list cursor.')
}

/**
 * `KVNamespace`-shaped adapter over one DynamoDB table, so
 * `@cloudflare/workers-oauth-provider` keeps its key strings byte for byte.
 * Expired items are hidden on read because DynamoDB TTL deletes lazily.
 */
export function createDynamoKv(input: {
	region: string
	tableName: string
	namespace: string
	send?: DynamoSend
	now?: () => number
}): KVNamespace {
	const send = dynamoSend(input)
	const now = input.now ?? Date.now
	const TableName = input.tableName
	const live = (item: Item) =>
		item.expiresAt?.N === undefined ||
		Number(item.expiresAt.N) > epochSeconds(now())
	const kv = {
		async get(
			key: string,
			options?: KvGetType | { type?: KvGetType; cacheTtl?: number },
		) {
			const type =
				(typeof options === 'string' ? options : options?.type) ?? 'text'
			const { Item } = await send(
				new GetItemCommand({
					TableName,
					Key: keyAttributes(key),
					ConsistentRead: true,
				}),
			)
			const bytes = Item?.value?.B
			if (!Item || !bytes || !live(Item)) return null
			if (type === 'arrayBuffer') return bytes.slice().buffer
			if (type === 'stream') return new Response(bytes.slice()).body
			const text = new TextDecoder().decode(bytes)
			return type === 'json' ? (JSON.parse(text) as unknown) : text
		},
		async put(
			key: string,
			value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
			options: {
				expiration?: number
				expirationTtl?: number
				metadata?: unknown
			} = {},
		) {
			const bytes = new Uint8Array(
				await new Response(value as BodyInit).arrayBuffer(),
			)
			// ponytail: values over ~390 KB are rejected; spill them to S3 under the same key if a caller needs more.
			if (bytes.byteLength > maxValueBytes) {
				throw new Error(
					`KV value for ${JSON.stringify(key)} exceeds ${maxValueBytes} bytes.`,
				)
			}
			const expiresAt =
				options.expiration ??
				(options.expirationTtl === undefined
					? undefined
					: epochSeconds(now()) + options.expirationTtl)
			await send(
				new PutItemCommand({
					TableName,
					Item: {
						...keyAttributes(key),
						ns: { S: input.namespace },
						value: { B: bytes },
						...(expiresAt === undefined
							? {}
							: { expiresAt: { N: String(expiresAt) } }),
						...(options.metadata === undefined
							? {}
							: { metadata: { S: JSON.stringify(options.metadata) } }),
					},
				}),
			)
		},
		async delete(key: string) {
			await send(new DeleteItemCommand({ TableName, Key: keyAttributes(key) }))
		},
		async list(
			options: {
				prefix?: string | null
				cursor?: string | null
				limit?: number
			} = {},
		) {
			const prefix = options.prefix ?? ''
			const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000)
			// ponytail: one GSI partition per namespace caps list throughput (~3k reads/s); shard `ns` if listing gets hot.
			const page = await send(
				new QueryCommand({
					TableName,
					IndexName: kvListIndexName,
					KeyConditionExpression: prefix
						? '#ns = :ns AND begins_with(#pk, :prefix)'
						: '#ns = :ns',
					FilterExpression:
						'attribute_not_exists(#expiresAt) OR #expiresAt > :now',
					ExpressionAttributeNames: {
						'#ns': 'ns',
						'#expiresAt': 'expiresAt',
						...(prefix ? { '#pk': 'pk' } : {}),
					},
					ExpressionAttributeValues: {
						':ns': { S: input.namespace },
						':now': { N: String(epochSeconds(now())) },
						...(prefix ? { ':prefix': { S: prefix } } : {}),
					},
					// One extra item tells a full last page apart from more keys:
					// DynamoDB returns LastEvaluatedKey whenever Limit is reached.
					Limit: limit + 1,
					ExclusiveStartKey: options.cursor
						? decodeCursor(options.cursor)
						: undefined,
				}),
			)
			const Items = (page.Items ?? []).slice(0, limit)
			const last = Items.at(-1)
			const LastEvaluatedKey =
				(page.Items?.length ?? 0) > limit && last
					? { ns: last.ns!, pk: last.pk!, sk: last.sk! }
					: page.LastEvaluatedKey
			const keys = Items.map((item) => ({
				name: item.pk!.S!,
				...(item.expiresAt?.N ? { expiration: Number(item.expiresAt.N) } : {}),
				...(item.metadata?.S
					? { metadata: JSON.parse(item.metadata.S) as unknown }
					: {}),
			}))
			return LastEvaluatedKey
				? {
						keys,
						list_complete: false as const,
						cursor: utf8ToBase64Url(JSON.stringify(LastEvaluatedKey)),
						cacheStatus: null,
					}
				: { keys, list_complete: true as const, cacheStatus: null }
		},
	}
	return kv as unknown as KVNamespace
}
