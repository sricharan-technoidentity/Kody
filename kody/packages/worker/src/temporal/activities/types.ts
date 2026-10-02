import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type JobRepoCheckPolicy } from '@kody-internal/shared/jobs/types.ts'
import { type CatalogActivities } from './catalog-types.ts'
import { type PackageWorkflowActivities } from '../package-workflow-activities.ts'
/**
 * The activity contract every Kody workflow is written against. Workflows
 * import these types only; implementations are bound per environment
 * (`target.ts` over the AWS ports, production modules over the app `Env`).
 */

export type RunOutcome =
	| { runId: string; ok: true; output: string }
	| { runId: string; ok: false; error: string }

/** Shared path for HTTP exports, webhooks and subscriptions. */
export type PackageInvocationInput = {
	userId: string
	surface: string
	/** Idempotency key within the surface; also the workflow id suffix. */
	invocationKey: string
	packageId: string
	exportName: string | null
	params: Record<string, unknown>
	/** Surface payload a production activity needs (webhook message, event). */
	detail?: unknown
}

export type KodyEvent = {
	userId: string
	topic: string
	eventId: string
	payload: Record<string, unknown>
	/** Producer payload a production activity needs to find subscribers. */
	detail?: unknown
}

export type EventSubscriber = {
	/** Subscriber's owner; admin topics fan out to operator accounts. */
	userId: string
	packageId: string
	exportName: string | null
	detail?: unknown
}

export type WebhookAdmission =
	| { admitted: true }
	| { admitted: false; retryAfterSeconds: number }

export type PublishCheck = 'bundle' | 'typecheck' | 'lint'

export type JobRunInput = {
	userId: string
	jobId: string
	/** Schedule fire time (ISO); `null` for a run-now request. */
	scheduledAt: string | null
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}

/**
 * Former Cloudflare Queues whose consumers keep their own fan-out and
 * cancellation rules; each message is one `QueueMessage` workflow.
 */
export type KodyQueue =
	| 'platform-feedback-dispatch'
	| 'community-activity-dispatch'
	| 'community-listing-published-dispatch'
	| 'email-delivery'
	| 'artifacts-repo-events'

export type QueueMessageInput = { queue: KodyQueue; body: unknown }

export type LaneRunInput = {
	/** A `ScheduledLaneName` (kept a string so workflows import no app code). */
	lane: string
	scheduledAt: string
	cron: string
}

export type LaneOutcome = 'completed' | 'failed'

export type OAuthPurgeStepResult = {
	result: {
		phase: 'grants' | 'tokens'
		checked: number
		grantsPurged: number
		tokensPurged: number
		phaseComplete: boolean
	}
	continuation: unknown
}

export type KodyActivities = CatalogActivities &
	PackageWorkflowActivities & {
		completeWorkflowStart(input: {
			userId: string
			surface: string
			key: string
			runId: string
			result: { ok: true; value: unknown } | { ok: false; error: string }
		}): Promise<void>
		refreshStripePlan(input: { userId: string }): Promise<void>
		/** One maintenance lane; D1/Postgres lock contention throws to retry. */
		runScheduledLane(input: LaneRunInput): Promise<LaneOutcome>
		oauthPurgeStep(input: {
			continuation: unknown
			nowSeconds: number
		}): Promise<OAuthPurgeStepResult>
		/** Throws to retry the message (the consumer's former `retry()`). */
		processQueueMessage(input: QueueMessageInput): Promise<void>
		consumeMeter(input: { userId: string; counter: string }): Promise<void>
		executeCode(input: {
			userId: string
			requestId: string
			runId: string
			code: string
		}): Promise<RunOutcome>
		invokePackage(input: PackageInvocationInput): Promise<RunOutcome>
		listEventSubscribers(event: KodyEvent): Promise<Array<EventSubscriber>>
		admitWebhookDelivery(input: {
			userId: string
			endpointId: string
			deliveryId: string
			rateLimitPerMinute: number
		}): Promise<WebhookAdmission>
		runJob(input: JobRunInput): Promise<RunOutcome>
		rearmJobSchedules(input: { userId: string }): Promise<void>
		runPublishCheck(input: {
			userId: string
			packageId: string
			commit: string
			check: PublishCheck
		}): Promise<{ ok: boolean; output: string }>
		/** Copies the bundle check's output from the interpreter session to S3. */
		storePackageBundle(input: {
			userId: string
			packageId: string
			commit: string
		}): Promise<{ bundleKey: string }>
		reindexPackage(input: {
			userId: string
			packageId: string
			commit: string
		}): Promise<void>
		advancePublishedCommit(input: {
			userId: string
			packageId: string
			commit: string
			bundleKey: string
		}): Promise<void>
	}
