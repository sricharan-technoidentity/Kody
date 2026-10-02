import { createDynamoKv, kvItemKey } from '#worker/aws/dynamo-kv.ts'
import { createFakeDynamo } from './aws/fake-dynamo.ts'

/**
 * KV namespace for node tests: the production DynamoDB KV adapter
 * (`aws/dynamo-kv.ts`) over the in-memory DynamoDB fake, so key strings,
 * TTL and `list` paging match the target store. `store` exposes the current
 * values by key for assertions.
 */
export function createMemoryKvNamespace(
	initial?: Record<string, string>,
	options: { namespace?: string; now?: () => number } = {},
) {
	const dynamo = createFakeDynamo()
	const tableName = 'kody-test-oauth'
	const namespace = options.namespace ?? 'OAUTH_KV'
	const kv = createDynamoKv({
		region: 'us-east-1',
		tableName,
		namespace,
		send: dynamo.send,
		now: options.now,
	})
	const store = {
		/** Synchronous write in the adapter's item shape. */
		set(key: string, value: string) {
			const { pk, sk } = kvItemKey(key)
			dynamo.putItem(tableName, {
				pk: { S: pk },
				sk: { S: sk },
				ns: { S: namespace },
				value: { B: new TextEncoder().encode(value) },
			})
		},
		get(key: string) {
			const item = dynamo
				.items(tableName)
				.find((candidate) => candidate.pk?.S === key)
			return item?.value?.B ? new TextDecoder().decode(item.value.B) : undefined
		},
		has(key: string) {
			return store.get(key) !== undefined
		},
		keys() {
			return dynamo.items(tableName).map((item) => item.pk!.S!)
		},
		get size() {
			return dynamo.items(tableName).length
		},
	}
	for (const [key, value] of Object.entries(initial ?? {}))
		store.set(key, value)
	return { kv, store, dynamo }
}
