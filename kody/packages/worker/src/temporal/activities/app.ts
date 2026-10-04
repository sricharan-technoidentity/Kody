import { ApplicationFailure } from '@temporalio/common'
import {
	getAccountEnv,
	getAccountWriterFactory,
} from '#worker/identity/token-owner-db.ts'
import { createMailActivities } from '../mail-activities.ts'
import { createPackageWorkflowActivities } from '../package-workflow-activities.ts'
import { createAppCatalogActivities } from './catalog.ts'
import { createRepoSessionActivities } from './repo-session.ts'
import { getRepoSessionById } from '#worker/repo/repo-sessions.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { processCommunityActivityDispatchMessage } from '#worker/community/activity-dispatch-queue.ts'
import { processCommunityListingPublishedDispatchMessage } from '#worker/community/listing-published-dispatch-queue.ts'
import { processEmailDeliveryMessage } from '#worker/email/delivery-queue.ts'
import { parsePackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import { deliverPackageEventToSubscriber } from '#worker/package-invocations/service.ts'
import { listPackageEventSubscribers } from '#worker/package-invocations/subscription-dispatch.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { runOAuthPurgeStep } from '#worker/oauth-purge.ts'
import { runScheduledLaneWithFailureIsolation } from '#worker/scheduled/scheduled-lanes.ts'
import { isScheduledLaneName } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { processPlatformFeedbackDispatchMessage } from '#worker/platform-feedback/dispatch-queue.ts'
import { processArtifactsRepoEventMessage } from '#worker/repo/artifacts-event-queue.ts'
import { handleWebhookDispatchMessage } from '#worker/webhooks/dispatch-queue.ts'
import { parseWebhookDispatchQueueMessage } from '#worker/webhooks/dispatch-queue-producer.ts'
import {
	type KodyActivities,
	type PackageInvocationInput,
	type QueueMessageInput,
	type RunOutcome,
} from './types.ts'

/** Work a consumer handed to `waitUntil`, finished inside the activity. */
async function withBackgroundWork<T>(
	run: (waitUntil: (promise: Promise<unknown>) => void) => Promise<T>,
) {
	const pending: Array<Promise<unknown>> = []
	try {
		return await run((promise) => pending.push(promise))
	} finally {
		await Promise.allSettled(pending)
	}
}

function requestRetry(reason: string): never {
	// A plain error is retryable under the workflow's retry policy.
	throw new Error(`Retry requested: ${reason}.`)
}

function malformed(what: string): never {
	throw ApplicationFailure.nonRetryable(`Malformed ${what}.`, 'MalformedDetail')
}

async function deliverPackageEvent(
	env: Env,
	input: PackageInvocationInput,
): Promise<RunOutcome> {
	const message = parsePackageEventsDispatchQueueMessage(input.detail)
	if (!message) malformed('package event')
	const savedPackage = await getSavedPackageById(env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		return {
			runId: input.invocationKey,
			ok: false,
			error: 'The subscriber package no longer exists.',
		}
	}
	const delivery = await withBackgroundWork((waitUntil) =>
		deliverPackageEventToSubscriber({
			env,
			baseUrl: getAppBaseUrl({ env }),
			message,
			savedPackage,
			handler: input.exportName ?? '',
			waitUntil,
		}),
	)
	if (delivery.retryableCode) requestRetry(delivery.retryableCode)
	const { subscriber } = delivery
	return subscriber.status === 'failed'
		? {
				runId: input.invocationKey,
				ok: false,
				error: subscriber.error?.message ?? 'Subscriber failed.',
			}
		: { runId: input.invocationKey, ok: true, output: subscriber.status }
}

/**
 * The production activity set: the existing consumers and dispatchers,
 * now run by Temporal instead of Queues, alarms and cron.
 */
// P7 binds the account writer factory and operator roles used by these activities.
export function createAppActivities(baseEnv: Env) {
	const env = baseEnv
	return {
		...createRepoSessionActivities({
			service(userId, sessionId) {
				const services = getAccountEnv(baseEnv, userId).REPO_SESSION_SERVICES
				if (!services)
					throw ApplicationFailure.nonRetryable(
						'REPO_SESSION_SERVICES is not configured.',
					)
				return services(userId, sessionId)
			},
			row(userId, sessionId) {
				return getRepoSessionById(getAccountEnv(baseEnv, userId), {
					userId,
					sessionId,
				})
			},
		}),
		...createPackageWorkflowActivities(env),
		...createMailActivities({
			env,
			forUser: (userId) => getAccountEnv(baseEnv, userId),
		}),
		...createAppCatalogActivities({
			async forUser(userId) {
				if (!getAccountWriterFactory(env))
					throw new Error(
						'Missing scoped database factory for catalog activity.',
					)
				return getAccountEnv(env, userId)
			},
		}),
		async refreshStripePlan(input) {
			const env = getAccountEnv(baseEnv, input.userId)
			const { withAccountWriteLease, AccountDeletionInProgressError } =
				await import('#worker/account/deletion-state.ts')
			const { refreshStripePlanForUser } =
				await import('#worker/billing/subscription-sync.ts')
			const user = await env.APP_DB.prepare(
				'SELECT id, stripe_customer_id FROM users WHERE stable_user_id = ?',
			)
				.bind(input.userId)
				.first<{ id: number; stripe_customer_id: string | null }>()
			if (!user?.stripe_customer_id) return
			try {
				await withAccountWriteLease({
					db: env.APP_DB,
					stableUserId: input.userId,
					env,
					holder: 'stripe_plan_refresh',
					write: async () => {
						await refreshStripePlanForUser({
							env,
							userId: user.id,
							customerId: user.stripe_customer_id!,
						})
					},
				})
			} catch (error) {
				if (!(error instanceof AccountDeletionInProgressError)) throw error
			}
		},
		async rearmJobSchedules(input) {
			const { syncJobManagerAlarm } =
				await import('#worker/jobs/manager-client.ts')
			await syncJobManagerAlarm({ env: baseEnv, userId: input.userId })
		},
		async runJob(input) {
			const env = getAccountEnv(baseEnv, input.userId)
			const { runJobNow, runDueJobsForUser } =
				await import('#worker/jobs/service.ts')
			const { syncJobManagerAlarm } =
				await import('#worker/jobs/manager-client.ts')
			return withBackgroundWork(async (waitUntil) => {
				if (input.scheduledAt !== null) {
					const result = await runDueJobsForUser({
						env,
						userId: input.userId,
						jobId: input.jobId,
						waitUntil,
					})
					await syncJobManagerAlarm({ env, userId: input.userId })
					return result.errorCount > 0
						? {
								runId: input.jobId,
								ok: false,
								error: result.jobOutcomes[0]?.error ?? 'Job failed.',
							}
						: { runId: input.jobId, ok: true, output: JSON.stringify(result) }
				}
				const result = await runJobNow({ env, ...input, waitUntil })
				await syncJobManagerAlarm({ env, userId: input.userId })
				return { runId: input.jobId, ok: true, output: JSON.stringify(result) }
			})
		},
		async runScheduledLane(input) {
			if (!isScheduledLaneName(input.lane)) malformed('lane name')
			const outcome = await runScheduledLaneWithFailureIsolation({
				env,
				message: {
					lane: input.lane,
					scheduledTime: Date.parse(input.scheduledAt),
					cron: input.cron,
				},
			})
			if (outcome === 'd1_lock_contention') requestRetry('lock contention')
			return outcome
		},

		async oauthPurgeStep(input) {
			return runOAuthPurgeStep({ kv: env.OAUTH_KV, ...input })
		},

		async processQueueMessage(input: QueueMessageInput) {
			const outcome = await withBackgroundWork(async (waitUntil) => {
				switch (input.queue) {
					case 'platform-feedback-dispatch':
						return processPlatformFeedbackDispatchMessage(input.body, env)
					case 'community-activity-dispatch':
						return processCommunityActivityDispatchMessage(input.body, env)
					case 'community-listing-published-dispatch':
						return processCommunityListingPublishedDispatchMessage(
							input.body,
							env,
						)
					case 'email-delivery':
						return processEmailDeliveryMessage(input.body, env, waitUntil)
					case 'artifacts-repo-events':
						return processArtifactsRepoEventMessage(input.body, env, waitUntil)
				}
			})
			if (outcome === 'retry') requestRetry(input.queue)
		},

		async listEventSubscribers(event) {
			const message = parsePackageEventsDispatchQueueMessage(event.detail)
			if (!message || message.userId !== event.userId)
				malformed('package event')
			const env = getAccountEnv(baseEnv, message.userId)
			const subscriptions = await listPackageEventSubscribers({
				env,
				baseUrl: getAppBaseUrl({ env }),
				message,
			})
			return subscriptions.map(({ savedPackage, subscription }) => ({
				userId: message.userId,
				packageId: savedPackage.id,
				exportName: subscription.handler,
				detail: message,
			}))
		},

		async invokePackage(input) {
			const env = getAccountEnv(baseEnv, input.userId)
			switch (input.surface) {
				case 'subscription':
					return deliverPackageEvent(env, input)
				case 'webhook': {
					const message = parseWebhookDispatchQueueMessage(input.detail)
					if (!message || message.endpoint.userId !== input.userId)
						malformed('webhook delivery')
					const outcome = await handleWebhookDispatchMessage(message, env)
					if (outcome === 'retry') requestRetry('webhook delivery')
					// The delivery row (`recordWebhookDelivery`) holds the result.
					return { runId: message.deliveryId, ok: true, output: 'recorded' }
				}
				default:
					throw ApplicationFailure.nonRetryable(
						`No production invocation path for surface "${input.surface}".`,
					)
			}
		},
	} satisfies Partial<KodyActivities>
}
