import {
	type ClaimJobRequest,
	type DynamicPackageWorkflowInput,
	type DynamicPackageWorkflowResult,
	type ExecuteDynamicPackageRequest,
	type ExecuteDynamicPackageResult,
	type ExecuteJobPackageRequest,
	type ExecuteJobPackageResult,
	type FinalizeJobRequest,
	type FinalizeJobOccurrenceResult,
	type JobOccurrenceClaimResult,
	type JobOccurrenceWorkflowInput,
	type JobOccurrenceWorkflowResult,
	type ResolvePackageRequest,
	type ResolveJobExecutionPlanRequest,
	type ResolveJobExecutionPlanResult,
	type StripePlanRefreshActivityInput,
	type StripePlanRefreshResult,
	type StripePlanRefreshWorkflowInput,
	type StripePlanRefreshWorkflowResult,
	type TemporalActivityResponse,
	temporalPackageActivityTaskQueue,
} from '@kody-internal/shared/temporal/contracts.ts'
import {
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	condition,
	defineSignal,
	isCancellation,
	proxyActivities,
	setHandler,
	sleep,
	workflowInfo,
} from '@temporalio/workflow'
import type * as activities from '../activities/index.ts'

const { resolvePackageReference, claimJobOccurrence, resolveExecutionPlan } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: '30 seconds',
		retry: {
			initialInterval: '1 second',
			backoffCoefficient: 2,
			maximumAttempts: 5,
			maximumInterval: '10 seconds',
		},
	})

const { executePackageSandbox } = proxyActivities<typeof activities>({
	taskQueue: temporalPackageActivityTaskQueue,
	startToCloseTimeout: '3 minutes',
	heartbeatTimeout: '20 seconds',
	retry: {
		initialInterval: '2 seconds',
		backoffCoefficient: 2,
		maximumAttempts: 5,
		maximumInterval: '30 seconds',
	},
})

const { executeDynamicPackageSandbox } = proxyActivities<typeof activities>({
	taskQueue: temporalPackageActivityTaskQueue,
	startToCloseTimeout: '5 minutes',
	heartbeatTimeout: '20 seconds',
	retry: {
		initialInterval: '2 seconds',
		backoffCoefficient: 2,
		maximumAttempts: 5,
		maximumInterval: '30 seconds',
	},
})

const { finalizeJobOccurrence } = proxyActivities<typeof activities>({
	startToCloseTimeout: '30 seconds',
	retry: {
		initialInterval: '1 second',
		backoffCoefficient: 2,
		maximumAttempts: 10,
		maximumInterval: '30 seconds',
	},
})

const { refreshStripePlan } = proxyActivities<typeof activities>({
	startToCloseTimeout: '1 minute',
	retry: {
		initialInterval: '1 second',
		backoffCoefficient: 2,
		maximumAttempts: 5,
		maximumInterval: '10 seconds',
	},
})

export const rescheduleStripePlanRefreshSignal = defineSignal<[string]>(
	'rescheduleStripePlanRefresh',
)

/**
 * Phase 1 smoke workflow. It proves deterministic workflow bundling and the
 * signed Activity-to-Cloudflare path without routing any user traffic.
 */
export async function temporalFoundationWorkflow(
	input: ResolvePackageRequest,
): Promise<TemporalActivityResponse> {
	return await resolvePackageReference(input)
}

/** Stable no-command workflow used to keep a committed replay canary. */
export function replayFixtureWorkflow() {
	return 'replay-ok'
}

export async function dynamicPackageWorkflow(
	input: DynamicPackageWorkflowInput,
): Promise<DynamicPackageWorkflowResult> {
	const delayMs = Date.parse(input.requestedRunAt) - Date.now()
	if (delayMs > 0) await sleep(delayMs)
	const execution = workflowInfo()
	const response = await executeDynamicPackageSandbox({
		workflowId: execution.workflowId,
		temporalRunId: execution.runId,
		userHash: input.userHash,
		workflowRunId: input.workflowRunId,
		sourceRef: input.sourceRef,
		callerContextRef: input.callerContextRef,
		invocationIdempotencyKey: input.idempotencyKey,
	} satisfies ExecuteDynamicPackageRequest)
	const result = response.result as ExecuteDynamicPackageResult
	return { status: result.status, resultRef: result.resultRef }
}

/**
 * Coalescing one-shot replacement for the per-user StripePlanRefresh alarm.
 * Signals move the due time without creating parallel refresh executions.
 */
export async function stripePlanRefreshWorkflow(
	input: StripePlanRefreshWorkflowInput,
): Promise<StripePlanRefreshWorkflowResult> {
	let refreshAt = input.refreshAt
	let revision = 0
	setHandler(rescheduleStripePlanRefreshSignal, (nextRefreshAt) => {
		refreshAt = nextRefreshAt
		revision += 1
	})

	while (true) {
		const waitingRevision = revision
		const delayMs = Date.parse(refreshAt) - Date.now()
		if (delayMs > 0) {
			const rescheduled = await condition(
				() => revision !== waitingRevision,
				delayMs,
			)
			if (rescheduled) continue
		}

		const executionRevision = revision
		try {
			const response = await refreshStripePlan({
				workflowId: input.workflowId,
				userHash: input.userHash,
				coordinatorRef: input.coordinatorRef,
				refreshAt,
			} satisfies StripePlanRefreshActivityInput)
			if (revision !== executionRevision) continue
			return response.result as StripePlanRefreshResult
		} catch (error) {
			if (isCancellation(error)) throw error
			if (
				error instanceof ActivityFailure &&
				error.cause instanceof ApplicationFailure &&
				error.cause.nonRetryable
			) {
				throw error
			}
			if (revision !== executionRevision) continue
			await condition(() => revision !== executionRevision, '1 hour')
		}
	}
}

function scheduledStartTime(input: JobOccurrenceWorkflowInput) {
	const scheduled =
		workflowInfo().searchAttributes['TemporalScheduledStartTime']?.[0]
	return scheduled instanceof Date
		? scheduled.toISOString()
		: input.scheduledFor
}

/**
 * Durable orchestration for one scheduled job occurrence. Cloudflare owns the
 * claim/finalize fence and the sandbox; Temporal owns retries and cancellation.
 */
export async function jobOccurrenceWorkflow(
	input: JobOccurrenceWorkflowInput,
): Promise<JobOccurrenceWorkflowResult> {
	const execution = workflowInfo()
	const correlation = {
		workflowId: execution.workflowId,
		userHash: input.userHash,
		jobId: input.jobId,
		runRef: execution.workflowId,
	}
	const scheduledFor = scheduledStartTime(input)
	const claimResponse = await claimJobOccurrence({
		...correlation,
		scheduledFor,
		trigger: input.trigger,
	} satisfies ClaimJobRequest)
	const claim = claimResponse.result as JobOccurrenceClaimResult
	if (!claim.claimed || !claim.claimRef) {
		return { status: 'skipped', reason: claim.reason ?? 'not-runnable' }
	}
	const claimRef = claim.claimRef
	let result: ExecuteJobPackageResult
	try {
		const planResponse = await resolveExecutionPlan({
			...correlation,
			claimRef,
		} satisfies ResolveJobExecutionPlanRequest)
		const plan = planResponse.result as ResolveJobExecutionPlanResult
		const executionResponse = await executePackageSandbox({
			...correlation,
			claimRef,
			executionPlanRef: plan.executionPlanRef,
		} satisfies ExecuteJobPackageRequest)
		result = executionResponse.result as ExecuteJobPackageResult
	} catch (error) {
		const cancelled = isCancellation(error)
		await CancellationScope.nonCancellable(async () => {
			await finalizeJobOccurrence({
				...correlation,
				claimRef,
				status: cancelled ? 'cancelled' : 'failed',
				scheduledFor,
				finishedAt: new Date().toISOString(),
				errorCode: cancelled ? 'workflow_cancelled' : 'orchestration_failure',
			} satisfies FinalizeJobRequest)
		})
		if (cancelled) throw error
		return { status: 'failed', reason: 'orchestration-failure' }
	}
	const finalizeResponse = await finalizeJobOccurrence({
		...correlation,
		claimRef,
		status: result.status,
		scheduledFor,
		finishedAt: result.finishedAt,
		resultRef: result.resultRef,
		...(result.errorCode ? { errorCode: result.errorCode } : {}),
	} satisfies FinalizeJobRequest)
	const finalized = finalizeResponse.result as FinalizeJobOccurrenceResult
	if (!finalized.finalized) {
		return { status: 'skipped', reason: 'claim-superseded' }
	}
	return { status: result.status, resultRef: result.resultRef }
}
