import { expect, test } from 'vitest'
import { type DynamoOutput } from './dynamo.ts'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createTestObjectBucket } from '#worker/test-support/aws/fake-s3.ts'
import { type RunLogRowInput } from '#worker/run-records/run-log-types.ts'
import {
	createDynamoIdempotency,
	createDynamoRunRecords,
	runLogObjectKey,
	runRetentionSeconds,
	runsByStartedIndex,
} from './dynamo-runs.ts'

const now = Date.parse('2026-10-01T00:00:00Z')
const nowSeconds = now / 1000

const conditionFailed = (Item?: DynamoOutput['Item']) =>
	Object.assign(new Error('The conditional request failed'), {
		name: 'ConditionalCheckFailedException',
		Item,
	})

function createRuns(outputs: Array<DynamoOutput | Error>) {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = []
	const runs = createDynamoIdempotency({
		region: 'us-east-1',
		idempotencyTable: 'kody-test-idempotency',
		now: () => now,
		send: async (command) => {
			calls.push({
				name: command.constructor.name,
				input: command.input as Record<string, unknown>,
			})
			const output = outputs.shift() ?? {}
			if (output instanceof Error) throw output
			return output
		},
	})
	return { runs, calls }
}

test('idempotency keys are claimed once per userId / surface#key for 90 days, completed by the claimer, and released only while running', async () => {
	const existing = {
		runId: { S: 'run-1' },
		status: { S: 'completed' },
		claimedAt: { S: '2026-09-30T00:00:00.000Z' },
		result: { S: 'runs/alice/run-1/response.json' },
		expiresAt: { N: String(nowSeconds + 10) },
	}
	const { runs, calls } = createRuns([
		{},
		conditionFailed(existing),
		{},
		{ Item: existing },
		{ Item: { ...existing, expiresAt: { N: String(nowSeconds) } } },
		{},
		conditionFailed(),
	])
	const key = { userId: 'alice', surface: 'webhook', key: 'abc#1' }
	expect(await runs.claimIdempotencyKey({ ...key, runId: 'run-1' })).toEqual({
		claimed: true,
	})
	expect(await runs.claimIdempotencyKey({ ...key, runId: 'run-2' })).toEqual({
		claimed: false,
		existing: {
			runId: 'run-1',
			status: 'completed',
			claimedAt: '2026-09-30T00:00:00.000Z',
			result: 'runs/alice/run-1/response.json',
		},
	})
	await runs.completeIdempotencyKey({
		...key,
		runId: 'run-1',
		result: 'runs/alice/run-1/response.json',
	})
	expect(await runs.getIdempotencyKey(key)).toMatchObject({ runId: 'run-1' })
	expect(await runs.getIdempotencyKey(key)).toBeNull()
	expect(await runs.releaseIdempotencyKey({ ...key, runId: 'run-1' })).toEqual({
		released: true,
	})
	expect(await runs.releaseIdempotencyKey({ ...key, runId: 'run-1' })).toEqual({
		released: false,
	})
	const Key = { pk: { S: 'alice' }, sk: { S: 'webhook#abc#1' } }
	expect(calls[0]).toEqual({
		name: 'PutItemCommand',
		input: {
			TableName: 'kody-test-idempotency',
			Item: {
				...Key,
				runId: { S: 'run-1' },
				status: { S: 'running' },
				claimedAt: { S: '2026-10-01T00:00:00.000Z' },
				expiresAt: { N: String(nowSeconds + runRetentionSeconds) },
			},
			ConditionExpression: 'attribute_not_exists(pk) OR #expiresAt <= :now',
			ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
			ExpressionAttributeValues: { ':now': { N: String(nowSeconds) } },
			ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
		},
	})
	expect(calls[2]?.input).toMatchObject({
		Key,
		ConditionExpression: '#runId = :runId',
	})
	expect(calls[5]?.input).toMatchObject({
		Key,
		ConditionExpression: '#runId = :runId AND #status = :running',
	})
	await expect(
		runs.claimIdempotencyKey({ ...key, surface: 'web#hook', runId: 'run-3' }),
	).rejects.toThrow('Invalid surface')
})

function runRow(overrides: Partial<RunLogRowInput> = {}): RunLogRowInput {
	const startedAt = '2026-10-01T00:00:00.000Z'
	return {
		id: 'run-1',
		surface: 'job',
		status: 'running',
		name: 'nightly',
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: 'scheduled-job:job-1:1',
		parentRunId: null,
		startedAt,
		finishedAt: null,
		durationMs: null,
		errorName: null,
		errorMessage: null,
		metadataJson: '{}',
		createdAt: startedAt,
		updatedAt: startedAt,
		...overrides,
	}
}

test('run records keep one partition per user: run#id items, claim pointers, job counters in the finish transaction, S3 logs', async () => {
	const dynamo = createFakeDynamo()
	const logs = createTestObjectBucket('kody-test-run-logs')
	const commands: Array<{ name: string; input: Record<string, unknown> }> = []
	const records = createDynamoRunRecords({
		region: 'us-east-1',
		tableName: 'kody-test-runs',
		logs: logs.bucket,
		now: () => now,
		send: (command) => {
			commands.push({
				name: command.constructor.name,
				input: command.input as Record<string, unknown>,
			})
			return dynamo.send(command)
		},
	})
	const alice = records.forUser('alice')
	expect(await alice.claimRun({ run: runRow() })).toMatchObject({
		claimed: true,
		run: { id: 'run-1', status: 'running' },
	})
	const claim = commands.find(
		(call) => call.name === 'TransactWriteItemsCommand',
	)
	expect(claim?.input).toMatchObject({
		TransactItems: [
			{
				Put: {
					TableName: 'kody-test-runs',
					Item: {
						pk: { S: 'alice' },
						sk: { S: 'claim#job#scheduled-job:job-1:1' },
						runId: { S: 'run-1' },
					},
					ConditionExpression: 'attribute_not_exists(pk)',
				},
			},
			{
				Put: {
					Item: {
						pk: { S: 'alice' },
						sk: { S: 'run#run-1' },
						startedSk: { S: '2026-10-01T00:00:00.000Z#run-1' },
						expiresAt: { N: String(nowSeconds + 30 * 24 * 60 * 60) },
						status: { S: 'running' },
					},
					ConditionExpression: 'attribute_not_exists(pk)',
				},
			},
		],
	})
	expect(
		(await records.forUser('bob').claimRun({ run: runRow({ id: 'run-2' }) }))
			.claimed,
	).toBe(true)
	expect(await alice.claimRun({ run: runRow({ id: 'run-3' }) })).toMatchObject({
		claimed: false,
		run: { id: 'run-1' },
	})

	commands.length = 0
	await alice.finishRun({
		run: runRow({
			status: 'success',
			finishedAt: '2026-10-01T00:00:05.000Z',
			durationMs: 5000,
			updatedAt: '2026-10-01T00:00:05.000Z',
		}),
		logs: [{ sequence: 0, level: 'info', message: 'done', fieldsJson: null }],
	})
	const finish = commands.find(
		(call) => call.name === 'TransactWriteItemsCommand',
	)
	expect(finish?.input).toMatchObject({
		TransactItems: [
			{
				Put: {
					Item: { sk: { S: 'run#run-1' }, status: { S: 'success' } },
					ConditionExpression: '#updatedAt = :updatedAt',
				},
			},
			{
				Update: {
					Key: { pk: { S: 'alice' }, sk: { S: 'job#job-1' } },
					UpdateExpression: expect.stringContaining(
						'ADD #runCount :runCount, #successCount :successCount, #errorCount :errorCount',
					),
				},
			},
		],
	})
	expect([...logs.objects.keys()]).toEqual([runLogObjectKey('alice', 'run-1')])
	expect(await alice.getRun({ runId: 'run-1' })).toMatchObject({
		run: { status: 'success', logCount: 1 },
		logs: [{ runId: 'run-1', sequence: 0, level: 'info', message: 'done' }],
	})

	commands.length = 0
	const page = await alice.listRuns({ limit: 10, surface: 'job' })
	expect(page.runs.map((run) => run.id)).toEqual(['run-1'])
	expect(commands[0]?.input).toMatchObject({
		IndexName: runsByStartedIndex,
		KeyConditionExpression: 'pk = :pk',
		ScanIndexForward: false,
		FilterExpression: '#expiresAt > :now AND #surface = :surface',
	})
	expect(await alice.getJobRunObservability({ jobId: 'job-1' })).toMatchObject({
		runCount: 1,
		successCount: 1,
		lastRunStatus: 'success',
		lastDurationMs: 5000,
	})
})
