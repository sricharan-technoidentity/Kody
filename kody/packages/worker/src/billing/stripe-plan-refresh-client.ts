import {
	AccountDeletionInProgressError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { WorkflowNotFoundError } from '@temporalio/client'
import { taskQueues, workflowIds } from '#worker/temporal/ids.ts'
import { rescheduleStripeRefresh } from '#worker/temporal/workflows/stripe-plan-refresh.ts'

export const stripePlanRefreshBackstopDelayMs = 60 * 60 * 1000

export async function scheduleStripePlanRefreshBackstop(input: {
	env: Env
	userId: string
	now?: Date
}) {
	const userId = input.userId.trim()
	if (!userId) return false
	try {
		const activityAt = input.now?.getTime() ?? Date.now()
		const refreshAt =
			Math.max(activityAt, Date.now()) + stripePlanRefreshBackstopDelayMs
		await withAccountWriteLease({
			db: input.env.APP_DB,
			stableUserId: userId,
			holder: 'stripe_plan_refresh_schedule',
			env: input.env,
			write: async () => {
				if (!input.env.TEMPORAL)
					throw new Error('Missing TEMPORAL binding for Stripe plan refresh.')
				const client = await input.env.TEMPORAL.client(taskQueues.platform)
				await client.workflow.signalWithStart('StripePlanRefresh', {
					workflowId: workflowIds.stripePlanRefresh(userId),
					taskQueue: taskQueues.platform,
					args: [{ userId, refreshAt }],
					signal: rescheduleStripeRefresh,
					signalArgs: [refreshAt],
				})
			},
		})
		return true
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) return false
		console.error('stripe_plan_refresh_schedule_failed', { userId, error })
		return false
	}
}

export async function purgeStripePlanRefreshForUser(input: {
	env: Env
	userId: string
}) {
	if (!input.env.TEMPORAL) return { purged: false }
	const client = await input.env.TEMPORAL.client(taskQueues.platform)
	try {
		await client.workflow
			.getHandle(workflowIds.stripePlanRefresh(input.userId.trim()))
			.cancel()
	} catch (error) {
		if (!(error instanceof WorkflowNotFoundError)) throw error
	}
	return { purged: true }
}
