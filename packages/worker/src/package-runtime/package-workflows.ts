import { isoTimestampDayKey } from '@kody-internal/shared/date-keys.ts'
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import {
	toJsonSafeValue,
	type JsonValue,
} from '@kody-internal/shared/json-safe-value.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { buildPackageWorkflowId } from '@kody-internal/shared/temporal/identifiers.ts'
import { mapTemporalWorkflowStatus } from '@kody-internal/shared/temporal/status.ts'
import {
	type ExecuteDynamicPackageRequest,
	type ExecuteDynamicPackageResult,
} from '@kody-internal/shared/temporal/contracts.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	readPreExecutionPackageInvocationInfrastructureCode,
	readRetryablePackageInvocationInfrastructureCode,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	createExecutePackageInvokeTools,
	createPackageRuntimeInvokeTools,
	invokePackageExport,
} from '#worker/package-invocations/service.ts'
import { packageWorkflowInvocationSource } from './package-invocation-sources.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	beginRunRecord,
	deleteWorkflowProjectionIfCreating,
	findWorkflowProjectionByIdempotencyKey,
	finishRunRecord,
	getWorkflowProjection,
	listWorkflowProjections,
	reserveWorkflowProjectionSlot,
	upsertWorkflowProjection,
	type WorkflowProjectionRecord,
	type WorkflowProjectionUpsertInput,
} from '#worker/run-records/service.ts'
import {
	creatingWorkflowProjectionStatus,
	isWorkflowBindingName,
	type WorkflowBindingName,
} from '#worker/run-records/workflow-projection.ts'
import { isTransientDurableObjectResetError } from '#worker/durable-object-reset-retry.ts'
import { isUserCodeError, UserCodeError } from '#worker/user-code-error.ts'
import { inlineWorkflowNameFallback } from '#universal/workflow-display.ts'
import {
	activeWorkflowStatusValues,
	terminalWorkflowStatusValues,
	type WorkflowRunStatus,
} from './workflow-statuses.ts'
import {
	cancelTemporalWorkflow,
	describeTemporalWorkflow,
	startDynamicPackageWorkflow,
	TemporalGatewayError,
} from '#worker/temporal/client.ts'
import {
	loadTemporalWorkflowPayload,
	storeTemporalWorkflowArtifacts,
} from './temporal-workflow-artifacts.ts'
import { recordTemporalWorkflowConcurrency } from '#worker/temporal/observability.ts'

export const temporalDynamicPackageWorkflowsBindingName =
	'TEMPORAL_DYNAMIC_PACKAGE_WORKFLOWS' satisfies WorkflowBindingName

function normalizeWorkflowBindingName(value: string | null | undefined) {
	const trimmed = value?.trim() || temporalDynamicPackageWorkflowsBindingName
	if (!isWorkflowBindingName(trimmed)) {
		throw new Error(`Unsupported workflow binding name "${trimmed}".`)
	}
	return trimmed
}

export type PackageWorkflowParams = Record<string, unknown>

type WorkflowCreateBaseInput = {
	workflowName?: string
	runAt?: string | Date
	idempotencyKey?: string
	params?: PackageWorkflowParams
}

export type PackageWorkflowCreateInput = WorkflowCreateBaseInput &
	(
		| {
				exportName: string
				packageId?: string
				code?: never
		  }
		| {
				code: string
				exportName?: never
				packageId?: never
		  }
	)

export type PackageWorkflowCreateResult = {
	ok: true
	id: string
	workflow_name: string
	source_type: 'package' | 'inline'
	package_id?: string | null
	export_name?: string | null
	run_at: string
	plan_date: string | null
	status?: string
}

export type DynamicCallableWorkflowPayload =
	| {
			version: 2
			sourceType: 'package'
			userId: string
			packageId: string
			kodyId: string
			sourceId: string
			workflowName: string
			exportName: string
			idempotencyKey: string
			runAt: string
			planDate: string | null
			params?: PackageWorkflowParams
	  }
	| {
			version: 3
			sourceType: 'inline'
			userId: string
			packageContext: {
				packageId: string
				kodyId: string
				sourceId?: string | null
			} | null
			workflowName: string
			code: string
			idempotencyKey: string
			runAt: string
			planDate: string | null
			params?: PackageWorkflowParams
	  }

export type WorkflowRunInspection = {
	id: string
	userId: string
	bindingName: WorkflowBindingName
	sourceType: 'package' | 'inline'
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	workflowName: string
	exportName: string | null
	idempotencyKey: string
	runAt: string
	planDate: string | null
	status: WorkflowRunStatus | null
	createdAt: string
	updatedAt: string
	completedAt: string | null
	lastError: string | null
}

/**
 * Sandbox budget for workflow-invoked package exports / inline code.
 * Kept below the Temporal Activity timeout so status bookkeeping still has
 * headroom after the sandbox returns.
 */
export const workflowExecutorTimeoutMs = 270_000

const packageWorkflowTokenId = 'internal:package-workflows'
const maxPackageWorkflowParamsJsonBytes = 16 * 1024
const workflowStatusRefreshTtlMs = 30_000
const knownWorkflowStatusValues = [
	...activeWorkflowStatusValues,
	...terminalWorkflowStatusValues,
] as const
const activeWorkflowStatuses = new Set<string>(activeWorkflowStatusValues)
const terminalWorkflowStatuses = new Set<string>(terminalWorkflowStatusValues)
const knownWorkflowStatuses = new Set<string>(knownWorkflowStatusValues)

function getWorkflowInvocationErrorMessage(response: {
	status: number
	body: unknown
}) {
	const body = response.body
	const error =
		body && typeof body === 'object'
			? (body as Record<string, unknown>)['error']
			: null
	const message =
		error && typeof error === 'object'
			? (error as Record<string, unknown>)['message']
			: null
	return typeof message === 'string' && message.trim()
		? message
		: `Package workflow export failed with HTTP ${response.status}.`
}

function readWorkflowInvocationErrorCode(response: {
	status: number
	body: unknown
}) {
	const body = response.body
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const code = (error as Record<string, unknown>)['code']
	return typeof code === 'string' && code.trim() ? code : null
}

// Sandbox throws are HTTP 500 `execution_failed`; client mistakes are 4xx.
// Known infrastructure codes and other 5xx/unexpected statuses stay plain Errors.
function isPackageWorkflowUserCodeFailure(response: {
	status: number
	body: Record<string, unknown>
}) {
	if (readRetryablePackageInvocationInfrastructureCode(response)) return false
	if (readPreExecutionPackageInvocationInfrastructureCode(response)) {
		return false
	}
	if (readWorkflowInvocationErrorCode(response) === 'execution_failed') {
		return true
	}
	return response.status >= 400 && response.status < 500
}

function throwWorkflowInvocationFailure(response: {
	status: number
	body: Record<string, unknown>
}): never {
	const message = getWorkflowInvocationErrorMessage(response)
	if (isPackageWorkflowUserCodeFailure(response)) {
		throw new UserCodeError(message)
	}
	throw new Error(message)
}

function normalizeNonEmptyString(value: string, fieldName: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error(`${fieldName} must not be empty.`)
	}
	return trimmed
}

export function normalizeWorkflowExportName(exportName: string) {
	const trimmed = normalizeNonEmptyString(exportName, 'exportName')
	if (trimmed === '.' || trimmed === './') return '.'
	if (trimmed.startsWith('kody:')) return trimmed
	return trimmed.startsWith('./') ? trimmed : `./${trimmed}`
}

function normalizeOptionalWorkflowName(
	workflowName: string | undefined,
	fallback: string,
) {
	return workflowName?.trim() || fallback
}

function normalizeRunAt(runAt: string | Date | undefined) {
	const date =
		runAt === undefined
			? new Date()
			: typeof runAt === 'string'
				? new Date(runAt)
				: runAt
	if (Number.isNaN(date.getTime())) {
		throw new Error('runAt must be a valid date or ISO string.')
	}
	return date.toISOString()
}

export function normalizePackageWorkflowParams(
	params: PackageWorkflowParams | null | undefined,
) {
	if (params == null) return undefined
	if (typeof params !== 'object' || Array.isArray(params)) {
		throw new Error('workflow params must be a JSON object when provided.')
	}
	const paramsJson = JSON.stringify(params)
	if (
		new TextEncoder().encode(paramsJson).byteLength >
		maxPackageWorkflowParamsJsonBytes
	) {
		throw new Error(
			`workflow params must be ${maxPackageWorkflowParamsJsonBytes} bytes or less when serialized.`,
		)
	}
	const normalized = JSON.parse(paramsJson) as unknown
	if (
		!normalized ||
		typeof normalized !== 'object' ||
		Array.isArray(normalized)
	) {
		throw new Error('workflow params must be a JSON object when provided.')
	}
	return normalized as PackageWorkflowParams
}

export async function createPackageWorkflowInstanceId(input: {
	userId: string
	packageId: string
	workflowName: string
	idempotencyKey: string
	runAt: string | Date
	options?: {
		includeRunAt?: boolean
	}
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		...(input.options?.includeRunAt === false
			? {}
			: { runAt: normalizeRunAt(input.runAt) }),
	})
	return `pkgwf-${(await sha256Base64Url(canonical)).slice(0, 43)}`
}

export function createPackageWorkflowPlanDate(runAt: string | Date) {
	return isoTimestampDayKey(normalizeRunAt(runAt))
}

function normalizeWorkflowIdempotencyKey(idempotencyKey: string | undefined) {
	if (idempotencyKey !== undefined) {
		return normalizeNonEmptyString(idempotencyKey, 'idempotencyKey')
	}
	return `generated:${crypto.randomUUID()}`
}

function createInlineWorkflowPayload(input: {
	userId: string
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	workflowName?: string
	code: string
	idempotencyKey?: string
	runAt?: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): DynamicCallableWorkflowPayload {
	const runAt = normalizeRunAt(input.runAt)
	const idempotencyKey = normalizeWorkflowIdempotencyKey(input.idempotencyKey)
	const params = normalizePackageWorkflowParams(input.params)
	return {
		version: 3,
		sourceType: 'inline',
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageContext: input.packageContext ?? null,
		workflowName: normalizeOptionalWorkflowName(
			input.workflowName,
			inlineWorkflowNameFallback,
		),
		code: normalizeNonEmptyString(input.code, 'code'),
		idempotencyKey,
		runAt,
		planDate: input.planDate?.trim() || createPackageWorkflowPlanDate(runAt),
		...(params === undefined ? {} : { params }),
	}
}

function createDynamicPackageWorkflowPayload(input: {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	workflowName?: string
	exportName: string
	idempotencyKey?: string
	runAt?: string | Date
	params?: PackageWorkflowParams | null
	planDate?: string | null
}): DynamicCallableWorkflowPayload {
	const runAt = normalizeRunAt(input.runAt)
	const idempotencyKey = normalizeWorkflowIdempotencyKey(input.idempotencyKey)
	const params = normalizePackageWorkflowParams(input.params)
	const workflowName = normalizeNonEmptyString(
		normalizeOptionalWorkflowName(input.workflowName, input.exportName),
		'workflowName',
	)
	return {
		version: 2,
		sourceType: 'package',
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		packageId: normalizeNonEmptyString(input.packageId, 'packageId'),
		kodyId: normalizeNonEmptyString(input.kodyId, 'kodyId'),
		sourceId: normalizeNonEmptyString(input.sourceId, 'sourceId'),
		workflowName,
		exportName: normalizeWorkflowExportName(input.exportName),
		idempotencyKey,
		runAt,
		planDate: input.planDate?.trim() || createPackageWorkflowPlanDate(runAt),
		...(params === undefined ? {} : { params }),
	}
}

function createWorkflowCreateResult(input: {
	summary: { id: string; status?: string }
	payload: DynamicCallableWorkflowPayload
}): PackageWorkflowCreateResult {
	return {
		ok: true,
		id: input.summary.id,
		workflow_name: input.payload.workflowName,
		source_type: input.payload.sourceType,
		package_id:
			input.payload.sourceType === 'package' ? input.payload.packageId : null,
		export_name:
			input.payload.sourceType === 'package' ? input.payload.exportName : null,
		run_at: input.payload.runAt,
		plan_date: input.payload.planDate,
		status: input.summary.status,
	}
}

function createWorkflowCreateResultFromRow(
	row: WorkflowRunInspection,
): PackageWorkflowCreateResult {
	return {
		ok: true,
		id: row.id,
		workflow_name: row.workflowName,
		source_type: row.sourceType,
		package_id: row.sourceType === 'package' ? row.packageId : null,
		export_name: row.sourceType === 'package' ? row.exportName : null,
		run_at: row.runAt,
		plan_date: row.planDate,
		...(row.status ? { status: row.status } : {}),
	}
}

function mapWorkflowProjectionToInspection(
	projection: WorkflowProjectionRecord,
	userId: string,
): WorkflowRunInspection {
	const rawStatus = projection.status
	const status =
		typeof rawStatus === 'string' && knownWorkflowStatuses.has(rawStatus)
			? (rawStatus as WorkflowRunStatus)
			: null
	return {
		id: projection.id,
		userId,
		bindingName: normalizeWorkflowBindingName(projection.bindingName),
		sourceType: projection.sourceType,
		packageId: projection.packageId,
		kodyId: projection.kodyId,
		sourceId: projection.sourceId,
		workflowName: projection.workflowName,
		exportName: projection.exportName,
		idempotencyKey: projection.idempotencyKey,
		runAt: projection.runAt,
		planDate: projection.planDate,
		status,
		createdAt: projection.createdAt,
		updatedAt: projection.updatedAt,
		completedAt: projection.completedAt,
		lastError: projection.lastError,
	}
}

/**
 * RunLog-only idempotency lookup (binding-scoped; excludes `creating`).
 */
export async function findWorkflowRunByIdempotencyKey(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: string
	idempotencyKey: string
	bindingName?: WorkflowBindingName
}): Promise<WorkflowRunInspection | null> {
	const trimmedKey = input.idempotencyKey.trim()
	if (!trimmedKey) return null
	const projection = await findWorkflowProjectionByIdempotencyKey({
		env: input.env as Env,
		userId: input.userId,
		idempotencyKey: trimmedKey,
		bindingName: input.bindingName ?? null,
	})
	return projection
		? mapWorkflowProjectionToInspection(projection, input.userId)
		: null
}

async function getWorkflowRunForUser(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: string
	id: string
}): Promise<WorkflowRunInspection | null> {
	const projection = await getWorkflowProjection({
		env: input.env as Env,
		userId: input.userId,
		id: input.id,
	})
	return projection
		? mapWorkflowProjectionToInspection(projection, input.userId)
		: null
}

function buildWorkflowProjectionUpsert(input: {
	id: string
	payload: DynamicCallableWorkflowPayload
	bindingName?: WorkflowBindingName
	status: string | null
	now?: string
	lastError?: string | null
	completedAt?: string | null
	createdAt?: string | null
}): WorkflowProjectionUpsertInput {
	const now = input.now ?? new Date().toISOString()
	return {
		id: input.id,
		bindingName:
			input.bindingName ?? temporalDynamicPackageWorkflowsBindingName,
		sourceType: input.payload.sourceType,
		packageId:
			input.payload.sourceType === 'package' ? input.payload.packageId : null,
		kodyId:
			input.payload.sourceType === 'package' ? input.payload.kodyId : null,
		sourceId:
			input.payload.sourceType === 'package' ? input.payload.sourceId : null,
		workflowName: input.payload.workflowName,
		exportName:
			input.payload.sourceType === 'package' ? input.payload.exportName : null,
		idempotencyKey: input.payload.idempotencyKey,
		runAt: input.payload.runAt,
		planDate: input.payload.planDate,
		status: input.status,
		createdAt: input.createdAt ?? now,
		updatedAt: now,
		completedAt: input.completedAt ?? null,
		lastError: input.lastError ?? null,
	}
}

function payloadFromWorkflowInspection(
	row: WorkflowRunInspection,
): DynamicCallableWorkflowPayload {
	if (row.sourceType === 'package') {
		return {
			version: 2,
			sourceType: 'package',
			userId: row.userId,
			packageId: row.packageId ?? '',
			kodyId: row.kodyId ?? '',
			sourceId: row.sourceId ?? '',
			workflowName: row.workflowName,
			exportName: row.exportName ?? '.',
			idempotencyKey: row.idempotencyKey,
			runAt: row.runAt,
			planDate: row.planDate,
		}
	}
	return {
		version: 3,
		sourceType: 'inline',
		userId: row.userId,
		packageContext: null,
		workflowName: row.workflowName,
		code: '',
		idempotencyKey: row.idempotencyKey,
		runAt: row.runAt,
		planDate: row.planDate,
	}
}

async function createInlineWorkflowInstanceId(input: {
	userId: string
	workflowName: string
	idempotencyKey: string
	runAt: string | Date
	options?: {
		includeRunAt?: boolean
	}
}) {
	const canonical = canonicalJsonStringify({
		userId: normalizeNonEmptyString(input.userId, 'userId'),
		sourceType: 'inline',
		workflowName: normalizeNonEmptyString(input.workflowName, 'workflowName'),
		idempotencyKey: normalizeNonEmptyString(
			input.idempotencyKey,
			'idempotencyKey',
		),
		...(input.options?.includeRunAt === false
			? {}
			: { runAt: normalizeRunAt(input.runAt) }),
	})
	return `dynwf-${(await sha256Base64Url(canonical)).slice(0, 43)}`
}

async function createDynamicCallableWorkflowInstanceId(
	payload: DynamicCallableWorkflowPayload,
	options?: {
		includeRunAt?: boolean
	},
) {
	if (payload.sourceType === 'package') {
		return await createPackageWorkflowInstanceId({ ...payload, options })
	}
	return await createInlineWorkflowInstanceId({ ...payload, options })
}

function isTerminalWorkflowStatus(status: string | null | undefined): boolean {
	return status != null && terminalWorkflowStatuses.has(status)
}

async function projectWorkflowRun(input: {
	env: Pick<Env, 'RUN_LOG'>
	userId: string
	id: string
	payload: DynamicCallableWorkflowPayload
	bindingName?: WorkflowBindingName
	status: string | null
	now?: string
	lastError?: string | null
	completedAt?: string | null
	createdAt?: string | null
}) {
	const env = input.env as Env
	const existing = await getWorkflowProjection({
		env,
		userId: input.userId,
		id: input.id,
	})
	// Terminal stickiness: a later queued/running/creating write must not
	// regress cancelled/complete/errored/terminated projections.
	if (
		isTerminalWorkflowStatus(existing?.status) &&
		input.status != null &&
		!isTerminalWorkflowStatus(input.status)
	) {
		return
	}
	const projection = buildWorkflowProjectionUpsert({
		id: input.id,
		payload: input.payload,
		bindingName: input.bindingName,
		status: input.status,
		now: input.now,
		lastError: input.lastError,
		completedAt: input.completedAt,
		createdAt: input.createdAt ?? existing?.createdAt ?? null,
	})
	await upsertWorkflowProjection({
		env,
		userId: input.userId,
		projection,
	})
}

async function updateWorkflowRunStatus(input: {
	env: Pick<Env, 'RUN_LOG'>
	id: string
	payload: DynamicCallableWorkflowPayload
	bindingName?: WorkflowBindingName
	status: string
	lastError?: string | null
	completedAt?: string | null
}) {
	await projectWorkflowRun({
		env: input.env,
		userId: input.payload.userId,
		id: input.id,
		payload: input.payload,
		bindingName: input.bindingName,
		status: input.status,
		lastError: input.lastError,
		completedAt: input.completedAt,
	})
}

function assertWorkflowCreateBodyShape(body: PackageWorkflowCreateInput): {
	code: string | null
	exportName: string | null
} {
	const record = body as PackageWorkflowCreateInput & Record<string, unknown>
	const code =
		typeof record.code === 'string' && record.code.trim() ? record.code : null
	const exportName =
		typeof record.exportName === 'string' && record.exportName.trim()
			? record.exportName
			: null
	if ((code ? 1 : 0) + (exportName ? 1 : 0) !== 1) {
		throw new Error(
			'workflows.create requires exactly one of exportName or code.',
		)
	}
	return { code, exportName }
}

async function resolveWorkflowPayload(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	body: PackageWorkflowCreateInput
}): Promise<DynamicCallableWorkflowPayload> {
	const body = input.body as PackageWorkflowCreateInput &
		Record<string, unknown>
	const { code, exportName } = assertWorkflowCreateBodyShape(input.body)
	if (code) {
		return createInlineWorkflowPayload({
			userId: input.userId,
			packageContext: input.packageContext,
			workflowName: input.body.workflowName,
			code,
			idempotencyKey: input.body.idempotencyKey,
			runAt: input.body.runAt,
			params: input.body.params,
		})
	}
	const packageIdOrKodyId =
		(typeof body.packageId === 'string' ? body.packageId.trim() : '') ||
		input.packageContext?.packageId?.trim()
	if (!packageIdOrKodyId) {
		throw new Error(
			'workflows.create requires packageId when exportName is used outside package runtime context.',
		)
	}
	const savedPackage =
		(await getSavedPackageById(input.env.APP_DB, {
			userId: input.userId,
			packageId: packageIdOrKodyId,
		})) ??
		(await getSavedPackageByKodyId(input.env.APP_DB, {
			userId: input.userId,
			kodyId: packageIdOrKodyId,
		}))
	if (!savedPackage) {
		throw new Error(
			`Package "${packageIdOrKodyId}" was not found or is not owned by the current user.`,
		)
	}
	return createDynamicPackageWorkflowPayload({
		userId: input.userId,
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		sourceId: savedPackage.sourceId,
		workflowName: input.body.workflowName,
		exportName: exportName ?? '',
		idempotencyKey: input.body.idempotencyKey,
		runAt: input.body.runAt,
		params: input.body.params,
	})
}

type CreateDynamicCallableWorkflowInput = {
	env: Pick<Env, 'APP_DB' | 'RUN_LOG'> & {
		BUNDLE_ARTIFACTS_KV?: KVNamespace
		TEMPORAL_GATEWAY_URL?: string
		TEMPORAL_GATEWAY_SIGNING_KEYS?: string
	}
	userId: string
	userEmail?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId?: string | null
	} | null
	body: PackageWorkflowCreateInput
}

async function assertWorkflowConcurrency(input: {
	db: D1Database
	userId: string
	userEmail?: string | null
	current: number
	backend: 'temporal'
}) {
	try {
		await assertWithinEntitlement({
			db: input.db,
			userId: input.userId,
			email: input.userEmail,
			resource: 'concurrent_workflows',
			getCurrent: async () => input.current,
		})
		await recordTemporalWorkflowConcurrency({
			userId: input.userId,
			backend: input.backend,
			current: input.current,
			outcome: 'allowed',
		})
	} catch (error) {
		await recordTemporalWorkflowConcurrency({
			userId: input.userId,
			backend: input.backend,
			current: input.current,
			outcome: isEntitlementLimitError(error) ? 'throttled' : 'failed',
			limit: isEntitlementLimitError(error) ? error.details.limit : null,
		})
		throw error
	}
}

async function createTemporalDynamicPackageWorkflow(
	input: CreateDynamicCallableWorkflowInput,
): Promise<PackageWorkflowCreateResult> {
	const env = input.env as Env
	const artifactsKv = input.env.BUNDLE_ARTIFACTS_KV
	if (!artifactsKv) {
		throw new Error('Missing BUNDLE_ARTIFACTS_KV binding.')
	}
	assertWorkflowCreateBodyShape(input.body)
	const idempotencyKeyInput =
		typeof input.body.idempotencyKey === 'string'
			? input.body.idempotencyKey.trim()
			: ''
	if (idempotencyKeyInput) {
		const existingRun = await findWorkflowRunByIdempotencyKey({
			env,
			userId: input.userId,
			idempotencyKey: idempotencyKeyInput,
		})
		if (existingRun) return createWorkflowCreateResultFromRow(existingRun)
	}
	const payload = await resolveWorkflowPayload(input)
	const id = await createDynamicCallableWorkflowInstanceId(payload, {
		includeRunAt: !idempotencyKeyInput,
	})
	const reservationProjection = buildWorkflowProjectionUpsert({
		id,
		payload,
		bindingName: temporalDynamicPackageWorkflowsBindingName,
		status: creatingWorkflowProjectionStatus,
	})
	const reservation = await reserveWorkflowProjectionSlot({
		env,
		userId: input.userId,
		projection: reservationProjection,
	})
	if (!reservation.reserved) {
		return createWorkflowCreateResultFromRow(
			mapWorkflowProjectionToInspection(reservation.projection, input.userId),
		)
	}
	const releaseCreatingReservation = async () => {
		await deleteWorkflowProjectionIfCreating({
			env,
			userId: input.userId,
			id,
		})
	}
	try {
		await assertWorkflowConcurrency({
			db: input.env.APP_DB,
			userId: payload.userId,
			userEmail: input.userEmail,
			current: reservation.countBeforeReservation,
			backend: 'temporal',
		})
		const artifacts = await storeTemporalWorkflowArtifacts({
			kv: artifactsKv,
			payload,
		})
		const workflowId = await buildPackageWorkflowId(input.userId, id)
		await startDynamicPackageWorkflow({
			env: input.env,
			workflowId,
			request: {
				workflowId,
				userHash: artifacts.ownerHash,
				workflowRunId: id,
				sourceRef: artifacts.sourceRef,
				requestedRunAt: payload.runAt,
				idempotencyKey: (await sha256Base64Url(payload.idempotencyKey)).slice(
					0,
					43,
				),
				callerContextRef: artifacts.callerContextRef,
			},
		})
	} catch (error) {
		await releaseCreatingReservation()
		throw error
	}
	const status = Date.parse(payload.runAt) > Date.now() ? 'waiting' : 'queued'
	await projectWorkflowRun({
		env,
		userId: input.userId,
		id,
		payload,
		bindingName: temporalDynamicPackageWorkflowsBindingName,
		status,
		createdAt: reservation.projection.createdAt,
	})
	return createWorkflowCreateResult({ summary: { id, status }, payload })
}

export async function createDynamicCallableWorkflow(
	input: CreateDynamicCallableWorkflowInput,
): Promise<PackageWorkflowCreateResult> {
	assertWorkflowCreateBodyShape(input.body)
	const idempotencyKey = input.body.idempotencyKey?.trim()
	if (idempotencyKey) {
		const existing = await findWorkflowRunByIdempotencyKey({
			env: input.env,
			userId: input.userId,
			idempotencyKey,
		})
		if (existing) return createWorkflowCreateResultFromRow(existing)
	}
	return await createTemporalDynamicPackageWorkflow(input)
}

export type CancelWorkflowRunResult =
	| { outcome: 'not_found' }
	| { outcome: 'already_terminal'; run: WorkflowRunInspection }
	| { outcome: 'cancelled'; run: WorkflowRunInspection }

type WorkflowBackendEnv = Pick<Env, 'RUN_LOG'> & {
	TEMPORAL_GATEWAY_URL?: string
	TEMPORAL_GATEWAY_SIGNING_KEYS?: string
}

async function projectCancelledWorkflowRun(input: {
	env: Env
	userId: string
	row: WorkflowRunInspection
}): Promise<CancelWorkflowRunResult> {
	const beforeCancel = await getWorkflowProjection({
		env: input.env,
		userId: input.userId,
		id: input.row.id,
	})
	if (!beforeCancel) {
		throw new Error(
			`Workflow run "${input.row.id}" disappeared while cancelling for the current user.`,
		)
	}
	const beforeCancelRun = mapWorkflowProjectionToInspection(
		beforeCancel,
		input.userId,
	)
	if (
		beforeCancelRun.status !== null &&
		terminalWorkflowStatuses.has(beforeCancelRun.status)
	) {
		return { outcome: 'already_terminal', run: beforeCancelRun }
	}
	const now = new Date().toISOString()
	const payload = payloadFromWorkflowInspection(beforeCancelRun)
	await projectWorkflowRun({
		env: input.env,
		userId: input.userId,
		id: input.row.id,
		payload,
		bindingName: beforeCancelRun.bindingName,
		status: 'cancelled',
		now,
		completedAt: beforeCancelRun.completedAt ?? now,
		createdAt: beforeCancelRun.createdAt,
	})
	const projected = await getWorkflowProjection({
		env: input.env,
		userId: input.userId,
		id: input.row.id,
	})
	if (!projected) {
		throw new Error(
			`Workflow run "${input.row.id}" disappeared while cancelling for the current user.`,
		)
	}
	const projectedRun = mapWorkflowProjectionToInspection(
		projected,
		input.userId,
	)
	if (projectedRun.status === 'cancelled') {
		return { outcome: 'cancelled', run: projectedRun }
	}
	if (
		projectedRun.status !== null &&
		terminalWorkflowStatuses.has(projectedRun.status)
	) {
		return { outcome: 'already_terminal', run: projectedRun }
	}
	return { outcome: 'cancelled', run: { ...projectedRun, status: 'cancelled' } }
}

export async function cancelWorkflowRunForUser(input: {
	env: WorkflowBackendEnv
	userId: string
	workflowRunId: string
}): Promise<CancelWorkflowRunResult> {
	const env = input.env as Env
	const workflowRunId = normalizeNonEmptyString(
		input.workflowRunId,
		'workflowRunId',
	)
	// USER-ISOLATION BOUNDARY: never touch the workflow binding before this
	// ownership check passes. RunLog is keyed by userId.
	const owned = await getWorkflowRunForUser({
		env,
		userId: input.userId,
		id: workflowRunId,
	})
	if (!owned) {
		return { outcome: 'not_found' }
	}
	const row = owned
	if (row.status !== null && terminalWorkflowStatuses.has(row.status)) {
		return { outcome: 'already_terminal', run: row }
	}
	const workflowId = await buildPackageWorkflowId(input.userId, row.id)
	try {
		await cancelTemporalWorkflow({
			env: input.env,
			workflowId,
			reason: 'user-request',
		})
	} catch (cancelError) {
		try {
			const description = await describeTemporalWorkflow({
				env: input.env,
				workflowId,
			})
			const status = mapTemporalWorkflowStatus(description.status)
			if (terminalWorkflowStatuses.has(status)) {
				const payload = payloadFromWorkflowInspection(row)
				const completedAt = description.closedAt ?? new Date().toISOString()
				await projectWorkflowRun({
					env,
					userId: input.userId,
					id: row.id,
					payload,
					bindingName: row.bindingName,
					status,
					now: completedAt,
					completedAt,
					createdAt: row.createdAt,
				})
				return {
					outcome: 'already_terminal',
					run: { ...row, status, updatedAt: completedAt, completedAt },
				}
			}
		} catch (describeError) {
			if (
				cancelError instanceof TemporalGatewayError &&
				cancelError.status === 404 &&
				describeError instanceof TemporalGatewayError &&
				describeError.status === 404
			) {
				return await projectCancelledWorkflowRun({
					env,
					userId: input.userId,
					row,
				})
			}
		}
		throw cancelError
	}
	return await projectCancelledWorkflowRun({
		env,
		userId: input.userId,
		row,
	})
}

export async function listWorkflowRunsForUser(input: {
	env: WorkflowBackendEnv
	userId: string
	limit?: number
}): Promise<Array<WorkflowRunInspection>> {
	const env = input.env as Env
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
	const listed = await listWorkflowProjections({
		env,
		userId: input.userId,
		limit,
		bindingName: null,
	})
	const rows = listed.projections.map((projection) =>
		mapWorkflowProjectionToInspection(projection, input.userId),
	)
	const now = new Date()
	await Promise.all(
		rows.map(async (row) => {
			if (!row.status || !activeWorkflowStatuses.has(row.status)) return
			const updatedAtMs = new Date(row.updatedAt).getTime()
			if (
				Number.isFinite(updatedAtMs) &&
				now.getTime() - updatedAtMs < workflowStatusRefreshTtlMs
			) {
				return
			}
			const workflowId = await buildPackageWorkflowId(input.userId, row.id)
			let description
			try {
				description = await describeTemporalWorkflow({
					env: input.env,
					workflowId,
				})
			} catch (error) {
				if (error instanceof TemporalGatewayError && error.status === 404)
					return
				throw error
			}
			const mapped = mapTemporalWorkflowStatus(description.status)
			const status =
				mapped === 'running' &&
				row.status === 'waiting' &&
				Date.parse(row.runAt) > now.getTime()
					? 'waiting'
					: mapped
			if (status === row.status) return
			row.status = status
			row.updatedAt = now.toISOString()
			if (terminalWorkflowStatuses.has(status) && !row.completedAt) {
				row.completedAt = description.closedAt ?? row.updatedAt
			}
			const payload = payloadFromWorkflowInspection(row)
			await projectWorkflowRun({
				env,
				userId: input.userId,
				id: row.id,
				payload,
				bindingName: row.bindingName,
				status,
				now: row.updatedAt,
				completedAt: row.completedAt,
				createdAt: row.createdAt,
			})
		}),
	)
	return rows
}

type DynamicWorkflowExecutionInput = {
	env: Env
	payload: DynamicCallableWorkflowPayload
	instanceId: string
	signal?: AbortSignal
	waitUntil?: (promise: Promise<unknown>) => void
	invocationIdempotencyKey?: string
}

/**
 * Execute one already-resolved workflow payload inside Kody's Cloudflare
 * sandbox boundary. Temporal Activities call this function through the signed
 * Activity gateway; result and log content remain in Cloudflare storage.
 */
export async function executeDynamicWorkflowPayload(
	input: DynamicWorkflowExecutionInput,
): Promise<{ result: JsonValue; resultRef: string }> {
	input.signal?.throwIfAborted()
	const runHandle = beginRunRecord({
		env: input.env,
		userId: input.payload.userId,
		context: {
			surface: 'workflow',
			name: input.payload.workflowName,
			...(input.payload.sourceType === 'package'
				? {
						packageId: input.payload.packageId,
						kodyId: input.payload.kodyId,
						sourceId: input.payload.sourceId,
					}
				: { storageId: null }),
			workflowId: input.instanceId,
			idempotencyKey: input.payload.idempotencyKey,
			metadata: {
				sourceType: input.payload.sourceType,
				...(input.payload.sourceType === 'package'
					? { exportName: input.payload.exportName }
					: {}),
			},
		},
		waitUntil: input.waitUntil,
	})
	let logs: Array<string> | undefined
	try {
		let result: JsonValue
		if (input.payload.sourceType === 'package') {
			const response = await invokePackageExport({
				env: input.env,
				baseUrl: getAppBaseUrl({ env: input.env }),
				token: {
					tokenId: packageWorkflowTokenId,
					userId: input.payload.userId,
					packageId: input.payload.packageId,
					exportNames: [input.payload.exportName],
				},
				request: {
					packageIdOrKodyId: input.payload.packageId,
					exportName: input.payload.exportName,
					params: input.payload.params,
					idempotencyKey: input.invocationIdempotencyKey ?? null,
					source: packageWorkflowInvocationSource,
					topic: input.payload.workflowName,
				},
				ephemeral: !input.invocationIdempotencyKey,
				executorTimeoutMs: workflowExecutorTimeoutMs,
				signal: input.signal,
			})
			if (response.status < 200 || response.status >= 300) {
				throwWorkflowInvocationFailure(response)
			}
			result = {
				status: response.status,
				body: toJsonSafeValue(response.body),
			}
		} else {
			if (input.payload.packageContext === undefined) {
				throw new Error(
					'Inline workflow payload is missing required package security context.',
				)
			}
			const { runModuleWithRegistry } =
				await import('#mcp/run-kody-registry.ts')
			const callerContext = createMcpCallerContext({
				baseUrl: getAppBaseUrl({ env: input.env }),
				executionOrigin: 'background',
				user: await resolveBackgroundMcpUser(
					input.env.APP_DB,
					input.payload.userId,
				),
				storageContext: input.payload.packageContext
					? {
							sessionId: null,
							appId: input.payload.packageContext.packageId,
							packageId: input.payload.packageContext.packageId,
							storageId: null,
						}
					: null,
			})
			const waitUntil = input.waitUntil ?? (() => undefined)
			const packageInvokeTools = input.payload.packageContext
				? createPackageRuntimeInvokeTools({
						env: input.env,
						baseUrl: callerContext.baseUrl,
						callerContext,
						packageContext: input.payload.packageContext,
						waitUntil,
					})
				: createExecutePackageInvokeTools({
						env: input.env,
						baseUrl: callerContext.baseUrl,
						callerContext,
						waitUntil,
					})
			const execution = await runModuleWithRegistry(
				input.env,
				callerContext,
				input.payload.code,
				input.payload.params,
				{
					packageContext: input.payload.packageContext,
					packageInvokeTools,
					executorTimeoutMs: workflowExecutorTimeoutMs,
					signal: input.signal,
					runSurface: 'workflow',
				},
			)
			logs = execution.logs
			if (execution.error) {
				if (isTransientDurableObjectResetError(execution.error)) {
					throw new Error(getErrorMessage(execution.error))
				}
				throw new UserCodeError(getErrorMessage(execution.error))
			}
			result = toJsonSafeValue(execution.result) as JsonValue
		}
		await finishRunRecord({
			env: input.env,
			handle: runHandle,
			status: 'success',
			logs,
			result,
		})
		return { result, resultRef: `workflow:${input.instanceId}` }
	} catch (error) {
		await finishRunRecord({
			env: input.env,
			handle: runHandle,
			status: 'error',
			logs,
			error,
		})
		throw error
	}
}

async function recordDynamicWorkflowUsage(input: {
	env: Env
	payload: DynamicCallableWorkflowPayload
	instanceId: string
	startedAtMs: number
	outcome: 'success' | 'error'
}) {
	if (!input.payload.userId) return
	await recordUsage(input.env, {
		userId: input.payload.userId,
		eventType: 'workflow_run',
		entityId: input.instanceId,
		durationMs: Date.now() - input.startedAtMs,
		outcome: input.outcome,
	})
}

/** Signed Activity-gateway implementation for Phase 4. */
export async function executeTemporalDynamicPackageActivity(input: {
	env: Env
	request: ExecuteDynamicPackageRequest
	signal?: AbortSignal
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<ExecuteDynamicPackageResult> {
	const payload = await loadTemporalWorkflowPayload({
		kv: input.env.BUNDLE_ARTIFACTS_KV,
		userHash: input.request.userHash,
		sourceRef: input.request.sourceRef,
		callerContextRef: input.request.callerContextRef,
	})
	const expectedWorkflowId = await buildPackageWorkflowId(
		payload.userId,
		input.request.workflowRunId,
	)
	if (expectedWorkflowId !== input.request.workflowId) {
		throw new UserCodeError('temporal_workflow_identity_mismatch')
	}
	const projection = await getWorkflowProjection({
		env: input.env,
		userId: payload.userId,
		id: input.request.workflowRunId,
	})
	if (
		!projection ||
		projection.bindingName !== temporalDynamicPackageWorkflowsBindingName
	) {
		throw new UserCodeError('temporal_workflow_projection_not_found')
	}
	if (projection.status === 'complete') {
		return {
			status: 'succeeded',
			finishedAt: projection.completedAt ?? projection.updatedAt,
			resultRef: `workflow:${input.request.workflowRunId}`,
		}
	}
	if (projection.status === 'cancelled' || projection.status === 'terminated') {
		throw new UserCodeError('temporal_workflow_cancelled')
	}
	const startedAtMs = Date.now()
	await updateWorkflowRunStatus({
		env: input.env,
		id: input.request.workflowRunId,
		payload,
		bindingName: temporalDynamicPackageWorkflowsBindingName,
		status: 'running',
	})
	try {
		const execution = await executeDynamicWorkflowPayload({
			env: input.env,
			payload,
			instanceId: input.request.workflowRunId,
			signal: input.signal,
			waitUntil: input.waitUntil,
			invocationIdempotencyKey: input.request.invocationIdempotencyKey,
		})
		const finishedAt = new Date().toISOString()
		await updateWorkflowRunStatus({
			env: input.env,
			id: input.request.workflowRunId,
			payload,
			bindingName: temporalDynamicPackageWorkflowsBindingName,
			status: 'complete',
			completedAt: finishedAt,
		})
		await recordDynamicWorkflowUsage({
			env: input.env,
			payload,
			instanceId: input.request.workflowRunId,
			startedAtMs,
			outcome: 'success',
		})
		return {
			status: 'succeeded',
			finishedAt,
			resultRef: execution.resultRef,
		}
	} catch (error) {
		const cancelled = input.signal?.aborted === true
		await updateWorkflowRunStatus({
			env: input.env,
			id: input.request.workflowRunId,
			payload,
			bindingName: temporalDynamicPackageWorkflowsBindingName,
			status: cancelled ? 'cancelled' : 'errored',
			lastError: getErrorMessage(error),
			completedAt: new Date().toISOString(),
		})
		if (
			!cancelled &&
			(isUserCodeError(error) || (input.request.activityAttempt ?? 1) >= 5)
		) {
			await recordDynamicWorkflowUsage({
				env: input.env,
				payload,
				instanceId: input.request.workflowRunId,
				startedAtMs,
				outcome: 'error',
			})
		}
		throw error
	}
}
