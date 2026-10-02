import {
	PutItemCommand,
	TransactWriteItemsCommand,
	UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import { expect, test } from 'vitest'
import { createDynamoKv } from '#worker/aws/dynamo-kv.ts'
import { createDynamoIdempotency } from '#worker/aws/dynamo-runs.ts'
import { createFakeDynamo } from './fake-dynamo.ts'

test('fake DynamoDB runs the production KV and idempotency adapters with conditions, GSI paging and TTL', async () => {
	const dynamo = createFakeDynamo()
	let now = Date.parse('2026-10-01T00:00:00Z')
	const kv = createDynamoKv({
		region: 'us-east-1',
		tableName: 'oauth',
		namespace: 'OAUTH_KV',
		send: dynamo.send,
		now: () => now,
	})
	for (const key of ['grant:a:1', 'grant:a:2', 'grant:a:3', 'token:a:1']) {
		await kv.put(key, JSON.stringify({ key }), { expirationTtl: 60 })
	}
	expect(await kv.get('grant:a:2', 'json')).toEqual({ key: 'grant:a:2' })
	const first = await kv.list({ prefix: 'grant:', limit: 2 })
	expect(first.keys.map((key) => key.name)).toEqual(['grant:a:1', 'grant:a:2'])
	expect(first.list_complete).toBe(false)
	await kv.delete('grant:a:2')
	const rest = await kv.list({
		prefix: 'grant:',
		cursor: first.list_complete ? undefined : first.cursor,
	})
	expect(rest.keys.map((key) => key.name)).toEqual(['grant:a:3'])
	now += 61_000
	expect(await kv.get('grant:a:1')).toBeNull()
	expect((await kv.list({ prefix: 'grant:' })).keys).toEqual([])
	expect(dynamo.items('oauth').map((item) => item.pk?.S)).toEqual([
		'grant:a:1',
		'grant:a:3',
		'token:a:1',
	])

	const runs = createDynamoIdempotency({
		region: 'us-east-1',
		idempotencyTable: 'idempotency',
		send: dynamo.send,
		now: () => now,
	})
	const key = { userId: 'alice', surface: 'execute', key: 'k1' }
	expect(await runs.claimIdempotencyKey({ ...key, runId: 'r1' })).toEqual({
		claimed: true,
	})
	expect(await runs.claimIdempotencyKey({ ...key, runId: 'r2' })).toMatchObject(
		{ claimed: false, existing: { runId: 'r1' } },
	)
	expect(await runs.releaseIdempotencyKey({ ...key, runId: 'r2' })).toEqual({
		released: false,
	})
	expect(await runs.releaseIdempotencyKey({ ...key, runId: 'r1' })).toEqual({
		released: true,
	})
	expect(await runs.getIdempotencyKey(key)).toBeNull()
})

test('fake DynamoDB update expressions, ALL_OLD on failure and all-or-nothing transactions', async () => {
	const dynamo = createFakeDynamo()
	const Key = { pk: { S: 'alice' }, sk: { S: 'meter' } }
	const update = (max: number) =>
		dynamo.send(
			new UpdateItemCommand({
				TableName: 'meters',
				Key,
				UpdateExpression:
					'ADD #count :one SET #at = :at, #first = if_not_exists(#first, :at)',
				ConditionExpression: 'attribute_not_exists(#count) OR #count < :max',
				ExpressionAttributeNames: {
					'#count': 'count',
					'#at': 'at',
					'#first': 'first',
				},
				ExpressionAttributeValues: {
					':one': { N: '1' },
					':at': { S: `t${max}` },
					':max': { N: String(max) },
				},
				ReturnValues: 'ALL_NEW',
				ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
			}),
		)
	expect((await update(2)).Attributes).toMatchObject({
		count: { N: '1' },
		first: { S: 't2' },
	})
	expect((await update(3)).Attributes).toMatchObject({
		count: { N: '2' },
		at: { S: 't3' },
		first: { S: 't2' },
	})
	await expect(update(2)).rejects.toMatchObject({
		name: 'ConditionalCheckFailedException',
		Item: { count: { N: '2' } },
	})

	const transaction = (token: string) =>
		dynamo.send(
			new TransactWriteItemsCommand({
				TransactItems: [
					{
						ConditionCheck: {
							TableName: 'meters',
							Key: { pk: { S: 'alice' }, sk: { S: 'deletion' } },
							ConditionExpression: 'attribute_not_exists(pk)',
						},
					},
					{
						Put: {
							TableName: 'meters',
							Item: { pk: { S: 'alice' }, sk: { S: `lease#${token}` } },
							ConditionExpression: 'attribute_not_exists(pk)',
						},
					},
				],
			}),
		)
	await transaction('t1')
	await expect(transaction('t1')).rejects.toMatchObject({
		name: 'TransactionCanceledException',
		CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
	})
	await dynamo.send(
		new PutItemCommand({
			TableName: 'meters',
			Item: { pk: { S: 'alice' }, sk: { S: 'deletion' } },
		}),
	)
	await expect(transaction('t2')).rejects.toMatchObject({
		CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
	})
	expect(dynamo.items('meters').map((item) => item.sk?.S)).toEqual([
		'deletion',
		'lease#t1',
		'meter',
	])
})
