import { expect, test } from 'vitest'
import { type DynamoCommand, type DynamoOutput } from './dynamo.ts'
import { createDynamoUserMeters } from './dynamo-meters.ts'

function createMeter(outputs: Array<DynamoOutput | Error>) {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = []
	const meter = createDynamoUserMeters({
		region: 'us-east-1',
		tableName: 'kody-test-meters',
		send: async (command: DynamoCommand) => {
			calls.push({
				name: command.constructor.name,
				input: command.input as Record<string, unknown>,
			})
			const output = outputs.shift() ?? {}
			if (output instanceof Error) throw output
			return output
		},
	}).forUser('alice')
	return { meter, calls }
}

const day = '2026-10-01'
const counter = (count: number, revision: number) => ({
	pk: { S: 'alice' },
	sk: { S: `execute_calls_per_day#${day}` },
	day: { S: day },
	count: { N: String(count) },
	revision: { N: String(revision) },
})

test('daily consume reads userId / counter#day consistently and writes with a revision CAS', async () => {
	const { meter, calls } = createMeter([{ Item: counter(4, 7) }, {}])
	expect(
		await meter.consume({
			resource: 'execute_calls_per_day',
			day,
			limit: 10,
			updatedAt: `${day}T12:00:00.000Z`,
		}),
	).toMatchObject({ outcome: 'ready', count: 5, revision: 8, consumed: true })
	expect(calls).toEqual([
		{
			name: 'GetItemCommand',
			input: {
				TableName: 'kody-test-meters',
				Key: { pk: { S: 'alice' }, sk: { S: `execute_calls_per_day#${day}` } },
				ConsistentRead: true,
			},
		},
		{
			name: 'UpdateItemCommand',
			input: expect.objectContaining({
				Key: { pk: { S: 'alice' }, sk: { S: `execute_calls_per_day#${day}` } },
				UpdateExpression:
					'SET #count = :count, #revision = :next, #updatedAt = :updatedAt',
				ConditionExpression: '#revision = :revision',
				ExpressionAttributeValues: {
					':count': { N: '5' },
					':next': { N: '8' },
					':revision': { N: '7' },
					':updatedAt': { S: `${day}T12:00:00.000Z` },
				},
			}),
		},
	])
})

test('lease acquire is one transaction conditioned on the deletion tombstone', async () => {
	const cancelled = Object.assign(new Error('cancelled'), {
		name: 'TransactionCanceledException',
		CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
	})
	const throttled = Object.assign(new Error('throttled'), {
		name: 'TransactionCanceledException',
		CancellationReasons: [{ Code: 'ThrottlingError' }, { Code: 'None' }],
	})
	const { meter, calls } = createMeter([{}, cancelled, throttled])
	const lease = {
		token: 't1',
		holder: 'test',
		acquiredAt: '2026-10-01 00:00:00',
	}
	expect(await meter.acquireWriteLease(lease)).toEqual({ acquired: true })
	expect(await meter.acquireWriteLease(lease)).toEqual({ acquired: false })
	await expect(meter.acquireWriteLease(lease)).rejects.toThrow('throttled')
	expect(calls[0]).toEqual({
		name: 'TransactWriteItemsCommand',
		input: {
			TransactItems: [
				{
					ConditionCheck: {
						TableName: 'kody-test-meters',
						Key: { pk: { S: 'alice' }, sk: { S: 'deletion' } },
						ConditionExpression: 'attribute_not_exists(pk)',
					},
				},
				{
					Put: {
						TableName: 'kody-test-meters',
						Item: {
							pk: { S: 'alice' },
							sk: { S: 'lease#t1' },
							token: { S: 't1' },
							holder: { S: 'test' },
							acquiredAt: { S: '2026-10-01 00:00:00' },
						},
						ConditionExpression: 'attribute_not_exists(pk)',
					},
				},
			],
		},
	})
})
