import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cancellationSignal, heartbeat } from '@temporalio/activity'
import { temporalPackageActivityTaskQueue } from '@kody-internal/shared/temporal/contracts.ts'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { expect, test, vi } from 'vitest'

const workflowsPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../src/workflows/index.ts',
)

function workflowInput(runAt: string) {
	return {
		workflowId: 'pkgwf-opaque-1',
		userHash: 'opaque-user-hash',
		workflowRunId: 'dynwf-opaque-1',
		sourceRef: `artifact:workflow-source.${'a'.repeat(32)}@${'b'.repeat(64)}`,
		requestedRunAt: runAt,
		idempotencyKey: 'opaque-idempotency-key',
		callerContextRef: `artifact:workflow-caller.${'a'.repeat(32)}@${'c'.repeat(64)}`,
	}
}

test.skipIf(process.platform === 'win32')(
	'timer survives Worker replacement and the completed history replays',
	async () => {
		const testEnv = await TestWorkflowEnvironment.createTimeSkipping()
		const taskQueue = `dynamic-package-recovery-${crypto.randomUUID()}`
		const executeDynamicPackageSandbox = vi.fn(async () => ({
			ok: true as const,
			correlation: {
				workflowId: 'pkgwf-opaque-1',
				userHash: 'opaque-user-hash',
			},
			result: {
				status: 'succeeded' as const,
				finishedAt: '2026-09-23T00:01:00.000Z',
				resultRef: 'workflow:dynwf-opaque-1',
			},
		}))
		let activityWorker: Worker | undefined
		let activityRun: Promise<void> | undefined
		try {
			activityWorker = await Worker.create({
				connection: testEnv.nativeConnection,
				taskQueue: temporalPackageActivityTaskQueue,
				activities: { executeDynamicPackageSandbox },
			})
			activityRun = activityWorker.run()
			const firstWorker = await Worker.create({
				connection: testEnv.nativeConnection,
				taskQueue,
				workflowsPath,
				maxCachedWorkflows: 0,
			})
			const firstRun = firstWorker.run()
			const handle = await testEnv.client.workflow.start(
				'dynamicPackageWorkflow',
				{
					taskQueue,
					workflowId: `dynamic-package-${crypto.randomUUID()}`,
					args: [
						workflowInput(new Date(Date.now() + 60 * 60_000).toISOString()),
					],
				},
			)
			await new Promise((resolve) => setTimeout(resolve, 100))
			firstWorker.shutdown()
			await firstRun

			const replacementWorker = await Worker.create({
				connection: testEnv.nativeConnection,
				taskQueue,
				workflowsPath,
			})
			await replacementWorker.runUntil(async () => {
				await expect(handle.result()).resolves.toEqual({
					status: 'succeeded',
					resultRef: 'workflow:dynwf-opaque-1',
				})
			})
			expect(executeDynamicPackageSandbox).toHaveBeenCalledOnce()
			expect(executeDynamicPackageSandbox).toHaveBeenCalledWith(
				expect.objectContaining({
					invocationIdempotencyKey: 'opaque-idempotency-key',
				}),
			)
			const history = await handle.fetchHistory()
			await expect(
				Worker.runReplayHistory({ workflowsPath }, history, handle.workflowId),
			).resolves.toBeUndefined()
		} finally {
			activityWorker?.shutdown()
			await activityRun
			await testEnv.teardown()
		}
	},
)

test.skipIf(process.platform === 'win32')(
	'cancellation reaches a heartbeat-aware sandbox Activity',
	async () => {
		const testEnv = await TestWorkflowEnvironment.createTimeSkipping()
		const taskQueue = `dynamic-package-cancel-${crypto.randomUUID()}`
		let activityStarted!: () => void
		let activityCancelled!: () => void
		const started = new Promise<void>((resolveStarted) => {
			activityStarted = resolveStarted
		})
		const cancelled = new Promise<void>((resolveCancelled) => {
			activityCancelled = resolveCancelled
		})
		const executeDynamicPackageSandbox = async () => {
			activityStarted()
			const signal = cancellationSignal()
			const heartbeatTimer = setInterval(() => heartbeat('executing'), 10)
			try {
				return await new Promise<never>((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							activityCancelled()
							reject(signal.reason)
						},
						{ once: true },
					)
				})
			} finally {
				clearInterval(heartbeatTimer)
			}
		}
		let activityWorker: Worker | undefined
		let activityRun: Promise<void> | undefined
		try {
			activityWorker = await Worker.create({
				connection: testEnv.nativeConnection,
				taskQueue: temporalPackageActivityTaskQueue,
				activities: { executeDynamicPackageSandbox },
				maxHeartbeatThrottleInterval: '100 ms',
			})
			activityRun = activityWorker.run()
			const worker = await Worker.create({
				connection: testEnv.nativeConnection,
				taskQueue,
				workflowsPath,
			})
			await worker.runUntil(async () => {
				const handle = await testEnv.client.workflow.start(
					'dynamicPackageWorkflow',
					{
						taskQueue,
						workflowId: `dynamic-package-${crypto.randomUUID()}`,
						args: [workflowInput(new Date().toISOString())],
					},
				)
				await started
				await handle.cancel()
				await expect(handle.result()).rejects.toThrow(
					'Workflow execution cancelled',
				)
				await cancelled
			})
		} finally {
			activityWorker?.shutdown()
			await activityRun
			await testEnv.teardown()
		}
	},
)
