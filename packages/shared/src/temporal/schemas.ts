import { isRecord } from '../is-record.ts'
import {
	temporalActivityPaths,
	type CancelAccountRequest,
	type ClaimJobRequest,
	type DynamicPackageWorkflowInput,
	type ExecuteDynamicPackageRequest,
	type ExecutePackageRequest,
	type FinalizeJobRequest,
	type ResolvePackageRequest,
	type ResolveJobExecutionPlanRequest,
	type StripePlanRefreshRequest,
	type StripePlanRefreshWorkflowInput,
	type ExecuteJobPackageRequest,
	type JobOccurrenceWorkflowInput,
	type TemporalActivityPath,
	type TemporalActivityRequestByPath,
	type TemporalCorrelation,
	type TemporalGatewayCancelRequest,
	type TemporalGatewayReconciliationRequest,
	type TemporalGatewaySignalWithStartRequest,
	type TemporalGatewayStartRequest,
} from './contracts.ts'
import { assertOpaqueTemporalIdentifier } from './identifiers.ts'

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function readString(
	record: Record<string, unknown>,
	key: string,
	options: { max?: number; optional: true },
): string | undefined
function readString(
	record: Record<string, unknown>,
	key: string,
	options?: { max?: number; optional?: false },
): string
function readString(
	record: Record<string, unknown>,
	key: string,
	options: { max?: number; optional?: boolean } = {},
) {
	const value = record[key]
	if (value === undefined && options.optional) return undefined
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > (options.max ?? 200)
	) {
		throw new Error(`Invalid ${key}.`)
	}
	return value
}

function assertExactKeys(
	record: Record<string, unknown>,
	required: ReadonlyArray<string>,
	optional: ReadonlyArray<string> = [],
) {
	const allowed = new Set([...required, ...optional])
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new Error(`Unexpected field ${key}.`)
	}
	for (const key of required) {
		if (!(key in record)) throw new Error(`Missing ${key}.`)
	}
}

function readTimestamp(record: Record<string, unknown>, key: string) {
	const value = readString(record, key, { max: 30 })
	if (!isoTimestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Invalid ${key}.`)
	}
	return value
}

function readPositiveInteger(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = record[key]
	if (value === undefined) return undefined
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		throw new Error(`Invalid ${key}.`)
	}
	return Number(value)
}

function parseCorrelation(
	record: Record<string, unknown>,
): TemporalCorrelation {
	const workflowId = assertOpaqueTemporalIdentifier(
		readString(record, 'workflowId'),
		'workflowId',
	)
	const userHash = assertOpaqueTemporalIdentifier(
		readString(record, 'userHash'),
		'userHash',
	)
	const temporalRunId = readString(record, 'temporalRunId', { optional: true })
	const jobId = readString(record, 'jobId', { optional: true })
	const runRef = readString(record, 'runRef', { optional: true })
	return {
		workflowId,
		userHash,
		...(temporalRunId
			? {
					temporalRunId: assertOpaqueTemporalIdentifier(
						temporalRunId,
						'temporalRunId',
					),
				}
			: {}),
		...(jobId ? { jobId: assertOpaqueTemporalIdentifier(jobId, 'jobId') } : {}),
		...(runRef
			? { runRef: assertOpaqueTemporalIdentifier(runRef, 'runRef') }
			: {}),
	}
}

function parseRecord(value: unknown) {
	if (!isRecord(value)) throw new Error('Expected a JSON object.')
	return value
}

function parseClaim(value: unknown): ClaimJobRequest {
	const record = parseRecord(value)
	assertExactKeys(
		record,
		['workflowId', 'userHash', 'jobId', 'runRef', 'scheduledFor', 'trigger'],
		['temporalRunId'],
	)
	const correlation = parseCorrelation(record)
	const trigger = readString(record, 'trigger', { max: 20 })
	if (!['scheduled', 'run-now', 'backfill'].includes(trigger)) {
		throw new Error('Invalid trigger.')
	}
	return {
		...correlation,
		jobId: assertOpaqueTemporalIdentifier(readString(record, 'jobId'), 'jobId'),
		runRef: assertOpaqueTemporalIdentifier(
			readString(record, 'runRef'),
			'runRef',
		),
		scheduledFor: readTimestamp(record, 'scheduledFor'),
		trigger: trigger as ClaimJobRequest['trigger'],
	}
}

function parseFinalize(value: unknown): FinalizeJobRequest {
	const record = parseRecord(value)
	assertExactKeys(
		record,
		[
			'workflowId',
			'userHash',
			'jobId',
			'runRef',
			'claimRef',
			'status',
			'scheduledFor',
			'finishedAt',
		],
		['temporalRunId', 'resultRef', 'errorCode'],
	)
	const status = readString(record, 'status', { max: 20 })
	if (!['succeeded', 'failed', 'cancelled'].includes(status)) {
		throw new Error('Invalid status.')
	}
	return {
		...parseCorrelation(record),
		jobId: assertOpaqueTemporalIdentifier(readString(record, 'jobId'), 'jobId'),
		runRef: assertOpaqueTemporalIdentifier(
			readString(record, 'runRef'),
			'runRef',
		),
		claimRef: assertOpaqueTemporalIdentifier(
			readString(record, 'claimRef'),
			'claimRef',
		),
		status: status as FinalizeJobRequest['status'],
		scheduledFor: readTimestamp(record, 'scheduledFor'),
		finishedAt: readTimestamp(record, 'finishedAt'),
		...(readString(record, 'resultRef', { max: 512, optional: true })
			? { resultRef: readString(record, 'resultRef', { max: 512 }) }
			: {}),
		...(readString(record, 'errorCode', { optional: true })
			? { errorCode: readString(record, 'errorCode') }
			: {}),
	}
}

function parseResolve(
	value: unknown,
): ResolvePackageRequest | ResolveJobExecutionPlanRequest {
	const record = parseRecord(value)
	if ('claimRef' in record) {
		assertExactKeys(
			record,
			['workflowId', 'userHash', 'jobId', 'runRef', 'claimRef'],
			['temporalRunId'],
		)
		return {
			...parseCorrelation(record),
			jobId: assertOpaqueTemporalIdentifier(
				readString(record, 'jobId'),
				'jobId',
			),
			runRef: assertOpaqueTemporalIdentifier(
				readString(record, 'runRef'),
				'runRef',
			),
			claimRef: assertOpaqueTemporalIdentifier(
				readString(record, 'claimRef'),
				'claimRef',
			),
		}
	}
	assertExactKeys(
		record,
		['workflowId', 'userHash', 'sourceRef'],
		['temporalRunId', 'jobId', 'runRef'],
	)
	return {
		...parseCorrelation(record),
		sourceRef: readString(record, 'sourceRef', { max: 512 }),
	}
}

function parseExecute(
	value: unknown,
):
	| ExecutePackageRequest
	| ExecuteJobPackageRequest
	| ExecuteDynamicPackageRequest {
	const record = parseRecord(value)
	if ('workflowRunId' in record) {
		assertExactKeys(
			record,
			[
				'workflowId',
				'userHash',
				'workflowRunId',
				'sourceRef',
				'callerContextRef',
				'invocationIdempotencyKey',
			],
			['temporalRunId', 'activityAttempt'],
		)
		const activityAttempt = readPositiveInteger(record, 'activityAttempt')
		return {
			...parseCorrelation(record),
			workflowRunId: assertOpaqueTemporalIdentifier(
				readString(record, 'workflowRunId'),
				'workflowRunId',
			),
			sourceRef: readString(record, 'sourceRef', { max: 512 }),
			callerContextRef: readString(record, 'callerContextRef', { max: 512 }),
			invocationIdempotencyKey: assertOpaqueTemporalIdentifier(
				readString(record, 'invocationIdempotencyKey'),
				'invocationIdempotencyKey',
			),
			...(activityAttempt === undefined ? {} : { activityAttempt }),
		}
	}
	if ('claimRef' in record) {
		assertExactKeys(
			record,
			[
				'workflowId',
				'userHash',
				'jobId',
				'runRef',
				'claimRef',
				'executionPlanRef',
			],
			['temporalRunId'],
		)
		return {
			...parseCorrelation(record),
			jobId: assertOpaqueTemporalIdentifier(
				readString(record, 'jobId'),
				'jobId',
			),
			runRef: assertOpaqueTemporalIdentifier(
				readString(record, 'runRef'),
				'runRef',
			),
			claimRef: assertOpaqueTemporalIdentifier(
				readString(record, 'claimRef'),
				'claimRef',
			),
			executionPlanRef: readString(record, 'executionPlanRef', { max: 512 }),
		}
	}
	assertExactKeys(
		record,
		['workflowId', 'userHash', 'executionPlanRef'],
		['temporalRunId', 'jobId', 'runRef'],
	)
	return {
		...parseCorrelation(record),
		executionPlanRef: readString(record, 'executionPlanRef', { max: 512 }),
	}
}

function parseCancelAccount(value: unknown): CancelAccountRequest {
	const record = parseRecord(value)
	assertExactKeys(
		record,
		['workflowId', 'userHash', 'reason'],
		['temporalRunId'],
	)
	const reason = readString(record, 'reason', { max: 30 })
	if (!['account-deletion', 'operator'].includes(reason)) {
		throw new Error('Invalid reason.')
	}
	return {
		...parseCorrelation(record),
		reason: reason as CancelAccountRequest['reason'],
	}
}

function parseStripePlanRefresh(
	value: unknown,
): StripePlanRefreshWorkflowInput {
	const record = parseRecord(value)
	assertExactKeys(
		record,
		['workflowId', 'userHash', 'coordinatorRef', 'refreshAt'],
		['temporalRunId'],
	)
	return {
		...parseCorrelation(record),
		coordinatorRef: readString(record, 'coordinatorRef', { max: 200 }),
		refreshAt: readTimestamp(record, 'refreshAt'),
	}
}

function parseStripePlanRefreshActivity(
	value: unknown,
): StripePlanRefreshRequest {
	const parsed = parseStripePlanRefresh(value)
	if (!parsed.temporalRunId) throw new Error('Missing temporalRunId.')
	return { ...parsed, temporalRunId: parsed.temporalRunId }
}

export function isTemporalActivityPath(
	value: string,
): value is TemporalActivityPath {
	return temporalActivityPaths.includes(value as TemporalActivityPath)
}

export function parseTemporalActivityRequest<P extends TemporalActivityPath>(
	path: P,
	value: unknown,
): TemporalActivityRequestByPath[P] {
	switch (path) {
		case '/__temporal/v1/jobs/claim':
			return parseClaim(value) as TemporalActivityRequestByPath[P]
		case '/__temporal/v1/jobs/finalize':
			return parseFinalize(value) as TemporalActivityRequestByPath[P]
		case '/__temporal/v1/packages/resolve':
			return parseResolve(value) as TemporalActivityRequestByPath[P]
		case '/__temporal/v1/packages/execute':
			return parseExecute(value) as TemporalActivityRequestByPath[P]
		case '/__temporal/v1/coordinators/stripe-plan-refresh':
			return parseStripePlanRefreshActivity(
				value,
			) as TemporalActivityRequestByPath[P]
		case '/__temporal/v1/accounts/cancel':
			return parseCancelAccount(value) as TemporalActivityRequestByPath[P]
	}
}

export function parseDynamicPackageWorkflowInput(
	value: unknown,
): DynamicPackageWorkflowInput {
	const record = parseRecord(value)
	assertExactKeys(record, [
		'workflowId',
		'userHash',
		'workflowRunId',
		'sourceRef',
		'requestedRunAt',
		'idempotencyKey',
		'callerContextRef',
	])
	return {
		...parseCorrelation(record),
		workflowRunId: assertOpaqueTemporalIdentifier(
			readString(record, 'workflowRunId'),
			'workflowRunId',
		),
		sourceRef: readString(record, 'sourceRef', { max: 512 }),
		requestedRunAt: readTimestamp(record, 'requestedRunAt'),
		idempotencyKey: assertOpaqueTemporalIdentifier(
			readString(record, 'idempotencyKey'),
			'idempotencyKey',
		),
		callerContextRef: readString(record, 'callerContextRef', { max: 512 }),
	}
}

export function parseTemporalGatewayStartRequest(
	value: unknown,
): TemporalGatewayStartRequest {
	const record = parseRecord(value)
	assertExactKeys(record, ['workflowType', 'workflowId', 'taskQueue', 'input'])
	if (
		record['workflowType'] !== 'temporalFoundationWorkflow' &&
		record['workflowType'] !== 'jobOccurrenceWorkflow' &&
		record['workflowType'] !== 'dynamicPackageWorkflow' &&
		record['workflowType'] !== 'stripePlanRefreshWorkflow'
	) {
		throw new Error('Invalid workflowType.')
	}
	const workflowType = record['workflowType']
	return {
		workflowType,
		workflowId: assertOpaqueTemporalIdentifier(
			readString(record, 'workflowId'),
			'workflowId',
		),
		taskQueue: assertOpaqueTemporalIdentifier(
			readString(record, 'taskQueue'),
			'taskQueue',
		),
		input:
			workflowType === 'temporalFoundationWorkflow'
				? (parseResolve(record['input']) as ResolvePackageRequest)
				: workflowType === 'jobOccurrenceWorkflow'
					? parseJobOccurrenceWorkflowInput(record['input'])
					: workflowType === 'dynamicPackageWorkflow'
						? parseDynamicPackageWorkflowInput(record['input'])
						: parseStripePlanRefresh(record['input']),
	}
}

export function parseTemporalGatewaySignalWithStartRequest(
	value: unknown,
): TemporalGatewaySignalWithStartRequest {
	const record = parseRecord(value)
	assertExactKeys(record, [
		'workflowType',
		'workflowId',
		'taskQueue',
		'input',
		'signalName',
		'signalArgs',
	])
	if (
		record['workflowType'] !== 'stripePlanRefreshWorkflow' ||
		record['signalName'] !== 'rescheduleStripePlanRefresh'
	) {
		throw new Error('Invalid signal-with-start operation.')
	}
	if (
		!Array.isArray(record['signalArgs']) ||
		record['signalArgs'].length !== 1
	) {
		throw new Error('Invalid signalArgs.')
	}
	const refreshAt = readTimestamp(
		{ refreshAt: record['signalArgs'][0] },
		'refreshAt',
	)
	const workflowId = assertOpaqueTemporalIdentifier(
		readString(record, 'workflowId'),
		'workflowId',
	)
	const input = parseStripePlanRefresh(record['input'])
	if (input.workflowId !== workflowId || input.refreshAt !== refreshAt) {
		throw new Error('Signal-with-start identity mismatch.')
	}
	return {
		workflowType: 'stripePlanRefreshWorkflow',
		workflowId,
		taskQueue: assertOpaqueTemporalIdentifier(
			readString(record, 'taskQueue'),
			'taskQueue',
		),
		input,
		signalName: 'rescheduleStripePlanRefresh',
		signalArgs: [refreshAt],
	}
}

export function parseJobOccurrenceWorkflowInput(
	value: unknown,
): JobOccurrenceWorkflowInput {
	const record = parseRecord(value)
	assertExactKeys(
		record,
		['workflowId', 'userHash', 'jobId', 'runRef', 'scheduledFor', 'trigger'],
		['temporalRunId'],
	)
	return parseClaim(record)
}

export function parseTemporalGatewayCancelRequest(
	value: unknown,
): TemporalGatewayCancelRequest {
	const record = parseRecord(value)
	assertExactKeys(record, ['workflowId', 'reason'])
	return {
		workflowId: assertOpaqueTemporalIdentifier(
			readString(record, 'workflowId'),
			'workflowId',
		),
		reason: readString(record, 'reason', { max: 200 }),
	}
}

export function parseTemporalGatewayReconciliationRequest(
	value: unknown,
): TemporalGatewayReconciliationRequest {
	const record = parseRecord(value)
	assertExactKeys(record, ['workflowType', 'limit'])
	if (record['workflowType'] !== 'dynamicPackageWorkflow') {
		throw new Error('Invalid workflowType.')
	}
	const limit = readPositiveInteger(record, 'limit')
	if (limit === undefined || limit > 500) {
		throw new Error('Invalid limit.')
	}
	return { workflowType: 'dynamicPackageWorkflow', limit }
}
