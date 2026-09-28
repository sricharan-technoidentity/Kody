import {
	type ClaimJobRequest,
	type ExecuteDynamicPackageRequest,
	type ExecuteJobPackageRequest,
	type FinalizeJobRequest,
	type ResolvePackageRequest,
	type ResolveJobExecutionPlanRequest,
	type StripePlanRefreshActivityInput,
	type TemporalActivityPath,
	type TemporalActivityResponse,
} from '@kody-internal/shared/temporal/contracts.ts'
import {
	createTemporalSignature,
	parseTemporalSigningKeys,
} from '@kody-internal/shared/temporal/signing.ts'
import {
	activityInfo,
	cancellationSignal,
	heartbeat,
} from '@temporalio/activity'
import { ApplicationFailure } from '@temporalio/common'

const resolvePath = '/__temporal/v1/packages/resolve'
const maxResponseBytes = 64 * 1024

function requiredEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(`Missing ${name}.`)
	return value
}

async function readBoundedResponse(response: Response) {
	const contentLength = Number(response.headers.get('content-length'))
	if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
		throw ApplicationFailure.nonRetryable(
			'Cloudflare Activity Gateway response is too large.',
			'CloudflareActivityPayloadError',
		)
	}
	const text = await response.text()
	if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
		throw ApplicationFailure.nonRetryable(
			'Cloudflare Activity Gateway response is too large.',
			'CloudflareActivityPayloadError',
		)
	}
	if (!response.ok) {
		const message = `Cloudflare Activity Gateway returned ${String(response.status)}.`
		if ([400, 401, 403, 404, 409, 422].includes(response.status)) {
			throw ApplicationFailure.nonRetryable(
				message,
				'CloudflareActivityPermanentError',
			)
		}
		throw new Error(message)
	}
	return JSON.parse(text) as TemporalActivityResponse
}

async function activityRequest(input: {
	path: TemporalActivityPath
	body: Record<string, unknown>
	idempotencyKey: string
	heartbeatWhileRunning?: boolean
	requestTimeoutMs?: number
}) {
	const baseUrl = requiredEnv('CLOUDFLARE_ACTIVITY_GATEWAY_URL')
	const currentKey = parseTemporalSigningKeys(
		requiredEnv('CLOUDFLARE_ACTIVITY_SIGNING_KEYS'),
	).at(0)
	if (!currentKey) throw new Error('Missing current Cloudflare signing key.')
	const workflowExecution = activityInfo().workflowExecution
	if (!workflowExecution) {
		throw new Error('Temporal gateway calls must run inside a Workflow.')
	}
	const body = JSON.stringify({
		...input.body,
		temporalRunId: workflowExecution.runId,
	})
	const signatureHeaders = await createTemporalSignature({
		key: currentKey,
		method: 'POST',
		pathname: input.path,
		body,
		idempotencyKey: input.idempotencyKey,
	})
	const timeout = AbortSignal.timeout(
		input.requestTimeoutMs ?? (input.heartbeatWhileRunning ? 170_000 : 25_000),
	)
	const signal = AbortSignal.any([timeout, cancellationSignal()])
	const heartbeatTimer = input.heartbeatWhileRunning
		? setInterval(() => heartbeat('cloudflare-package-execution'), 5_000)
		: undefined
	try {
		if (input.heartbeatWhileRunning) heartbeat('dispatching')
		const response = await fetch(new URL(input.path, baseUrl), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...signatureHeaders,
			},
			body,
			signal,
		})
		return await readBoundedResponse(response)
	} finally {
		if (heartbeatTimer) clearInterval(heartbeatTimer)
	}
}

export async function resolvePackageReference(
	input: ResolvePackageRequest,
): Promise<TemporalActivityResponse> {
	return await activityRequest({
		path: resolvePath,
		body: input,
		idempotencyKey: `resolve:${input.workflowId}:${input.sourceRef}`,
	})
}

export async function claimJobOccurrence(input: ClaimJobRequest) {
	return await activityRequest({
		path: '/__temporal/v1/jobs/claim',
		body: input,
		idempotencyKey: `job:${input.runRef}:claim`,
	})
}

export async function resolveExecutionPlan(
	input: ResolveJobExecutionPlanRequest,
) {
	return await activityRequest({
		path: resolvePath,
		body: input,
		idempotencyKey: `job:${input.claimRef}:resolve`,
	})
}

export async function executePackageSandbox(input: ExecuteJobPackageRequest) {
	return await activityRequest({
		path: '/__temporal/v1/packages/execute',
		body: input,
		idempotencyKey: `job:${input.claimRef}:execute`,
		heartbeatWhileRunning: true,
	})
}

export async function executeDynamicPackageSandbox(
	input: ExecuteDynamicPackageRequest,
) {
	return await activityRequest({
		path: '/__temporal/v1/packages/execute',
		body: { ...input, activityAttempt: activityInfo().attempt },
		idempotencyKey: `workflow:${input.workflowRunId}:execute`,
		heartbeatWhileRunning: true,
		requestTimeoutMs: 290_000,
	})
}

export async function finalizeJobOccurrence(input: FinalizeJobRequest) {
	return await activityRequest({
		path: '/__temporal/v1/jobs/finalize',
		body: input,
		idempotencyKey: `job:${input.claimRef}:finalize:${input.status}`,
	})
}

export async function refreshStripePlan(input: StripePlanRefreshActivityInput) {
	const runId = activityInfo().workflowExecution?.runId
	if (!runId) throw new Error('Stripe plan refresh requires a Workflow run.')
	return await activityRequest({
		path: '/__temporal/v1/coordinators/stripe-plan-refresh',
		body: input,
		idempotencyKey: `stripe-plan-refresh:${runId}`,
	})
}
