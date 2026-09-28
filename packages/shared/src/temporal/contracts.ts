import { type JsonValue } from '../json-safe-value.ts'

/**
 * Package execution is isolated on its own Task Queue so its pollers and
 * concurrency can scale independently from Workflow and coordination work.
 */
export const temporalPackageActivityTaskQueue = 'kody-package-activities'

export const temporalActivityPaths = [
	'/__temporal/v1/jobs/claim',
	'/__temporal/v1/jobs/finalize',
	'/__temporal/v1/packages/resolve',
	'/__temporal/v1/packages/execute',
	'/__temporal/v1/coordinators/stripe-plan-refresh',
	'/__temporal/v1/accounts/cancel',
] as const

export type TemporalActivityPath = (typeof temporalActivityPaths)[number]

export type TemporalCorrelation = {
	workflowId: string
	temporalRunId?: string
	jobId?: string
	runRef?: string
	userHash: string
}

export type JobOccurrenceTrigger = 'scheduled' | 'run-now' | 'backfill'

export type JobOccurrenceWorkflowInput = TemporalCorrelation & {
	jobId: string
	runRef: string
	scheduledFor: string
	trigger: JobOccurrenceTrigger
}

export type JobOccurrenceClaimResult = {
	claimed: boolean
	claimRef?: string
	reason?: 'already-completed' | 'not-runnable' | 'claim-held'
}

export type ResolveJobExecutionPlanRequest = TemporalCorrelation & {
	jobId: string
	runRef: string
	claimRef: string
}

export type ResolveJobExecutionPlanResult = {
	executionPlanRef: string
}

export type ExecuteJobPackageRequest = TemporalCorrelation & {
	jobId: string
	runRef: string
	claimRef: string
	executionPlanRef: string
}

export type ExecuteJobPackageResult = {
	status: 'succeeded' | 'failed'
	finishedAt: string
	resultRef: string
	errorCode?: string
}

export type FinalizeJobOccurrenceResult = {
	finalized: boolean
}

export type JobOccurrenceWorkflowResult = {
	status: 'succeeded' | 'failed' | 'skipped'
	resultRef?: string
	reason?: string
}

export type DynamicPackageWorkflowInput = TemporalCorrelation & {
	workflowRunId: string
	sourceRef: string
	requestedRunAt: string
	idempotencyKey: string
	callerContextRef: string
}

export type ExecuteDynamicPackageRequest = TemporalCorrelation & {
	workflowRunId: string
	sourceRef: string
	callerContextRef: string
	invocationIdempotencyKey: string
	activityAttempt?: number
}

export type ExecuteDynamicPackageResult = {
	status: 'succeeded'
	finishedAt: string
	resultRef: string
}

export type DynamicPackageWorkflowResult = {
	status: 'succeeded'
	resultRef: string
}

export type StripePlanRefreshWorkflowInput = TemporalCorrelation & {
	coordinatorRef: string
	refreshAt: string
}

export type StripePlanRefreshActivityInput = StripePlanRefreshWorkflowInput

export type StripePlanRefreshRequest = StripePlanRefreshActivityInput & {
	temporalRunId: string
}

export type StripePlanRefreshResult = {
	status: 'refreshed' | 'skipped'
	reason?: 'already-refreshed' | 'account-deleting' | 'account-not-found'
}

export type StripePlanRefreshWorkflowResult = StripePlanRefreshResult

export type ClaimJobRequest = TemporalCorrelation & {
	jobId: string
	runRef: string
	scheduledFor: string
	trigger: JobOccurrenceTrigger
}

export type FinalizeJobRequest = TemporalCorrelation & {
	jobId: string
	runRef: string
	claimRef: string
	status: 'succeeded' | 'failed' | 'cancelled'
	scheduledFor: string
	finishedAt: string
	resultRef?: string
	errorCode?: string
}

export type ResolvePackageRequest = TemporalCorrelation & {
	sourceRef: string
}

export type ExecutePackageRequest = TemporalCorrelation & {
	executionPlanRef: string
}

export type TemporalResolveRequest =
	| ResolvePackageRequest
	| ResolveJobExecutionPlanRequest

export type TemporalExecuteRequest =
	| ExecutePackageRequest
	| ExecuteJobPackageRequest
	| ExecuteDynamicPackageRequest

export type CancelAccountRequest = TemporalCorrelation & {
	reason: 'account-deletion' | 'operator'
}

export type TemporalActivityRequestByPath = {
	'/__temporal/v1/jobs/claim': ClaimJobRequest
	'/__temporal/v1/jobs/finalize': FinalizeJobRequest
	'/__temporal/v1/packages/resolve': TemporalResolveRequest
	'/__temporal/v1/packages/execute': TemporalExecuteRequest
	'/__temporal/v1/coordinators/stripe-plan-refresh': StripePlanRefreshRequest
	'/__temporal/v1/accounts/cancel': CancelAccountRequest
}

export type TemporalActivityResponse = {
	ok: true
	correlation: TemporalCorrelation
	result: JsonValue
}

export type TemporalGatewayStartRequest = {
	workflowType:
		| 'temporalFoundationWorkflow'
		| 'jobOccurrenceWorkflow'
		| 'dynamicPackageWorkflow'
		| 'stripePlanRefreshWorkflow'
	workflowId: string
	taskQueue: string
	input:
		| ResolvePackageRequest
		| JobOccurrenceWorkflowInput
		| DynamicPackageWorkflowInput
		| StripePlanRefreshWorkflowInput
}

export type TemporalGatewaySignalWithStartRequest = {
	workflowType: 'stripePlanRefreshWorkflow'
	workflowId: string
	taskQueue: string
	input: StripePlanRefreshWorkflowInput
	signalName: 'rescheduleStripePlanRefresh'
	signalArgs: [refreshAt: string]
}

export type TemporalGatewayCancelRequest = {
	workflowId: string
	reason: string
}

export type TemporalGatewayWorkflowDescription = {
	workflowId: string
	runId: string
	workflowType: string
	status: string
	startedAt: string
	closedAt?: string
}

export type TemporalGatewayReconciliationRequest = {
	workflowType: 'dynamicPackageWorkflow'
	limit: number
}

export type TemporalGatewayReconciliationExecution = {
	workflowId: string
	workflowType: 'dynamicPackageWorkflow'
	status: string
	startedAt: string
	closedAt?: string
	userHash?: string
	workflowRunId?: string
	callerContextRef?: string
}

export type TemporalGatewayReconciliationResponse = {
	executions: Array<TemporalGatewayReconciliationExecution>
	truncated: boolean
}
