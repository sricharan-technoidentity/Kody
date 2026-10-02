import { type RunLogAdminInsightsSnapshot } from './admin-insights-snapshot.ts'
import {
	type ActivationMilestoneRecord,
	type PackageRunSuccessRecord,
} from './package-activation-state.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
	type WorkflowProjectionReserveResult,
} from './workflow-projection.ts'
import {
	type RunRecord,
	type RunRecordLog,
	type RunRecordPage,
	type RunRecordSummary,
	type RunSurface,
} from './types.ts'
import {
	type RunLogRowInput,
	type RunLogEntryInput,
	type ListRunsInput,
	type UpdateRunErrorTriageInput,
	type UpdateRunErrorTriageResult,
	type BulkUpdateRunErrorTriageInput,
	type BulkUpdateRunErrorTriageResult,
} from './run-log-types.ts'
export type {
	RunLogRowInput,
	RunLogEntryInput,
	BulkUpdateRunErrorTriageFilter,
	BulkUpdateRunErrorTriageResult,
} from './run-log-types.ts'
export type PackageInvocationLedgerStatus =
	| 'in_progress'
	| 'completed'
	| 'failed'

/**
 * One keyed package-invocation idempotency row. Same shape as the legacy D1
 * `package_invocations` table minus `user_id` — the DynamoDB partition identifies the owner.
 */
export type PackageInvocationLedgerRecord = {
	id: string
	tokenId: string
	packageId: string
	packageKodyId: string
	exportName: string
	idempotencyKey: string
	requestHash: string
	source: string | null
	topic: string | null
	status: PackageInvocationLedgerStatus
	/** Bounded replay cache; `null` when the terminal response was oversized. */
	responseJson: string | null
	createdAt: string
	updatedAt: string
}

export type PackageInvocationLedgerKey = {
	tokenId: string
	packageId: string
	exportName: string
	idempotencyKey: string
}

export type PackageInvocationClaimInput = PackageInvocationLedgerKey & {
	id: string
	packageKodyId: string
	requestHash: string
	source: string | null
	topic: string | null
}

export type PackageInvocationClaimResult =
	| {
			outcome: 'claimed'
			invocationId: string
			claimUpdatedAt: string
			/** True when a stale `in_progress` row was taken over in place. */
			reclaimed: boolean
	  }
	| { outcome: 'existing'; record: PackageInvocationLedgerRecord }

type ExportRunsInput = {
	pageSize: number
	startAfter?: string | null
}

export type ExportRunsResult = {
	runs: Array<RunRecord>
	logs: Array<RunRecordLog>
	packageInvocations: Array<PackageInvocationLedgerRecord>
	workflowProjections: Array<WorkflowProjectionRecord>
	jobRunObservability: Array<JobRunObservabilityRecord>
	packageRunSuccesses: Array<PackageRunSuccessRecord>
	activationMilestones: Array<ActivationMilestoneRecord>
	nextStartAfter: string | null
	truncated: boolean
}

type WorkflowProjectionListInput = {
	limit: number
	cursor?: string | null
	status?: string | null
	bindingName?: string | null
}

export type RunLogRpc = {
	startRun: (input: { run: RunLogRowInput }) => Promise<{ ok: true }>
	claimRun: (input: { run: RunLogRowInput }) => Promise<{
		claimed: boolean
		run: RunRecord
	}>
	finishRun: (input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}) => Promise<{ ok: true }>
	listRuns: (input: ListRunsInput) => Promise<RunRecordPage>
	updateRunErrorTriage: (
		input: UpdateRunErrorTriageInput,
	) => Promise<UpdateRunErrorTriageResult>
	bulkUpdateRunErrorTriage: (
		input: BulkUpdateRunErrorTriageInput,
	) => Promise<BulkUpdateRunErrorTriageResult>
	getRun: (input: {
		runId: string
	}) => Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null>
	getRunByIdempotencyKey: (input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}) => Promise<RunRecord | null>
	deleteRunIfRunning: (input: {
		runId: string
	}) => Promise<{ deleted: boolean }>
	claimPackageInvocation: (input: {
		invocation: PackageInvocationClaimInput
		staleBefore: string
		run: RunLogRowInput | null
		initialLogs?: Array<RunLogEntryInput>
	}) => Promise<PackageInvocationClaimResult>
	getPackageInvocation: (
		input: PackageInvocationLedgerKey,
	) => Promise<PackageInvocationLedgerRecord | null>
	finishPackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
		status: 'completed' | 'failed'
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}) => Promise<{
		ledgerUpdated: boolean
		record: PackageInvocationLedgerRecord | null
	}>
	releasePackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
		runId: string | null
	}) => Promise<{
		released: boolean
		record: PackageInvocationLedgerRecord | null
	}>
	upsertWorkflowProjection: (
		input: WorkflowProjectionUpsertInput,
	) => Promise<{ ok: true }>
	getWorkflowProjection: (input: {
		id: string
	}) => Promise<WorkflowProjectionRecord | null>
	findWorkflowProjectionByIdempotencyKey: (input: {
		idempotencyKey: string
		bindingName?: string | null
	}) => Promise<WorkflowProjectionRecord | null>
	findWorkflowProjectionByBindingIdempotencyKey: (input: {
		bindingName: string
		idempotencyKey: string
	}) => Promise<WorkflowProjectionRecord | null>
	listWorkflowProjections: (input: WorkflowProjectionListInput) => Promise<{
		projections: Array<WorkflowProjectionRecord>
		nextCursor: string | null
	}>
	countActiveWorkflowProjections: () => Promise<{ count: number }>
	reserveWorkflowProjectionSlot: (
		input: WorkflowProjectionUpsertInput,
	) => Promise<WorkflowProjectionReserveResult>
	deleteWorkflowProjectionIfCreating: (input: {
		id: string
	}) => Promise<{ deleted: boolean }>
	upsertJobRunObservability: (
		input: JobRunObservabilityUpsertInput,
	) => Promise<JobRunObservabilityRecord>
	getJobRunObservability: (input: {
		jobId: string
	}) => Promise<JobRunObservabilityRecord | null>
	getJobRunObservabilityBatch: (input: {
		jobIds: Array<string>
	}) => Promise<Array<JobRunObservabilityRecord>>
	getAdminInsightsSnapshot: () => Promise<RunLogAdminInsightsSnapshot>
	listPackageRunSuccesses: () => Promise<Array<PackageRunSuccessRecord>>
	listActivationMilestones: () => Promise<Array<ActivationMilestoneRecord>>
	summarize: (input: { since: string }) => Promise<RunRecordSummary>
	listStorageIds: () => Promise<Array<string>>
	exportRuns: (input: ExportRunsInput) => Promise<ExportRunsResult>
	clearAll: () => Promise<{ ok: true }>
}

export type InvocationLedgerRpc = Pick<
	RunLogRpc,
	| 'claimPackageInvocation'
	| 'getPackageInvocation'
	| 'finishPackageInvocation'
	| 'releasePackageInvocation'
> & {
	list(): Promise<Array<PackageInvocationLedgerRecord>>
	clear(): Promise<void>
}
export type InvocationLedger = { forUser(userId: string): InvocationLedgerRpc }
export type RunStateRpc = Pick<
	RunLogRpc,
	| 'claimPackageInvocation'
	| 'getPackageInvocation'
	| 'finishPackageInvocation'
	| 'releasePackageInvocation'
	| 'upsertWorkflowProjection'
	| 'getWorkflowProjection'
	| 'findWorkflowProjectionByIdempotencyKey'
	| 'findWorkflowProjectionByBindingIdempotencyKey'
	| 'listWorkflowProjections'
	| 'countActiveWorkflowProjections'
	| 'reserveWorkflowProjectionSlot'
	| 'deleteWorkflowProjectionIfCreating'
> & {
	exportState(): Promise<{
		packageInvocations: Array<PackageInvocationLedgerRecord>
		workflowProjections: Array<WorkflowProjectionRecord>
	}>
	clear(): Promise<void>
}
export type RunState = { forUser(userId: string): RunStateRpc }
