import {
	type DynamicPackageWorkflowInput,
	type ResolvePackageRequest,
	type StripePlanRefreshWorkflowInput,
	type TemporalGatewayCancelRequest,
	type TemporalGatewayReconciliationResponse,
	type TemporalGatewaySignalWithStartRequest,
	type TemporalGatewayStartRequest,
	type TemporalGatewayWorkflowDescription,
} from '@kody-internal/shared/temporal/contracts.ts'
import {
	createTemporalSignature,
	parseTemporalSigningKeys,
} from '@kody-internal/shared/temporal/signing.ts'

const startPath = '/v1/workflows/start'
const cancelPath = '/v1/workflows/cancel'
const reconciliationSamplePath = '/v1/workflows/reconciliation-sample'
const signalWithStartPath = '/v1/workflows/signal-with-start'

export type TemporalGatewayClientEnv = {
	TEMPORAL_GATEWAY_URL?: string
	TEMPORAL_GATEWAY_SIGNING_KEYS?: string
}

export class TemporalGatewayError extends Error {
	readonly status: number

	constructor(message: string, status: number) {
		super(message)
		this.name = 'TemporalGatewayError'
		this.status = status
	}
}

function required(value: string | undefined, name: string) {
	const trimmed = value?.trim()
	if (!trimmed) throw new Error(`Missing ${name}.`)
	return trimmed
}

async function temporalGatewayRequest<T>(input: {
	env: TemporalGatewayClientEnv
	pathname: string
	method: 'GET' | 'POST'
	idempotencyKey: string
	body?: unknown
	fetch?: typeof fetch
}) {
	const baseUrl = required(
		input.env.TEMPORAL_GATEWAY_URL,
		'TEMPORAL_GATEWAY_URL',
	)
	const currentKey = parseTemporalSigningKeys(
		required(
			input.env.TEMPORAL_GATEWAY_SIGNING_KEYS,
			'TEMPORAL_GATEWAY_SIGNING_KEYS',
		),
	).at(0)
	if (!currentKey) throw new Error('Missing current Temporal gateway key.')
	const body = input.body === undefined ? '' : JSON.stringify(input.body)
	const signatureHeaders = await createTemporalSignature({
		key: currentKey,
		method: input.method,
		pathname: input.pathname,
		body,
		idempotencyKey: input.idempotencyKey,
	})
	const response = await (input.fetch ?? fetch)(
		new URL(input.pathname, baseUrl),
		{
			method: input.method,
			headers: {
				...(input.body === undefined
					? {}
					: { 'content-type': 'application/json' }),
				...signatureHeaders,
			},
			...(input.body === undefined ? {} : { body }),
			signal: AbortSignal.timeout(10_000),
		},
	)
	if (!response.ok) {
		throw new TemporalGatewayError(
			`Temporal gateway returned ${String(response.status)}.`,
			response.status,
		)
	}
	return (await response.json()) as T
}

async function startTemporalWorkflow(input: {
	env: TemporalGatewayClientEnv
	request: TemporalGatewayStartRequest
	fetch?: typeof fetch
}) {
	return await temporalGatewayRequest<{
		workflowId: string
		firstExecutionRunId: string
	}>({
		env: input.env,
		pathname: startPath,
		method: 'POST',
		idempotencyKey: `start:${input.request.workflowId}`,
		body: input.request,
		fetch: input.fetch,
	})
}

export async function startTemporalFoundationWorkflow(input: {
	env: TemporalGatewayClientEnv
	workflowId: string
	taskQueue?: string
	request: ResolvePackageRequest
	fetch?: typeof fetch
}) {
	return await startTemporalWorkflow({
		env: input.env,
		request: {
			workflowType: 'temporalFoundationWorkflow',
			workflowId: input.workflowId,
			taskQueue: input.taskQueue ?? 'kody-foundation',
			input: input.request,
		},
		fetch: input.fetch,
	})
}

export async function startDynamicPackageWorkflow(input: {
	env: TemporalGatewayClientEnv
	workflowId: string
	taskQueue?: string
	request: DynamicPackageWorkflowInput
	fetch?: typeof fetch
}) {
	return await startTemporalWorkflow({
		env: input.env,
		request: {
			workflowType: 'dynamicPackageWorkflow',
			workflowId: input.workflowId,
			taskQueue: input.taskQueue ?? 'kody-foundation',
			input: input.request,
		},
		fetch: input.fetch,
	})
}

export async function signalWithStartStripePlanRefreshWorkflow(input: {
	env: TemporalGatewayClientEnv
	workflowId: string
	taskQueue?: string
	request: StripePlanRefreshWorkflowInput
	fetch?: typeof fetch
}) {
	const request: TemporalGatewaySignalWithStartRequest = {
		workflowType: 'stripePlanRefreshWorkflow',
		workflowId: input.workflowId,
		taskQueue: input.taskQueue ?? 'kody-foundation',
		input: input.request,
		signalName: 'rescheduleStripePlanRefresh',
		signalArgs: [input.request.refreshAt],
	}
	return await temporalGatewayRequest<{
		workflowId: string
		signaledRunId: string
	}>({
		env: input.env,
		pathname: signalWithStartPath,
		method: 'POST',
		idempotencyKey: `signal-with-start:${input.workflowId}:${request.signalName}:${input.request.refreshAt}`,
		body: request,
		fetch: input.fetch,
	})
}

export async function cancelTemporalWorkflow(input: {
	env: TemporalGatewayClientEnv
	workflowId: string
	reason: string
	fetch?: typeof fetch
}) {
	const request: TemporalGatewayCancelRequest = {
		workflowId: input.workflowId,
		reason: input.reason,
	}
	return await temporalGatewayRequest<{ workflowId: string; cancelled: true }>({
		env: input.env,
		pathname: cancelPath,
		method: 'POST',
		idempotencyKey: `cancel:${input.workflowId}:${input.reason}`,
		body: request,
		fetch: input.fetch,
	})
}

export async function describeTemporalWorkflow(input: {
	env: TemporalGatewayClientEnv
	workflowId: string
	fetch?: typeof fetch
}) {
	const pathname = `/v1/workflows/${encodeURIComponent(input.workflowId)}`
	return await temporalGatewayRequest<TemporalGatewayWorkflowDescription>({
		env: input.env,
		pathname,
		method: 'GET',
		idempotencyKey: `describe:${input.workflowId}`,
		fetch: input.fetch,
	})
}

export async function sampleTemporalDynamicPackageWorkflows(input: {
	env: TemporalGatewayClientEnv
	limit: number
	fetch?: typeof fetch
}) {
	const request = {
		workflowType: 'dynamicPackageWorkflow' as const,
		limit: input.limit,
	}
	return await temporalGatewayRequest<TemporalGatewayReconciliationResponse>({
		env: input.env,
		pathname: reconciliationSamplePath,
		method: 'POST',
		idempotencyKey: `reconciliation-sample:${request.workflowType}:${String(request.limit)}`,
		body: request,
		fetch: input.fetch,
	})
}
