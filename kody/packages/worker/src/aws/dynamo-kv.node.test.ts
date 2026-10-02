import { expect, test } from 'vitest'
import { type DynamoOutput } from './dynamo.ts'
import { createDynamoKv, kvListIndexName } from './dynamo-kv.ts'

const now = Date.parse('2026-10-01T00:00:00Z')
const nowSeconds = now / 1000

function createKv(outputs: DynamoOutput[] = []) {
	const calls: Array<{ name: string; input: unknown }> = []
	const kv = createDynamoKv({
		region: 'us-east-1',
		tableName: 'kody-test-oauth',
		namespace: 'OAUTH_KV',
		now: () => now,
		send: async (command) => {
			calls.push({ name: command.constructor.name, input: command.input })
			return outputs.shift() ?? {}
		},
	})
	return { kv, calls }
}

test('DynamoDB KV keeps the KV key as the item key, stores TTL and metadata, and hides expired items', async () => {
	const { kv, calls } = createKv([
		{},
		{
			Item: {
				pk: { S: 'grant:alice:g1' },
				value: { B: new TextEncoder().encode('{"id":"g1"}') },
			},
		},
		{
			Item: {
				pk: { S: 'grant:alice:g1' },
				value: { B: new TextEncoder().encode('raw') },
				expiresAt: { N: String(nowSeconds) },
			},
		},
		{},
		{},
	])
	await kv.put('grant:alice:g1', '{"id":"g1"}', {
		expirationTtl: 60,
		metadata: { userId: 'alice' },
	})
	expect(await kv.get('grant:alice:g1', { type: 'json' })).toEqual({
		id: 'g1',
	})
	expect(await kv.get('grant:alice:g1')).toBeNull()
	expect(await kv.get('missing')).toBeNull()
	await kv.delete('grant:alice:g1')
	const key = { pk: { S: 'grant:alice:g1' }, sk: { S: 'value' } }
	expect(calls).toEqual([
		{
			name: 'PutItemCommand',
			input: {
				TableName: 'kody-test-oauth',
				Item: {
					...key,
					ns: { S: 'OAUTH_KV' },
					value: { B: new TextEncoder().encode('{"id":"g1"}') },
					expiresAt: { N: String(nowSeconds + 60) },
					metadata: { S: '{"userId":"alice"}' },
				},
			},
		},
		...[key, key, { pk: { S: 'missing' }, sk: { S: 'value' } }].map((Key) => ({
			name: 'GetItemCommand',
			input: { TableName: 'kody-test-oauth', Key, ConsistentRead: true },
		})),
		{
			name: 'DeleteItemCommand',
			input: { TableName: 'kody-test-oauth', Key: key },
		},
	])
	await expect(kv.put('big', new Uint8Array(400_000))).rejects.toThrow(
		'exceeds',
	)
})

test('DynamoDB KV list pages a prefix through the namespace index with an opaque cursor, probing one extra item', async () => {
	const lastKey = {
		ns: { S: 'OAUTH_KV' },
		pk: { S: 'grant:alice:g1' },
		sk: { S: 'value' },
	}
	const { kv, calls } = createKv([
		{
			Items: [{ pk: { S: 'grant:alice:g1' }, expiresAt: { N: '1900000000' } }],
			LastEvaluatedKey: lastKey,
		},
		{ Items: [{ pk: { S: 'grant:alice:g2' }, metadata: { S: '{"a":1}' } }] },
	])
	const first = await kv.list({ prefix: 'grant:alice:', limit: 1 })
	expect(first).toMatchObject({
		keys: [{ name: 'grant:alice:g1', expiration: 1900000000 }],
		list_complete: false,
	})
	const second = await kv.list({
		prefix: 'grant:alice:',
		cursor: (first as { cursor: string }).cursor,
	})
	expect(second).toEqual({
		keys: [{ name: 'grant:alice:g2', metadata: { a: 1 } }],
		list_complete: true,
		cacheStatus: null,
	})
	const query = {
		TableName: 'kody-test-oauth',
		IndexName: kvListIndexName,
		KeyConditionExpression: '#ns = :ns AND begins_with(#pk, :prefix)',
		FilterExpression: 'attribute_not_exists(#expiresAt) OR #expiresAt > :now',
		ExpressionAttributeNames: {
			'#ns': 'ns',
			'#expiresAt': 'expiresAt',
			'#pk': 'pk',
		},
		ExpressionAttributeValues: {
			':ns': { S: 'OAUTH_KV' },
			':now': { N: String(nowSeconds) },
			':prefix': { S: 'grant:alice:' },
		},
	}
	expect(calls).toEqual([
		{
			name: 'QueryCommand',
			input: { ...query, Limit: 2, ExclusiveStartKey: undefined },
		},
		{
			name: 'QueryCommand',
			input: { ...query, Limit: 1001, ExclusiveStartKey: lastKey },
		},
	])
	await expect(kv.list({ cursor: 'not-a-cursor' })).rejects.toThrow(
		'Invalid KV list cursor',
	)
})
