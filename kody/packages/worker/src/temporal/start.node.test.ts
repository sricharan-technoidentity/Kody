import { expect, test } from 'vitest'
import { createDynamoIdempotency } from '#worker/aws/dynamo-runs.ts'
import { createFakeDynamo } from '#worker/test-support/aws/fake-dynamo.ts'
import { createRecordingTemporal } from '#worker/test-support/aws/recording-temporal.ts'
import { startKodyWorkflow } from './start.ts'

test('durable starts survive uncertain transport and replay completed claims beyond workflow retention', async () => {
	const recording = createRecordingTemporal()
	const idempotency = createDynamoIdempotency({
		region: 'us-east-1',
		idempotencyTable: 'claims',
		send: createFakeDynamo().send,
	})
	const temporal = { ...recording.TEMPORAL, idempotency }
	const input = {
		workflowType: 'PackageInvocation',
		workflowId: 'alice:http:key',
		taskQueue: 'runtime',
		userId: 'alice',
		surface: 'http',
		args: [],
	} as const
	recording.failNext(new Error('connection lost after sending'))
	await expect(
		startKodyWorkflow(temporal, { ...input, args: [] }),
	).rejects.toThrow('connection lost')
	expect(
		await idempotency.getIdempotencyKey({
			userId: 'alice',
			surface: 'http',
			key: input.workflowId,
		}),
	).toMatchObject({ status: 'running' })
	expect(await startKodyWorkflow(temporal, { ...input, args: [] })).toBe(
		'started',
	)
	expect(await startKodyWorkflow(temporal, { ...input, args: [] })).toBe(
		'duplicate',
	)
	const claim = await idempotency.getIdempotencyKey({
		userId: 'alice',
		surface: 'http',
		key: input.workflowId,
	})
	await idempotency.completeIdempotencyKey({
		userId: 'alice',
		surface: 'http',
		key: input.workflowId,
		runId: claim!.runId,
		result: '{"ok":true}',
	})
	// Another client sees no Temporal history, but still finds the 90-day claim.
	const fresh = createRecordingTemporal()
	expect(
		await startKodyWorkflow(
			{ ...fresh.TEMPORAL, idempotency },
			{ ...input, args: [] },
		),
	).toBe('duplicate')
	expect(fresh.starts).toHaveLength(0)
})

test('workflow completion encrypts a replay result in S3 before closing the 90-day claim', async () => {
	const { createTemporalEnv } =
		await import('#worker/test-support/aws/temporal-env.ts')
	const { createFakeKms } = await import('#worker/test-support/aws/fake-kms.ts')
	const { base64UrlToBytes } = await import('@kody-internal/shared/base64.ts')
	const kms = createFakeKms()
	const server = await createTemporalEnv({ timeSkipping: true, kms })
	try {
		await server.startWorkers({ activities: {}, queues: ['runtime'] })
		expect(
			await startKodyWorkflow(server.temporal, {
				workflowType: 'harnessDelay',
				workflowId: 'alice:delay:one',
				taskQueue: 'runtime',
				args: [60_000],
				userId: 'alice',
				surface: 'delay',
			}),
		).toBe('started')
		expect(
			await server.client.workflow.getHandle('alice:delay:one').result(),
		).toBe('elapsed')
		const claim = await server.temporal.idempotency!.getIdempotencyKey({
			userId: 'alice',
			surface: 'delay',
			key: 'alice:delay:one',
		})
		expect(claim?.status).toBe('completed')
		const object = await server.temporal.results!.get(claim!.result!)
		const encrypted = base64UrlToBytes(await object!.text())
		expect(
			JSON.parse(
				new TextDecoder().decode(
					await kms.decrypt(encrypted, {
						userId: 'alice',
						namespace: 'default',
					}),
				),
			),
		).toEqual({ ok: true, value: 'elapsed' })
		await expect(
			kms.decrypt(encrypted, { userId: 'bob', namespace: 'default' }),
		).rejects.toThrow(Error)
	} finally {
		await server.close()
	}
})
