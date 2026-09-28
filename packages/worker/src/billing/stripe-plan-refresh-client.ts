import {
	AccountDeletionInProgressError,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import { buildStripePlanRefreshWorkflowId } from '@kody-internal/shared/temporal/identifiers.ts'
import {
	cancelTemporalWorkflow,
	signalWithStartStripePlanRefreshWorkflow,
	TemporalGatewayError,
} from '#worker/temporal/client.ts'
import {
	deleteStripePlanRefreshArtifact,
	storeStripePlanRefreshArtifact,
} from '#worker/temporal/stripe-plan-refresh-artifact.ts'

export const stripePlanRefreshBackstopDelayMs = 60 * 60 * 1000

type StripePlanRefreshEnv = Env & {
	TEMPORAL_GATEWAY_URL?: string
	TEMPORAL_GATEWAY_SIGNING_KEYS?: string
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

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
		const temporalEnv = input.env as StripePlanRefreshEnv
		if (!temporalEnv.BUNDLE_ARTIFACTS_KV) {
			throw new Error('Missing BUNDLE_ARTIFACTS_KV binding.')
		}
		await withAccountWriteLease({
			db: input.env.APP_DB,
			stableUserId: userId,
			holder: 'stripe_plan_refresh_temporal_schedule',
			env: input.env,
			write: async () => {
				const workflowId = await buildStripePlanRefreshWorkflowId(userId)
				const artifact = await storeStripePlanRefreshArtifact({
					kv: temporalEnv.BUNDLE_ARTIFACTS_KV!,
					userId,
				})
				await signalWithStartStripePlanRefreshWorkflow({
					env: temporalEnv,
					workflowId,
					request: {
						workflowId,
						userHash: artifact.userHash,
						coordinatorRef: artifact.coordinatorRef,
						refreshAt: new Date(refreshAt).toISOString(),
					},
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
	const temporalEnv = input.env as StripePlanRefreshEnv
	const userId = input.userId.trim()
	const errors: Array<unknown> = []
	if (
		temporalEnv.TEMPORAL_GATEWAY_URL?.trim() &&
		temporalEnv.TEMPORAL_GATEWAY_SIGNING_KEYS?.trim()
	) {
		try {
			await cancelTemporalWorkflow({
				env: temporalEnv,
				workflowId: await buildStripePlanRefreshWorkflowId(userId),
				reason: 'account-deletion',
			})
		} catch (error) {
			if (!(error instanceof TemporalGatewayError && error.status === 404)) {
				errors.push(error)
			}
		}
	}
	if (temporalEnv.BUNDLE_ARTIFACTS_KV) {
		try {
			await deleteStripePlanRefreshArtifact({
				kv: temporalEnv.BUNDLE_ARTIFACTS_KV,
				userId,
			})
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, 'Stripe plan refresh purge failed.')
	}
	return { purged: true }
}
