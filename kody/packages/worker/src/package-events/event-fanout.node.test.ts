import { WorkflowFailedError } from '@temporalio/client'
import { expect, test, vi } from 'vitest'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import type * as PackageInvocations from '#worker/package-invocations/service.ts'
import type * as PackageRegistry from '#worker/package-registry/repo.ts'
import { type PackageEventsDispatchQueueMessage } from './dispatch-queue-producer.ts'

const mocks = vi.hoisted(() => ({
	listPackageEventSubscribers: vi.fn(),
	deliverPackageEventToSubscriber: vi.fn(),
	getSavedPackageById: vi.fn(),
}))

vi.mock('#worker/package-invocations/subscription-dispatch.ts', () => ({
	listPackageEventSubscribers: mocks.listPackageEventSubscribers,
}))
vi.mock('#worker/package-invocations/service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageInvocations>()),
	deliverPackageEventToSubscriber: mocks.deliverPackageEventToSubscriber,
}))
vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageRegistry>()),
	getSavedPackageById: mocks.getSavedPackageById,
}))

const { startPackageEventFanout } = await import('./dispatch-queue-producer.ts')
const { createAppActivities } =
	await import('#worker/temporal/activities/app.ts')

const message: PackageEventsDispatchQueueMessage = {
	userId: 'user-123',
	topic: '@kentcdodds/discord.message.created',
	idempotencyKey: 'discord:message-create:123',
	payload: { messageId: '123' },
	source: { packageId: 'pkg-gateway', kodyId: 'discord-gateway' },
	invokeDepth: 1,
}

const subscriber = (id: string) => ({
	savedPackage: { id, kodyId: `${id}-kody`, userId: 'user-123' },
	subscription: { topic: message.topic, handler: `./on-${id}` },
})

test('package events fan out to one invocation per subscriber; handler failures are final, infrastructure failures retry', async () => {
	const temporal = await createTemporalEnv({ timeSkipping: true })
	try {
		const env = {
			APP_DB: {},
			APP_BASE_URL: 'https://kody.dev',
			TEMPORAL: temporal.temporal,
		} as unknown as Env
		await temporal.startWorkers({ activities: createAppActivities(env) })
		mocks.listPackageEventSubscribers.mockResolvedValue([
			subscriber('ok'),
			subscriber('failing'),
			subscriber('flaky'),
		])
		mocks.getSavedPackageById.mockImplementation(
			async (_db: unknown, input: { packageId: string }) =>
				subscriber(input.packageId).savedPackage,
		)
		let flakyAttempts = 0
		mocks.deliverPackageEventToSubscriber.mockImplementation(
			async (input: { savedPackage: { id: string }; handler: string }) => {
				const delivery = (status: string, retryableCode: string | null) => ({
					retryableCode,
					subscriber: {
						packageId: input.savedPackage.id,
						handler: input.handler,
						status,
						...(status === 'failed'
							? { error: { code: 'boom', message: 'handler threw' } }
							: {}),
					},
				})
				if (input.savedPackage.id === 'failing') {
					return delivery('failed', null)
				}
				if (input.savedPackage.id === 'flaky' && flakyAttempts++ === 0) {
					return delivery('failed', 'idempotency_persistence_failed')
				}
				return delivery('completed', null)
			},
		)

		const started = await startPackageEventFanout(env, message)
		expect(started.outcome).toBe('started')
		expect((await startPackageEventFanout(env, message)).outcome).toBe(
			'duplicate',
		)
		const result = (await temporal.client.workflow
			.getHandle(started.workflowId)
			.result()) as { runs: Array<unknown> }
		expect(result.runs).toEqual([
			{ runId: expect.any(String), ok: true, output: 'completed' },
			{ runId: expect.any(String), ok: false, error: 'handler threw' },
			{ runId: expect.any(String), ok: true, output: 'completed' },
		])
		// The infrastructure failure retried in place; the handler failure did not.
		expect(flakyAttempts).toBe(2)
		expect(mocks.deliverPackageEventToSubscriber).toHaveBeenCalledTimes(4)
		expect(mocks.deliverPackageEventToSubscriber).toHaveBeenCalledWith(
			expect.objectContaining({
				message,
				handler: './on-ok',
				savedPackage: expect.objectContaining({ id: 'ok' }),
			}),
		)

		const malformed = await temporal.client.workflow.start('EventFanout', {
			taskQueue: 'platform',
			workflowId: 'malformed:event',
			args: [{ ...message, eventId: 'malformed', detail: { topic: ' ' } }],
		})
		await expect(malformed.result()).rejects.toBeInstanceOf(WorkflowFailedError)
	} finally {
		await temporal.close()
	}
})
