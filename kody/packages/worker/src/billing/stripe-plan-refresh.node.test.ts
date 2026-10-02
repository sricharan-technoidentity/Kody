import { expect, test, vi } from 'vitest'
import { createTemporalEnv } from '#worker/test-support/aws/temporal-env.ts'
import { rescheduleStripeRefresh } from '#worker/temporal/workflows/stripe-plan-refresh.ts'

test('Stripe refresh waits for the latest account timer, retries transient failures, and cancellation prevents refresh', async () => {
	const temporal = await createTemporalEnv({ timeSkipping: true })
	try {
		const refreshStripePlan = vi
			.fn()
			.mockRejectedValueOnce(new Error('Stripe unavailable'))
			.mockResolvedValue(undefined)
		await temporal.startWorkers({
			activities: { refreshStripePlan },
			queues: ['platform'],
		})
		const handle = await temporal.client.workflow.start('StripePlanRefresh', {
			workflowId: 'alice:stripe-plan-refresh',
			taskQueue: 'platform',
			args: [{ userId: 'alice', refreshAt: Date.now() + 3_600_000 }],
		})
		await handle.signal(rescheduleStripeRefresh, Date.now() + 7_200_000)
		await handle.result()
		expect(refreshStripePlan).toHaveBeenCalledTimes(2)
		expect(refreshStripePlan).toHaveBeenLastCalledWith({ userId: 'alice' })
		const bob = await temporal.client.workflow.start('StripePlanRefresh', {
			workflowId: 'bob:stripe-plan-refresh',
			taskQueue: 'platform',
			args: [{ userId: 'bob', refreshAt: Date.now() + 3_600_000 }],
		})
		await bob.cancel()
		await expect(bob.result()).rejects.toThrow(Error)
		expect(refreshStripePlan).toHaveBeenCalledTimes(2)
	} finally {
		await temporal.close()
	}
})
