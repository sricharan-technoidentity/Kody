import { buildTemporalUserHash } from '@kody-internal/shared/temporal/identifiers.ts'
import { temporalOpenStatuses } from '@kody-internal/shared/temporal/status.ts'
import { loadTemporalWorkflowOwner } from '#worker/package-runtime/temporal-workflow-artifacts.ts'
import {
	getWorkflowProjection,
	type WorkflowProjectionRecord,
} from '#worker/run-records/service.ts'
import {
	sampleTemporalDynamicPackageWorkflows,
	type TemporalGatewayClientEnv,
} from './client.ts'

export const temporalReconciliationSampleLimit = 250
export const temporalReconciliationConcurrency = 8
export const temporalReconciliationGraceMs = 10 * 60 * 1000

const temporalWorkflowBindingName = 'TEMPORAL_DYNAMIC_PACKAGE_WORKFLOWS'
const terminalRunLogStatuses = new Set([
	'complete',
	'errored',
	'terminated',
	'cancelled',
])

type TemporalReconciliationEnv = Pick<Env, 'BUNDLE_ARTIFACTS_KV' | 'RUN_LOG'> &
	TemporalGatewayClientEnv

export type TemporalWorkflowConcurrencyEvent = {
	userHash: string
	backend: 'temporal'
	current: number
	outcome: 'allowed' | 'throttled' | 'failed'
	limit: number | null
}

export async function recordTemporalWorkflowConcurrency(input: {
	userId: string
	backend: TemporalWorkflowConcurrencyEvent['backend']
	current: number
	outcome: TemporalWorkflowConcurrencyEvent['outcome']
	limit?: number | null
	record?: (event: TemporalWorkflowConcurrencyEvent) => void
}) {
	try {
		const event: TemporalWorkflowConcurrencyEvent = {
			userHash: await buildTemporalUserHash(input.userId),
			backend: input.backend,
			current: Math.max(0, Math.trunc(input.current)),
			outcome: input.outcome,
			limit: input.limit == null ? null : Math.max(0, Math.trunc(input.limit)),
		}
		;(
			input.record ??
			((value) => console.info('temporal_workflow_concurrency', value))
		)(event)
		return event
	} catch {
		console.warn('temporal-workflow-concurrency-observability-failed', {
			backend: input.backend,
			outcome: input.outcome,
		})
		return null
	}
}

type TemporalWorkflowMismatchKind =
	| 'temporal_success_runlog_missing'
	| 'runlog_terminal_temporal_open'

export type TemporalWorkflowMismatchEvent = {
	workflowType: 'dynamicPackageWorkflow'
	kind: TemporalWorkflowMismatchKind
	ageBucket: 'within_grace' | '10m_to_1h' | '1h_to_24h' | 'over_24h'
	alertable: boolean
	temporalStatus: string
	runLogStatus: string | null
	userHash: string
}

export type TemporalWorkflowReconciliationSummary = {
	status: 'ok' | 'skipped'
	reason?: 'not_configured'
	sampled: number
	matched: number
	unattributed: number
	lookupErrors: number
	temporalSuccessRunLogMissing: number
	runLogTerminalTemporalOpen: number
	alertableMismatches: number
	truncated: boolean
}

function ageBucket(ageMs: number): TemporalWorkflowMismatchEvent['ageBucket'] {
	if (ageMs < temporalReconciliationGraceMs) return 'within_grace'
	if (ageMs < 60 * 60 * 1000) return '10m_to_1h'
	if (ageMs < 24 * 60 * 60 * 1000) return '1h_to_24h'
	return 'over_24h'
}

function isTemporalOpen(status: string) {
	const normalized = status.toUpperCase()
	return (
		temporalOpenStatuses.includes(
			normalized as (typeof temporalOpenStatuses)[number],
		) || normalized === 'PAUSED'
	)
}

export function classifyTemporalWorkflowMismatch(input: {
	temporalStatus: string
	temporalStartedAt: string
	temporalClosedAt?: string
	projection: WorkflowProjectionRecord | null
	userHash: string
	now: Date
}): TemporalWorkflowMismatchEvent | null {
	const temporalStatus = input.temporalStatus.toUpperCase()
	let kind: TemporalWorkflowMismatchKind | null = null
	if (
		temporalStatus === 'COMPLETED' &&
		input.projection?.status !== 'complete'
	) {
		kind = 'temporal_success_runlog_missing'
	} else if (
		input.projection?.status != null &&
		terminalRunLogStatuses.has(input.projection.status) &&
		isTemporalOpen(temporalStatus)
	) {
		kind = 'runlog_terminal_temporal_open'
	}
	if (!kind) return null

	const mismatchAt =
		input.temporalClosedAt ??
		input.projection?.completedAt ??
		input.projection?.updatedAt ??
		input.temporalStartedAt
	const mismatchAtMs = Date.parse(mismatchAt)
	const ageMs = Number.isFinite(mismatchAtMs)
		? Math.max(0, input.now.getTime() - mismatchAtMs)
		: 0
	return {
		workflowType: 'dynamicPackageWorkflow',
		kind,
		ageBucket: ageBucket(ageMs),
		alertable: ageMs >= temporalReconciliationGraceMs,
		temporalStatus,
		runLogStatus: input.projection?.status ?? null,
		userHash: input.userHash,
	}
}

export async function reconcileTemporalWorkflowProjections(input: {
	env: TemporalReconciliationEnv
	now?: Date
	fetch?: typeof fetch
	recordMismatch?: (event: TemporalWorkflowMismatchEvent) => void
	recordSummary?: (summary: TemporalWorkflowReconciliationSummary) => void
}): Promise<TemporalWorkflowReconciliationSummary> {
	const gatewayUrl = input.env.TEMPORAL_GATEWAY_URL?.trim()
	const signingKeys = input.env.TEMPORAL_GATEWAY_SIGNING_KEYS?.trim()
	if (!gatewayUrl || !signingKeys) {
		const skipped: TemporalWorkflowReconciliationSummary = {
			status: 'skipped',
			reason: 'not_configured',
			sampled: 0,
			matched: 0,
			unattributed: 0,
			lookupErrors: 0,
			temporalSuccessRunLogMissing: 0,
			runLogTerminalTemporalOpen: 0,
			alertableMismatches: 0,
			truncated: false,
		}
		input.recordSummary?.(skipped)
		return skipped
	}

	const sample = await sampleTemporalDynamicPackageWorkflows({
		env: input.env,
		limit: temporalReconciliationSampleLimit,
		fetch: input.fetch,
	})
	const now = input.now ?? new Date()
	const mismatches: Array<TemporalWorkflowMismatchEvent> = []
	let matched = 0
	let unattributed = 0
	let lookupErrors = 0

	await mapWithConcurrency(
		sample.executions,
		temporalReconciliationConcurrency,
		async (execution) => {
			if (
				!execution.userHash ||
				!execution.workflowRunId ||
				!execution.callerContextRef
			) {
				unattributed += 1
				return
			}
			let userId: string
			try {
				userId = await loadTemporalWorkflowOwner({
					kv: input.env.BUNDLE_ARTIFACTS_KV,
					userHash: execution.userHash,
					callerContextRef: execution.callerContextRef,
				})
			} catch {
				lookupErrors += 1
				return
			}
			let projection: WorkflowProjectionRecord | null
			try {
				projection = await getWorkflowProjection({
					env: input.env as Env,
					userId,
					id: execution.workflowRunId,
				})
			} catch {
				lookupErrors += 1
				return
			}
			if (
				projection &&
				projection.bindingName !== temporalWorkflowBindingName
			) {
				unattributed += 1
				return
			}
			matched += 1
			const mismatch = classifyTemporalWorkflowMismatch({
				temporalStatus: execution.status,
				temporalStartedAt: execution.startedAt,
				...(execution.closedAt ? { temporalClosedAt: execution.closedAt } : {}),
				projection,
				userHash: execution.userHash,
				now,
			})
			if (mismatch) mismatches.push(mismatch)
		},
	)

	const recordMismatch =
		input.recordMismatch ??
		((event: TemporalWorkflowMismatchEvent) =>
			console.info('temporal_workflow_reconciliation_mismatch', event))
	for (const mismatch of mismatches) recordMismatch(mismatch)
	const summary: TemporalWorkflowReconciliationSummary = {
		status: 'ok',
		sampled: sample.executions.length,
		matched,
		unattributed,
		lookupErrors,
		temporalSuccessRunLogMissing: mismatches.filter(
			(item) => item.kind === 'temporal_success_runlog_missing',
		).length,
		runLogTerminalTemporalOpen: mismatches.filter(
			(item) => item.kind === 'runlog_terminal_temporal_open',
		).length,
		alertableMismatches: mismatches.filter((item) => item.alertable).length,
		truncated: sample.truncated,
	}
	;(
		input.recordSummary ??
		((value) => console.info('temporal_workflow_reconciliation', value))
	)(summary)
	return summary
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
) {
	let nextIndex = 0
	await Promise.all(
		Array.from(
			{ length: Math.min(Math.max(1, concurrency), items.length) },
			async () => {
				while (nextIndex < items.length) {
					const index = nextIndex
					nextIndex += 1
					const item = items[index]
					if (item !== undefined) await mapper(item)
				}
			},
		),
	)
}
