/**
 * Run-history row shapes and pure helpers shared by the DynamoDB run store
 * (`aws/dynamo-runs.ts`), the run-records service and the legacy RunLog DO
 * (invocation ledger + workflow projections until P5).
 */
import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { type RunLogAdminInsightsSnapshot } from './admin-insights-snapshot.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
import {
	type ActivationMilestoneRecord,
	type PackageRunSuccessRecord,
} from './package-activation-state.ts'
import {
	type RunErrorTriage,
	type RunErrorTriageFilter,
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunRecordPage,
	type RunRecordSummary,
	type RunStatus,
	type RunSurface,
	runErrorTriageValues,
	runRecordMaxJsonBytes,
	runRecordMaxPageSize,
	runSurfaceValues,
} from './types.ts'

const textEncoder = new TextEncoder()

export const platformInterruptTriageNote =
	'auto-ignored: idempotent scheduler or delivery queue will retry'
export const platformInterruptTriagedBy = 'system:platform-interrupt'

export type RunLogRowInput = {
	id: string
	surface: RunSurface
	status: RunStatus
	name: string | null
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	jobId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	idempotencyKey: string | null
	parentRunId: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	metadataJson: string
	createdAt: string
	updatedAt: string
}

export type RunLogEntryInput = {
	sequence: number
	level: RunLogLevel
	message: string
	fieldsJson: string | null
}

export type ListRunsInput = {
	surface?: RunSurface | null
	status?: RunStatus | null
	packageId?: string | null
	jobId?: string | null
	name?: string | null
	since?: string | null
	errorTriage?: RunErrorTriageFilter | null
	limit: number
	cursor?: string | null
}

export type UpdateRunErrorTriageInput = {
	runId: string
	/** `null` clears triage (reopen). */
	errorTriage: RunErrorTriage | null
	/**
	 * When true, keep the existing note (used when the caller omitted `note`
	 * so RPC cannot rely on `undefined` surviving structured clone).
	 */
	preserveTriageNote?: boolean
	/**
	 * `null` or empty clears the note. Ignored when `preserveTriageNote` is
	 * true, and cleared automatically when reopening (`errorTriage: null`).
	 */
	triageNote?: string | null
	triagedBy: string
}

export type UpdateRunErrorTriageResult =
	| { ok: true; run: RunRecord }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'not_error'; status: RunStatus; runId: string }

export type BulkUpdateRunErrorTriageFilter = {
	surface?: RunSurface | null
	packageId?: string | null
	jobId?: string | null
	name?: string | null
	errorName?: string | null
	errorMessage?: string | null
	errorTriage?: RunErrorTriageFilter | null
}

export type BulkUpdateRunErrorTriageInput = {
	runIds?: Array<string> | null
	filter?: BulkUpdateRunErrorTriageFilter | null
	errorTriage: RunErrorTriage | null
	preserveTriageNote?: boolean
	triageNote?: string | null
	triagedBy: string
	limit: number
	dryRun?: boolean
}

export type BulkUpdateRunErrorTriageResult = {
	matchedRunIds: Array<string>
	updatedCount: number
	hasMore: boolean
}

export type CursorPayload = {
	startedAt: string
	id: string
}

export function truncateUtf8(value: string, maxBytes: number) {
	if (textEncoder.encode(value).length <= maxBytes) return value
	const suffix = '... [truncated]'
	let low = 0
	let high = value.length
	let best = ''
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2)
		const candidate = `${value.slice(0, midpoint)}${suffix}`
		if (textEncoder.encode(candidate).length <= maxBytes) {
			best = candidate
			low = midpoint + 1
		} else {
			high = midpoint - 1
		}
	}
	return best
}

export function serializeJson(
	value: unknown,
	maxBytes = runRecordMaxJsonBytes,
) {
	const json = JSON.stringify(toJsonSafeValue(value))
	if (textEncoder.encode(json).length <= maxBytes) return json
	let preview = truncateUtf8(json, Math.max(0, maxBytes - 128))
	let wrapped = JSON.stringify({
		__truncated__: true,
		preview,
	})
	while (textEncoder.encode(wrapped).length > maxBytes && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length * 0.8))
		wrapped = JSON.stringify({
			__truncated__: true,
			preview,
		})
	}
	return wrapped
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string' || value.length === 0) return {}
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		return parsed as Record<string, unknown>
	} catch {
		return {}
	}
}

export function isRunSurface(value: string): value is RunSurface {
	return (runSurfaceValues as ReadonlyArray<string>).includes(value)
}

export function encodeCursor(payload: CursorPayload) {
	return btoa(JSON.stringify(payload))
}

export function decodeCursor(cursor: string): CursorPayload | null {
	try {
		const parsed = JSON.parse(atob(cursor)) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const startedAt = record['startedAt']
		const id = record['id']
		if (typeof startedAt !== 'string' || typeof id !== 'string') return null
		return { startedAt, id }
	} catch {
		return null
	}
}

export function normalizePageSize(
	pageSize: number | undefined,
	fallback: number,
) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: fallback
	return Math.min(Math.max(requested, 1), runRecordMaxPageSize)
}

export function isRunErrorTriage(value: string): value is RunErrorTriage {
	return (runErrorTriageValues as ReadonlyArray<string>).includes(value)
}

export function clampMetadataJson(metadataJson: string) {
	if (textEncoder.encode(metadataJson).length <= runRecordMaxJsonBytes) {
		return metadataJson
	}
	return serializeJson(parseJsonRecord(metadataJson))
}

/** `exportRuns` page from the run store: runs, then job, package and milestone phases. */
export type RunRecordsExportPage = {
	runs: Array<RunRecord>
	logs: Array<RunRecordLog>
	jobRunObservability: Array<JobRunObservabilityRecord>
	packageRunSuccesses: Array<PackageRunSuccessRecord>
	activationMilestones: Array<ActivationMilestoneRecord>
	nextStartAfter: string | null
	truncated: boolean
}

/**
 * One user's run history, logs, keyed claims, triage and the counters derived
 * from terminal runs (job observability, package activation). Same RPC shapes
 * as the former RunLog Durable Object methods.
 */
export type RunRecordsRpc = {
	startRun: (input: {
		run: RunLogRowInput
		/** Phase lines kept until finish replaces them (claim-time diagnostics). */
		initialLogs?: Array<RunLogEntryInput>
	}) => Promise<{ ok: true }>
	claimRun: (input: {
		run: RunLogRowInput
	}) => Promise<{ claimed: boolean; run: RunRecord }>
	finishRun: (input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}) => Promise<{ ok: true }>
	listRuns: (input: ListRunsInput) => Promise<RunRecordPage>
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
	summarize: (input: { since: string }) => Promise<RunRecordSummary>
	updateRunErrorTriage: (
		input: UpdateRunErrorTriageInput,
	) => Promise<UpdateRunErrorTriageResult>
	bulkUpdateRunErrorTriage: (
		input: BulkUpdateRunErrorTriageInput,
	) => Promise<BulkUpdateRunErrorTriageResult>
	listStorageIds: () => Promise<Array<string>>
	upsertJobRunObservability: (
		input: JobRunObservabilityUpsertInput,
	) => Promise<JobRunObservabilityRecord>
	getJobRunObservability: (input: {
		jobId: string
	}) => Promise<JobRunObservabilityRecord | null>
	getJobRunObservabilityBatch: (input: {
		jobIds: Array<string>
	}) => Promise<Array<JobRunObservabilityRecord>>
	listPackageRunSuccesses: () => Promise<Array<PackageRunSuccessRecord>>
	listActivationMilestones: () => Promise<Array<ActivationMilestoneRecord>>
	/** `workflowStatusCounts` is empty here; projections still live in RunLog until P5. */
	getAdminInsightsSnapshot: () => Promise<RunLogAdminInsightsSnapshot>
	exportRuns: (input: {
		pageSize: number
		startAfter?: string | null
	}) => Promise<RunRecordsExportPage>
	clearAll: () => Promise<{ ok: true }>
}

/** `env.RUN_RECORDS`: the per-user run store (DynamoDB `runs` table + S3 logs). */
export type RunRecords = { forUser(userId: string): RunRecordsRpc }

/** R2-shaped subset of `aws/s3-objects.ts` the run store needs for log bodies. */
export type RunLogObjects = {
	get(key: string): Promise<{ text(): Promise<string> } | null>
	put(
		key: string,
		value: string,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<unknown>
	delete(keys: string | Array<string>): Promise<unknown>
}
