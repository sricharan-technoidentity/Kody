import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { expect, test, vi } from 'vitest'
import { type StripePlanRefreshActivityInput } from '@kody-internal/shared/temporal/contracts.ts'

const workflowsPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../src/workflows/index.ts',
)

test.skipIf(process.platform === 'win32')(
	'reschedule signals coalesce on the latest Stripe refresh due time',
	async () => {
		const testEnv = await TestWorkflowEnvironment.createTimeSkipping()
		const taskQueue = `stripe-plan-refresh-${crypto.randomUUID()}`
		const workflowId = `kody-stripe-plan-refresh-v1:${crypto.randomUUID()}`
		const firstRefreshAt = new Date(Date.now() + 60 * 60_000).toISOString()
		const latestRefreshAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
		const refreshStripePlan = vi.fn(
			async (request: StripePlanRefreshActivityInput) => ({
				ok: true as const,
				correlation: {
					workflowId: request.workflowId,
					userHash: request.userHash,
				},
				result: { status: 'refreshed' as const },
			}),
		)
		try {
			const worker = await Worker.create({
				connection: testEnv.nativeConnection,
				taskQueue,
				workflowsPath,
				activities: { refreshStripePlan },
			})
			await worker.runUntil(async () => {
				const workflowInput = {
					workflowId,
					userHash: 'opaque-user-hash',
					coordinatorRef: `coordinator:stripe-plan-refresh.${'a'.repeat(32)}`,
					refreshAt: firstRefreshAt,
				}
				const handle = await testEnv.client.workflow.signalWithStart(
					'stripePlanRefreshWorkflow',
					{
						workflowId,
						taskQueue,
						args: [workflowInput],
						signal: 'rescheduleStripePlanRefresh',
						signalArgs: [firstRefreshAt],
					},
				)
				await handle.signal('rescheduleStripePlanRefresh', latestRefreshAt)
				await expect(handle.result()).resolves.toEqual({ status: 'refreshed' })
				expect(refreshStripePlan).toHaveBeenCalledOnce()
				expect(refreshStripePlan).toHaveBeenCalledWith(
					expect.objectContaining({ refreshAt: latestRefreshAt }),
				)
				const history = await handle.fetchHistory()
				await expect(
					Worker.runReplayHistory({ workflowsPath }, history, workflowId),
				).resolves.toBeUndefined()
			})
		} finally {
			await testEnv.teardown()
		}
	},
)
